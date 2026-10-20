"""Serves the built React app from the same server as the API.

The API lives under /api; everything else is the UI. The UI is a single-page
app, so any address that is not a file (like /repos/1) gets index.html and the
app's router takes over in the browser.

Build it with:  cd ui && npm install && npm run build
(the build lands in aftershock/web, next to this package)
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse

# file names under assets/ carry a hash of their content, so browsers may keep them forever
FOREVER = {"Cache-Control": "public, max-age=31536000, immutable"}
# index.html must be checked every time, or a new build would not show up
FRESH = {"Cache-Control": "no-cache"}

NOT_BUILT = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Aftershock</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f131b;color:#dfe2ec;
font:15px/1.6 -apple-system,"Segoe UI",sans-serif}
main{max-width:560px;padding:24px}code{background:#0a0e15;padding:2px 6px;border-radius:2px;color:#adc6ff}
a{color:#adc6ff}
</style></head>
<body><main>
<h1>The API is running</h1>
<p>The web app has not been built yet. Build it once, then reload this page:</p>
<p><code>cd ui &amp;&amp; npm install &amp;&amp; npm run build</code></p>
<p>Or, while working on the UI, run <code>npm run dev</code> in <code>ui/</code> and open
<a href="http://localhost:5173">localhost:5173</a>. The API docs are at <a href="/api/docs">/api/docs</a>.</p>
</main></body></html>"""


def ui_is_built(folder: Path | None) -> bool:
    return bool(folder) and (folder / "index.html").is_file()


def mount_ui(app: FastAPI, folder: Path | None) -> None:
    """Adds the routes that serve the UI. Call it after every API route is added:
    the catch-all route below must come last."""
    if not ui_is_built(folder):
        @app.get("/", include_in_schema=False)
        def not_built() -> HTMLResponse:
            return HTMLResponse(NOT_BUILT)
        return

    root = folder.resolve()
    index = root / "index.html"

    @app.get("/{path:path}", include_in_schema=False)
    def ui(path: str) -> FileResponse:
        if path == "api" or path.startswith("api/"):
            # a mistyped API address should say so, not quietly return the app
            raise HTTPException(404, f"There is no API route /{path}")
        file = (root / path).resolve()
        if path and file.is_file() and file.is_relative_to(root):
            return FileResponse(file, headers=FOREVER if path.startswith("assets/") else FRESH)
        return FileResponse(index, headers=FRESH)
