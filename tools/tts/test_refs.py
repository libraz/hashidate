"""Synthetic tests for the reference-latent staging boundary.

The production module imports torch and the speech model at import time. These
tests provide tiny stand-ins so failures exercise directory staging and
rollback without loading a model or reading a real recording.
"""

import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class FakeTensor:
    shape = (1, 2)
    dtype = object()

    def numpy(self):
        return self

    def to(self, _dtype):
        return self

    def unsqueeze(self, _axis):
        return self

    def cpu(self):
        return self


class FakeCodec:
    def __init__(self):
        self.fail_for: set[str] = set()

    def encode_waveform(self, waveform, **_kwargs):
        del waveform
        return FakeTensor()


class FakeRuntime:
    def __init__(self):
        self.codec = FakeCodec()


class FakeTorch(types.ModuleType):
    def __init__(self):
        super().__init__("torch")
        self.fail_save = False

    @staticmethod
    def from_numpy(_value):
        return FakeTensor()

    def save(self, _value, path):
        if self.fail_save:
            raise OSError("synthetic save failure")
        Path(path).write_bytes(b"latent")


def load_refs_module():
    fake_torch = FakeTorch()
    inference = types.ModuleType("irodori_tts.inference_runtime")

    class InferenceRuntime:
        @classmethod
        def from_key(cls, _key):
            return FakeRuntime()

    inference.InferenceRuntime = InferenceRuntime
    inference._load_audio = lambda _path: (FakeTensor(), 16_000)
    irodori = types.ModuleType("irodori_tts")
    irodori.inference_runtime = inference

    config = types.ModuleType("config")
    config.CLIPS = Path("/synthetic/clips")
    config.LATENTS = Path("/synthetic/latents")
    config.REF_NORMALIZE_DB = -16.0
    config.runtime_key = lambda: object()

    repair = types.ModuleType("repair")
    repair.clean_reference = lambda value, _sample_rate: value
    vet = types.ModuleType("vet")
    vet.describe = lambda _reports: ""
    vet.vet = lambda _clips: []

    modules = {
        "torch": fake_torch,
        "irodori_tts": irodori,
        "irodori_tts.inference_runtime": inference,
        "config": config,
        "repair": repair,
        "vet": vet,
    }
    original = {name: sys.modules.get(name) for name in modules}
    sys.modules.update(modules)
    source = Path(__file__).with_name("refs.py")
    spec = importlib.util.spec_from_file_location("hashidate_test_refs_module", source)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load refs.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def restore():
        for name, previous in original.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous

    return module, fake_torch, restore


REFS, TORCH, RESTORE = load_refs_module()


class ReferencePublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hashidate-refs-")
        root = Path(self.temp.name)
        self.clips = [root / "new.wav", root / "keep.wav"]
        for clip in self.clips:
            clip.write_bytes(b"synthetic recording")
        self.latents = root / "latents"
        self.latents.mkdir()
        (self.latents / "old.pt").write_bytes(b"old set")
        (self.latents / "keep.pt").write_bytes(b"old keep")
        REFS.LATENTS = self.latents
        TORCH.fail_save = False

    def tearDown(self):
        TORCH.fail_save = False
        self.temp.cleanup()

    def test_success_publishes_the_complete_current_set_and_drops_deleted_clips(self):
        REFS._encode_and_publish(self.clips, FakeRuntime())

        self.assertEqual(sorted(path.name for path in self.latents.iterdir()), ["keep.pt", "new.pt"])
        self.assertEqual((self.latents / "keep.pt").read_bytes(), b"latent")

    def test_encode_failure_keeps_the_previous_set(self):
        runtime = FakeRuntime()
        calls = 0

        def fail_encode(_waveform, **_kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                return FakeTensor()
            self.assertEqual(len(list(self.latents.parent.glob(".latents.stage-*/new.pt"))), 1)
            raise RuntimeError("synthetic encode failure")

        runtime.codec.encode_waveform = fail_encode
        with self.assertRaisesRegex(RuntimeError, "synthetic encode failure"):
            REFS._encode_and_publish(self.clips, runtime)

        self.assertEqual(calls, 2)
        self.assertEqual((self.latents / "old.pt").read_bytes(), b"old set")
        self.assertEqual((self.latents / "keep.pt").read_bytes(), b"old keep")
        self.assertEqual(sorted(path.name for path in self.latents.iterdir()), ["keep.pt", "old.pt"])
        self.assertEqual(list(self.latents.parent.glob(".latents.stage-*")), [])

    def test_save_failure_keeps_the_previous_set(self):
        save = TORCH.save

        def fail_second_save(value, path):
            if path.name == "keep.pt":
                self.assertEqual((path.parent / "new.pt").read_bytes(), b"latent")
                raise OSError("synthetic save failure")
            save(value, path)

        with patch.object(TORCH, "save", side_effect=fail_second_save):
            with self.assertRaisesRegex(OSError, "synthetic save failure"):
                REFS._encode_and_publish(self.clips, FakeRuntime())

        self.assertEqual((self.latents / "old.pt").read_bytes(), b"old set")
        self.assertEqual((self.latents / "keep.pt").read_bytes(), b"old keep")
        self.assertEqual(list(self.latents.parent.glob(".latents.stage-*")), [])

    def test_publish_failure_restores_the_previous_set(self):
        real_replace = REFS.os.replace
        calls = 0

        def fail_new_move(source, destination):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("synthetic publish failure")
            return real_replace(source, destination)

        with patch.object(REFS.os, "replace", side_effect=fail_new_move):
            with self.assertRaisesRegex(OSError, "synthetic publish failure"):
                REFS._encode_and_publish(self.clips, FakeRuntime())

        self.assertEqual((self.latents / "old.pt").read_bytes(), b"old set")
        self.assertEqual((self.latents / "keep.pt").read_bytes(), b"old keep")
        self.assertEqual(sorted(path.name for path in self.latents.iterdir()), ["keep.pt", "old.pt"])
        self.assertEqual(list(self.latents.parent.glob(".latents.backup-*")), [])


def tearDownModule():
    RESTORE()


if __name__ == "__main__":
    unittest.main()
