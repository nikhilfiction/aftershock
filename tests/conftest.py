"""Shared test setup.

The JavaScript/TypeScript scanner needs the TypeScript compiler. If the web
app's dependencies are installed (ui/node_modules), the tests use that copy
instead of installing one into the cache folder.
"""

import os
import shutil
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
UI_TYPESCRIPT = ROOT / "ui" / "node_modules" / "typescript"

if not os.getenv("AFTERSHOCK_TYPESCRIPT") and (UI_TYPESCRIPT / "package.json").is_file():
    os.environ["AFTERSHOCK_TYPESCRIPT"] = str(UI_TYPESCRIPT)

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")
