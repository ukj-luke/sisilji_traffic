import asyncio
import gzip
from pathlib import Path
import tempfile
import unittest

from system.backend.static_assets import TrafficAssets


class AssetTests(unittest.TestCase):
    def test_cache_and_negotiation(self):
        with tempfile.TemporaryDirectory() as root:
            path = "assets/model-Abc_1234.onnx"
            file = Path(root, path)
            file.parent.mkdir()
            file.write_bytes(b"model data" * 40)
            Path(str(file) + ".gz").write_bytes(gzip.compress(file.read_bytes()))
            Path(root, "index.html").write_text("<main/>")
            assets = TrafficAssets(directory=root, html=True)
            def get(path, headers=()):
                return asyncio.run(assets.get_response(path, {"method": "GET", "type": "http", "headers": list(headers)}))
            encoded = get(path, [(b"accept-encoding", b"br, gzip")])
            self.assertEqual(encoded.headers["content-encoding"], "gzip")
            self.assertIn("immutable", encoded.headers["cache-control"])
            identity = get(path, [(b"accept-encoding", b"gzip;q=0, *;q=1")])
            self.assertNotIn("content-encoding", identity.headers)
            self.assertEqual(identity.headers["vary"], "Accept-Encoding")
            self.assertNotEqual(identity.headers["etag"], encoded.headers["etag"])
            cached = get(path, [(b"accept-encoding", b"gzip"), (b"if-none-match", encoded.headers["etag"].encode())])
            self.assertEqual(cached.status_code, 304)
            self.assertEqual(get("index.html").headers["cache-control"], "no-cache")
