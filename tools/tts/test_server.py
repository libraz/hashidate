"""Focused tests for the sidecar's process/socket boundary.

The production module imports the speech model and its native dependencies at
module load time. Extracting only the small filesystem/environment functions
keeps this stdlib-only test runnable on a fresh checkout, without importing or
initialising the model.
"""

import ast
import argparse
import contextlib
import io
import os
import socket
import stat
import tempfile
import threading
import types
import traceback
import unittest
from pathlib import Path


def load_boundary_functions() -> types.SimpleNamespace:
    source_path = Path(__file__).with_name("server.py")
    tree = ast.parse(source_path.read_text())
    wanted = {"_socket_parent", "clear_stale", "listen", "endpoint", "argument_parser"}
    functions = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in wanted
    ]
    namespace = {
        "__doc__": "",
        "argparse": argparse,
        "Path": Path,
        "errno": __import__("errno"),
        "os": os,
        "socket": socket,
        "stat": stat,
        "SystemExit": SystemExit,
        "SOCKET_DIR": Path("/default/.run"),
        "SOCKET_NAME": "speech.sock",
        "SOCKET_PATH_MAX": 100,
    }
    module = ast.Module(body=functions, type_ignores=[])
    exec(compile(module, str(source_path), "exec"), namespace)
    return types.SimpleNamespace(**{name: namespace[name] for name in wanted})


BOUNDARY = load_boundary_functions()


class StubHttpError(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code = status_code


def load_startup(latents_dir: Path, runtime, watermark) -> dict:
    """The startup and health functions, over stubs for the model and the mark."""
    source_path = Path(__file__).with_name("server.py")
    tree = ast.parse(source_path.read_text())
    wanted = {"_load_model", "health", "speak"}
    functions = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in wanted:
            node.decorator_list = []
            functions.append(node)
    namespace = {
        "__doc__": "",
        "LATENTS": latents_dir,
        "InferenceRuntime": types.SimpleNamespace(from_key=lambda key: runtime),
        "runtime_key": lambda: None,
        "watermark": watermark,
        "SamplingRequest": lambda **kwargs: kwargs,
        "SpeakRequest": object,
        "Response": object,
        "HTTPException": StubHttpError,
        "traceback": traceback,
        "DEFAULT_STEPS": 4,
        "DEFAULT_SEED": 1,
        "DEVICE": "mps",
        "MODEL": "small",
        "MAX_SECONDS": 30.0,
        "_runtime": None,
        "_latents": [],
        "_startup_error": None,
        "stopped": [],
    }
    namespace["_stop_serving"] = lambda: namespace["stopped"].append(True)
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(source_path), "exec"), namespace)
    return namespace


class ServerBoundaryTests(unittest.TestCase):
    def test_bundled_parser_rejects_tcp_port(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                BOUNDARY.argument_parser().parse_args(["--port", "8770"])

    def test_port_environment_values_cannot_select_tcp(self):
        previous_socket = os.environ.get("HASHIDATE_TTS_SOCKET")
        previous_port = os.environ.get("HASHIDATE_TTS_PORT")
        previous_generic_port = os.environ.get("PORT")
        try:
            os.environ.pop("HASHIDATE_TTS_SOCKET", None)
            os.environ["HASHIDATE_TTS_PORT"] = "8770"
            os.environ["PORT"] = "8771"
            self.assertEqual(
                BOUNDARY.endpoint(argparse.Namespace(uds=None)),
                Path("/default/.run/speech.sock"),
            )
        finally:
            if previous_socket is None:
                os.environ.pop("HASHIDATE_TTS_SOCKET", None)
            else:
                os.environ["HASHIDATE_TTS_SOCKET"] = previous_socket
            if previous_port is None:
                os.environ.pop("HASHIDATE_TTS_PORT", None)
            else:
                os.environ["HASHIDATE_TTS_PORT"] = previous_port
            if previous_generic_port is None:
                os.environ.pop("PORT", None)
            else:
                os.environ["PORT"] = previous_generic_port

    def test_clear_stale_only_removes_an_actual_stale_socket(self):
        with tempfile.TemporaryDirectory(prefix="hashidate-tts-") as root:
            directory = Path(root)
            stale = directory / "stale.sock"
            stale_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            stale_socket.bind(str(stale))
            stale_socket.close()

            BOUNDARY.clear_stale(stale)

            self.assertFalse(stale.exists())

    def test_clear_stale_refuses_a_live_socket(self):
        with tempfile.TemporaryDirectory(prefix="hashidate-tts-") as root:
            path = Path(root) / "live.sock"
            live = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            live.bind(str(path))
            live.listen(1)
            try:
                with self.assertRaisesRegex(SystemExit, r"HASHIDATE_TTS_SOCKET.*live\.sock"):
                    BOUNDARY.clear_stale(path)
                self.assertTrue(path.exists())
            finally:
                live.close()
                path.unlink(missing_ok=True)

    def test_clear_stale_keeps_non_socket_nodes_and_names_the_path(self):
        with tempfile.TemporaryDirectory(prefix="hashidate-tts-") as root:
            directory = Path(root)
            regular = directory / "notes.txt"
            regular.write_text("keep me")
            child_directory = directory / "child"
            child_directory.mkdir()
            target = directory / "target.txt"
            target.write_text("target")
            link = directory / "link.txt"
            link.symlink_to(target)
            broken = directory / "broken.sock"
            broken.symlink_to(directory / "missing.sock")
            fifo = directory / "pipe"
            os.mkfifo(fifo)

            for path in (regular, child_directory, link, broken, fifo):
                with self.subTest(path=path):
                    with self.assertRaisesRegex(
                        SystemExit, rf"HASHIDATE_TTS_SOCKET.*{path}"
                    ):
                        BOUNDARY.clear_stale(path)
                    self.assertTrue(os.path.lexists(path))

    def test_listen_secures_only_directories_created_for_this_socket(self):
        with tempfile.TemporaryDirectory(prefix="hashidate-tts-") as root:
            parent = Path(root) / "new" / "private"
            path = parent / "speech.sock"
            sock = BOUNDARY.listen(path)
            try:
                self.assertEqual(stat.S_IMODE(parent.stat().st_mode), 0o700)
                self.assertEqual(stat.S_IMODE(parent.parent.stat().st_mode), 0o700)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            finally:
                sock.close()
                path.unlink(missing_ok=True)

    def test_listen_rejects_an_existing_unsafe_parent_without_chmod(self):
        with tempfile.TemporaryDirectory(prefix="hashidate-tts-") as root:
            parent = Path(root) / "shared"
            parent.mkdir(mode=0o755)
            os.chmod(parent, 0o755)
            path = parent / "speech.sock"

            with self.assertRaisesRegex(
                SystemExit, rf"HASHIDATE_TTS_SOCKET.*{path}"
            ):
                BOUNDARY.listen(path)

            self.assertEqual(stat.S_IMODE(parent.stat().st_mode), 0o755)
            self.assertFalse(path.exists())


class StartupTests(unittest.TestCase):
    def make_runtime(self, gate: threading.Event, order: list):
        audio = types.SimpleNamespace(
            squeeze=lambda: types.SimpleNamespace(
                cpu=lambda: types.SimpleNamespace(numpy=lambda: b"audio")
            )
        )

        def synthesize(request):
            order.append("warmup")
            gate.wait(5)
            return types.SimpleNamespace(audio=audio, sample_rate=48000)

        return types.SimpleNamespace(synthesize=synthesize)

    def test_health_answers_loading_until_the_mark_is_proven(self):
        with tempfile.TemporaryDirectory(prefix="hashidate-tts-") as root:
            (Path(root) / "ref.pt").write_bytes(b"x")
            gate = threading.Event()
            order: list = []
            mark = types.SimpleNamespace(
                claim=lambda runtime: order.append("claim"),
                self_test=lambda runtime, audio, rate: order.append("self_test"),
            )
            ns = load_startup(Path(root), self.make_runtime(gate, order), mark)
            loader = threading.Thread(target=ns["_load_model"])
            loader.start()
            try:
                while "warmup" not in order:
                    loader.join(0.01)
                self.assertFalse(ns["health"]()["ready"])
                with self.assertRaises(StubHttpError) as refused:
                    ns["speak"](types.SimpleNamespace())
                self.assertEqual(refused.exception.status_code, 503)
            finally:
                gate.set()
                loader.join(5)
            self.assertEqual(order, ["claim", "warmup", "self_test"])
            self.assertTrue(ns["health"]()["ready"])
            self.assertEqual(ns["stopped"], [])

    def test_a_failed_self_test_never_becomes_ready_and_stops_the_process(self):
        with tempfile.TemporaryDirectory(prefix="hashidate-tts-") as root:
            (Path(root) / "ref.pt").write_bytes(b"x")
            gate = threading.Event()
            gate.set()

            def refuse(runtime, audio, rate):
                raise RuntimeError("mark unreadable")

            mark = types.SimpleNamespace(claim=lambda runtime: None, self_test=refuse)
            ns = load_startup(Path(root), self.make_runtime(gate, []), mark)
            with contextlib.redirect_stderr(io.StringIO()):
                ns["_load_model"]()
            self.assertFalse(ns["health"]()["ready"])
            self.assertEqual(ns["stopped"], [True])
            self.assertIsInstance(ns["_startup_error"], RuntimeError)

    def test_missing_reference_latents_stop_the_process(self):
        with tempfile.TemporaryDirectory(prefix="hashidate-tts-") as root:
            mark = types.SimpleNamespace(claim=lambda r: None, self_test=lambda r, a, s: None)
            ns = load_startup(Path(root), None, mark)
            with contextlib.redirect_stderr(io.StringIO()):
                ns["_load_model"]()
            self.assertEqual(ns["stopped"], [True])
            self.assertFalse(ns["health"]()["ready"])


if __name__ == "__main__":
    unittest.main()
