"""Path and file-name rules shared by the build tools.

`plain_name` mirrors `fileSchema` in src/protocol/avatars.ts; keep the two equal.
"""
import os


def relative(path, where):
    """A path inside the package: relative, and never climbing out of it."""
    if not isinstance(path, str) or not path or os.path.isabs(path):
        raise SystemExit(f"{where}: must be a relative path, got {path!r}")
    if ".." in path.replace("\\", "/").split("/"):
        raise SystemExit(f"{where}: may not contain '..', got {path!r}")
    return path


def plain_name(name, where):
    """A file name beside the model: non-empty, no separator, '?', '#' or '..'."""
    if not isinstance(name, str) or not name or any(c in name for c in "/\\?#") or ".." in name:
        raise SystemExit(f"{where}: must be a plain filename such as shade.png, got {name!r}")
    return name
