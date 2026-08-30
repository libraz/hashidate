"""Focused tests for the sidecar's process/socket boundary.

The production module imports the speech model and its native dependencies at
module load time. Extracting only the small filesystem/environment functions
keeps this stdlib-only test runnable on a fresh checkout, without importing or
initialising the model.
"""

import ast
import os
import socket
import stat
import tempfile
import types
import unittest
from pathlib import Path


def load_boundary_functions() -> types.SimpleNamespace:
    source_path = Path(__file__).with_name("server.py")
    tree = ast.parse(source_path.read_text())
    wanted = {"_socket_parent", "clear_stale", "env_port", "listen"}
    functions = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in wanted
    ]
    namespace = {
        "Path": Path,
        "errno": __import__("errno"),
        "os": os,
        "socket": socket,
        "stat": stat,
        "SystemExit": SystemExit,
        "SOCKET_PATH_MAX": 100,
    }
    module = ast.Module(body=functions, type_ignores=[])
    exec(compile(module, str(source_path), "exec"), namespace)
    return types.SimpleNamespace(**{name: namespace[name] for name in wanted})


BOUNDARY = load_boundary_functions()


class ServerBoundaryTests(unittest.TestCase):
    def test_env_port_requires_ascii_decimal_digits_for_the_whole_value(self):
        cases = {
            "1": 1,
            "00001": 1,
            "8770": 8770,
            "65535": 65535,
            "0": None,
            "65536": None,
            "8770x": None,
            "1e3": None,
            " 8770": None,
            "8770 ": None,
            "+8770": None,
            "-8770": None,
            "": None,
            "0" * 5000 + "1": 1,
            "1" * 5001: None,
        }
        previous = os.environ.get("HASHIDATE_TTS_PORT")
        try:
            for raw, expected in cases.items():
                with self.subTest(raw=raw):
                    os.environ["HASHIDATE_TTS_PORT"] = raw
                    self.assertEqual(BOUNDARY.env_port(), expected)
        finally:
            if previous is None:
                os.environ.pop("HASHIDATE_TTS_PORT", None)
            else:
                os.environ["HASHIDATE_TTS_PORT"] = previous

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


if __name__ == "__main__":
    unittest.main()
