"""브라우저 분석 모델과 실행기를 압축해 제공하고 해시 자산을 캐시합니다."""
import re
from mimetypes import guess_type

from anyio import to_thread
from starlette.datastructures import Headers
from starlette.staticfiles import StaticFiles

HASHED_ASSET = re.compile(r"assets/[\w.-]+-[\w-]{8}\.(?:wasm|onnx|mjs|js|css|svg|webp|txt)$")


def accepts_gzip(header: str) -> bool:
    preferences = {}
    for item in header.lower().split(","):
        name, _, params = item.strip().partition(";")
        params = params.strip()
        try:
            preferences[name] = float(params.removeprefix("q=")) if params else 1.0
        except ValueError:
            preferences[name] = 0
    return preferences.get("gzip", preferences.get("*", 0)) > 0


class TrafficAssets(StaticFiles):
    async def get_response(self, path, scope):
        if not HASHED_ASSET.fullmatch(path):
            response = await super().get_response(path, scope)
            if path in (".", "") or path.endswith(".html"):
                response.headers["Cache-Control"] = "no-cache"
            return response
        headers = Headers(scope=scope)
        compressed = False
        if path.endswith((".wasm", ".onnx", ".js", ".mjs")) and accepts_gzip(headers.get("accept-encoding", "")):
            _, stat = await to_thread.run_sync(self.lookup_path, path + ".gz")
            compressed = stat is not None
        response = await super().get_response(path + ".gz" if compressed else path, scope)
        if response.status_code in (200, 206, 304):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            response.headers["Vary"] = "Accept-Encoding"
            if compressed:
                response.headers["Content-Encoding"] = "gzip"
                response.headers["Content-Type"] = guess_type(path)[0] or "application/octet-stream"
        return response
