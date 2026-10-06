#!/usr/bin/env python
"""Ensure the Python packages a skill needs are importable.

Usage:
    python ensure_deps.py python-docx:docx openpyxl:openpyxl

Each argument is `pip-name:import-name` (the import name may be omitted when
it matches). Missing packages are installed into the running interpreter with
`pip install --user` as a fallback when the environment is not writable.
"""
import importlib
import subprocess
import sys


def ensure(pip_name: str, import_name: str) -> str:
    try:
        importlib.import_module(import_name)
        return f"ok       {import_name}"
    except ImportError:
        pass

    base = [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check"]
    for extra in ([], ["--user"]):
        result = subprocess.run(base + extra + [pip_name], capture_output=True, text=True)
        if result.returncode == 0:
            importlib.invalidate_caches()
            try:
                importlib.import_module(import_name)
                return f"installed {import_name} ({pip_name})"
            except ImportError as exc:
                return f"FAILED   {pip_name}: installed but not importable: {exc}"
    return f"FAILED   {pip_name}: {result.stderr.strip().splitlines()[-1] if result.stderr.strip() else 'pip install failed'}"


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    failed = False
    for spec in sys.argv[1:]:
        pip_name, _, import_name = spec.partition(":")
        line = ensure(pip_name, import_name or pip_name.replace("-", "_"))
        print(line)
        failed = failed or line.startswith("FAILED")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
