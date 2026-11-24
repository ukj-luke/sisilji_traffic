"""시흥시 중부권의 확인된 시내 교차로 CCTV만 공개합니다."""
import html
import json
import re
import os
from pathlib import Path
from tempfile import NamedTemporaryFile
import time
from functools import lru_cache
from threading import BoundedSemaphore, Condition, Lock, Thread
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener
from urllib.error import HTTPError
from http.client import HTTPException as ProtocolError
from contextlib import asynccontextmanager
import math

from fastapi import APIRouter, Header, HTTPException, Response
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from .live_cctv import Camera, FeedError, NO_STORE, SourceRedirect, fetch, media_url, stream_for

router = APIRouter(prefix="/api/cctv")
GITS = "https://gits.gg.go.kr"
REGISTRY = json.loads((Path(__file__).resolve().parents[1] / "data" /
                       "central_intersection_cameras.json").read_text(encoding="utf-8"))
CLIP_LIMIT = 16 * 1024 * 1024


def gits_rows():
    _, raw = fetch(GITS + "/web/map/webLoadCCTVData.do", 2 * 1024 * 1024)
    result = {}
    for record in raw.decode("utf-8-sig").strip().split("@"):
        fields = record.strip().split("/")
        if len(fields) < 4 or fields[0] not in REGISTRY:
            continue
        ident, name, x, y = fields[:4]
        try:
            lon, lat = float(x), float(y)
        except ValueError:
            continue
        registered = REGISTRY[ident]
        delta = math.hypot(lat-registered["lat"], (lon-registered["lon"])*math.cos(math.radians(lat)))
        if name == registered.get("sourceName", registered["name"]) and delta * 111195 <= 30:
            result[ident] = dict(registered, id="gits-" + ident, lat=lat, lon=lon,
                                 agency=registered.get("agency", "시흥시"))
    if not result:
        raise FeedError()
    return result


class Directory:
    """공개 이름과 좌표만 저장하며, 갱신 중에도 최근 목록을 제공합니다."""

    def __init__(self, loader, ttl, name):
        self.load, self.ttl, self.name = loader, ttl, name
        self.changed = Condition()
        self.rows = {}
        self.updated = self.next_try = 0
        self.restored = self.refreshing = False

    def cache_file(self):
        root = os.environ.get("SISILJI_CAMERA_CACHE_DIR")
        return Path(root) / (self.name + ".json") if root else None

    def restore(self, path):
        if path is None:
            return
        try:
            snapshot = json.loads(path.read_bytes())
            age = time.time() - snapshot["updated"]
            if 0 <= age < 2 * self.ttl and isinstance(snapshot["rows"], dict):
                self.rows = snapshot["rows"]
                self.updated = snapshot["updated"]
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def refresh(self):
        try:
            rows = self.load()
            updated = time.time()
            with self.changed:
                self.rows, self.updated = rows, updated
            path = self.cache_file()
            if path:
                path.parent.mkdir(parents=True, exist_ok=True)
                with NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as fp:
                    json.dump({"updated": updated, "rows": rows}, fp, ensure_ascii=False)
                os.replace(fp.name, path)
        except (FeedError, OSError, ValueError, KeyError, SyntaxError):
            pass
        finally:
            with self.changed:
                self.refreshing = False
                self.changed.notify_all()

    def get(self):
        with self.changed:
            if not self.restored:
                self.restore(self.cache_file())
                self.restored = True
            now = time.time()
            if self.rows and now - self.updated < self.ttl:
                return self.rows
            if not self.refreshing and now >= self.next_try:
                self.refreshing = True
                self.next_try = now + 60
                Thread(target=self.refresh, daemon=True).start()
            if self.rows and now - self.updated < 2 * self.ttl:
                return self.rows
            self.changed.wait_for(lambda: not self.refreshing, timeout=65)
            if not self.rows or time.time() - self.updated >= 2 * self.ttl:
                raise HTTPException(503, "센터에서 카메라 목록을 받을 수 없어요.")
            return self.rows


gits = Directory(gits_rows, 3600, "central-city-gits-v2")


@asynccontextmanager
async def camera_lifespan(app):
    def warm():
        try:
            gits.get()
        except HTTPException:
            pass
    Thread(target=warm, daemon=True).start()
    yield


@router.get("")
@router.get("/gits")
def gits_cameras():
    return [row for ident, row in gits.get().items() if ident in REGISTRY]


def gits_media(value):
    url = html.unescape(value)
    if url.startswith("//"):
        url = "https:" + url
    if url.startswith("http://gitsview.gg.go.kr/"):
        url = "https:" + url[5:]
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname != "gitsview.gg.go.kr"
            or parsed.port not in (443, None) or parsed.username is not None or parsed.password is not None):
        raise FeedError()
    return url


@lru_cache(maxsize=48)
def player_source(ident, window):
    _, raw = fetch(GITS + "/web/popup/webCctvPopup.do?" + urlencode({"cctvId": ident}), 128 * 1024)
    page = raw.decode("utf-8", errors="replace")
    provider = {"시흥시": "경찰청UTIS-시흥시", "경기도": "경기도교통정보센터-경기도"}[REGISTRY[ident].get("agency", "시흥시")]
    credits = re.findall(r"<span>\s*([^<>]*?)제공\s*</span>", page)
    if provider not in {re.sub(r"\s+", "", credit) for credit in credits}:
        raise FeedError()
    resolver = re.search(r'''\$\.get\(\s*["']((?:(?:https?:)?//)gitsview\.gg\.go\.kr/[^"']+!hls)["']''', page)
    clip = re.search(r'''(?:<video\b[^>]*?\bsrc\s*=\s*|var\s+videoUrl\s*=\s*)["']([^"']+)["']''', page, re.I)
    if resolver:
        try:
            _, body = fetch(gits_media(resolver[1]), 8192)
            return "hls", media_url(body.decode().strip())
        except (FeedError, UnicodeError):
            if not clip:
                raise FeedError() from None
    if clip:
        return "mp4", gits_media(clip[1])
    raise FeedError()


relay_slots = BoundedSemaphore(8)


def known_camera(ident):
    row = gits.get().get(ident) if ident in REGISTRY else None
    if not row:
        raise HTTPException(404, "목록에 없는 경기도 카메라예요.")
    return row


@router.get("/gits/{ident}/view")
def gits_view(ident: str):
    known_camera(ident)
    try:
        window = int(time.monotonic() // 45)
        kind, source = player_source(ident, window)
        relay = (f"/api/cctv/gits/{ident}/live.m3u8" if kind == "hls"
                 else f"/api/cctv/gits/{ident}/relay/{window}.mp4")
        # 공개 웹 재생기에 게시된 재생 전용 주소입니다. GITS API 키를 사용하지 않습니다.
        return Response(
            content=json.dumps({"kind": kind, "src": source, "relay": relay}),
            media_type="application/json", headers=NO_STORE,
        )
    except (FeedError, ValueError):
        raise HTTPException(502, "경기도교통정보센터의 영상을 받을 수 없어요.") from None


@router.get("/gits/{ident}/live.m3u8")
def gits_live(ident: str):
    row = known_camera(ident)
    try:
        stream = stream_for(row["id"], create=True)
        with stream.lock:
            kind, source = player_source(ident, int(time.monotonic() // 45))
            if kind != "hls":
                raise FeedError()
            camera = Camera(row["id"], row["name"], row["lat"], row["lon"], source)
            playlist = stream.playlist(camera)
        return Response(playlist, media_type="application/vnd.apple.mpegurl", headers=NO_STORE)
    except (FeedError, ValueError):
        raise HTTPException(502, "실시간 HLS 영상을 받을 수 없어요.") from None


@router.get("/{camera_id}/parts/{token}.ts")
def city_segment(camera_id: str, token: str):
    if not camera_id.startswith("gits-") or camera_id[5:] not in REGISTRY:
        raise HTTPException(404, "운영 대상에 없는 카메라예요.")
    stream = stream_for(camera_id, create=False)
    try:
        with stream.lock:
            data = stream.segment(token)
        return Response(data, media_type="video/mp2t", headers=NO_STORE)
    except (FeedError, OSError):
        raise HTTPException(502, "영상 조각을 받을 수 없어요.") from None


@router.get("/gits/{ident}/relay/{window}.mp4")
def relay_mp4(ident: str, window: int, range_header: str | None = Header(default=None, alias="Range")):
    known_camera(ident)
    if not 0 <= int(time.monotonic() // 45) - window <= 3:
        raise HTTPException(410, "센터 영상을 다시 연결해 주세요.")
    headers = {}
    if range_header:
        if not re.fullmatch(r"bytes=(?:\d{1,18}-\d{0,18}|-\d{1,18})", range_header):
            raise HTTPException(416, "지원하지 않는 영상 범위예요.")
        headers["Range"] = range_header
    if not relay_slots.acquire(blocking=False):
        raise HTTPException(503, "중계 연결이 사용 중이에요.")
    upstream = None
    try:
        kind, source = player_source(ident, window)
        if kind != "mp4":
            raise FeedError()
        upstream = build_opener(SourceRedirect()).open(Request(gits_media(source), headers=headers), timeout=12)
        size = int(upstream.headers["Content-Length"])
        if upstream.status not in (200, 206) or not 0 < size <= CLIP_LIMIT:
            raise FeedError()
        if upstream.headers.get_content_type() != "video/mp4":
            raise FeedError()
        media_headers = {**NO_STORE, "Content-Length": str(size)}
        for name in ("Accept-Ranges", "Content-Range"):
            if upstream.headers.get(name):
                media_headers[name] = upstream.headers[name]
    except (FeedError, OSError, ProtocolError, TypeError, ValueError) as exc:
        if upstream is not None:
            upstream.close()
        if isinstance(exc, HTTPError):
            exc.close()
        relay_slots.release()
        status = 416 if isinstance(exc, HTTPError) and exc.code == 416 else 502
        raise HTTPException(status, "센터 영상 범위를 받을 수 없어요.") from None

    closed = False
    close_lock = Lock()

    def close():
        nonlocal closed
        with close_lock:
            if not closed:
                closed = True
                upstream.close()
                relay_slots.release()

    def chunks():
        try:
            remaining = size
            while remaining:
                chunk = upstream.read1(min(64 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk
        finally:
            close()

    return StreamingResponse(chunks(), status_code=upstream.status, media_type="video/mp4",
                             headers=media_headers, background=BackgroundTask(close))
