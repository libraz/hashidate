"""The checkpoint table and the step counts it implies."""

import importlib
import os
import unittest


def load(model: str | None, speaker: str | None = None):
    wanted = {"HASHIDATE_TTS_MODEL": model, "HASHIDATE_TTS_SPEAKER": speaker}
    previous = {name: os.environ.get(name) for name in wanted}
    try:
        for name, value in wanted.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        import config

        return importlib.reload(config)
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


class ConfigTests(unittest.TestCase):
    def test_every_checkpoint_has_its_own_step_count(self):
        config = load(None)
        self.assertEqual(set(config.STEPS), set(config.CHECKPOINTS))

    def test_the_loaded_model_sets_the_default_steps(self):
        for model in ("small", "large", "mf"):
            with self.subTest(model=model):
                config = load(model)
                self.assertEqual(config.DEFAULT_STEPS, config.STEPS[model])
        self.assertEqual(load("mf").DEFAULT_STEPS, 4)

    def test_the_speaker_defaults_to_the_reference_latents(self):
        self.assertEqual(load(None).SPEAKER, "latents")

    def test_the_embedding_lives_in_the_voice_directory(self):
        config = load(None, "embedding")
        self.assertEqual(config.SPEAKER, "embedding")
        self.assertEqual(config.SPEAKER_EMBEDDING, config.VOICE / "voice.speaker.safetensors")

    def test_an_unknown_speaker_is_refused(self):
        with self.assertRaises(SystemExit):
            load(None, "clips")


if __name__ == "__main__":
    unittest.main()
