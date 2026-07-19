"""Minimal Karakeep HTTP fixture used only by the production container smoke test."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

BOOKMARK = {
    "id": "docker-karakeep-bookmark",
    "createdAt": "2026-07-01T10:00:00Z",
    "modifiedAt": "2026-07-02T10:00:00Z",
    "title": "Container archive",
    "archived": True,
    "favourited": False,
    "taggingStatus": "success",
    "summarizationStatus": "success",
    "note": None,
    "summary": "Container integration source",
    "source": "web",
    "userId": "smoke-user",
    "tags": [{"id": "tag-1", "name": "Container", "attachedBy": "human"}],
    "content": {
        "type": "link",
        "url": "https://example.com/container-archive",
        "title": "Container archive",
        "description": "Container integration source",
        "htmlContent": "<article><h2>Karakeep container evidence</h2></article>",
        "author": "Smoke fixture",
        "crawledAt": "2026-07-01T10:01:00Z",
        "crawlStatus": "success",
    },
    "assets": [{"id": "asset-1", "assetType": "fullPageArchive", "fileName": "archive.html"}],
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        path = urlsplit(self.path).path
        if path == "/api/v1/bookmarks/search":
            self._respond({"bookmarks": [BOOKMARK], "nextCursor": None})
        elif path == "/api/v1/bookmarks/docker-karakeep-bookmark":
            self._respond(BOOKMARK)
        elif path == "/api/v1/bookmarks":
            self._respond({"bookmarks": [], "nextCursor": None})
        else:
            self.send_error(404)

    def _respond(self, payload: object) -> None:
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        del format, args


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8901), Handler).serve_forever()
