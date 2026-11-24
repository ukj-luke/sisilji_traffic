"""시흥시 교차로 CCTV의 HLS 중계 전송부."""
import hashlib
import time
from collections import OrderedDict
from dataclasses import dataclass
from http.client import HTTPException as UpstreamProtocolError
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, build_opener

from fastapi import HTTPException

MEDIA_HOST = "cctvsec.ktict.co.kr"
PLAYLIST_LIMIT = 128 * 1024
SEGMENT_LIMIT = 4 * 1024 * 1024
NO_STORE = {"Cache-Control": "no-store"}


class FeedError(Exception):
    """외부 주소나 인증값을 포함하지 않는 중계 오류."""


def media_url(url):
    parts = urlsplit(url)
    if (parts.scheme != "https" or parts.hostname != MEDIA_HOST
            or parts.port not in (None, 443, 8082) or parts.username is not None
            or parts.password is not None or parts.fragment):
        raise FeedError()
    return url


class SourceRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(req.full_url).hostname not in (MEDIA_HOST, "gitsview.gg.go.kr"):
            raise FeedError()
        media_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url, limit, timeout=9):
    try:
        with build_opener(SourceRedirect()).open(url, timeout=timeout) as response:
            body = response.read(limit + 1)
            if not body or len(body) > limit:
                raise FeedError()
            return response.geturl(), body
    except (OSError, URLError, ValueError, UpstreamProtocolError) as exc:
        if isinstance(exc, HTTPError):
            exc.close()
        raise FeedError() from None


def short_id(value):
    return hashlib.sha256(value.encode()).hexdigest()[:24]


@dataclass(frozen=True)
class Camera:
    id: str
    name: str
    lat: float
    lon: float
    stream: str


def read_playlist(url):
    final, body = fetch(media_url(url), PLAYLIST_LIMIT)
    lines = body.decode("utf-8-sig", errors="replace").splitlines()
    if not lines or lines[0].strip() != "#EXTM3U" or "#EXT-X-ENDLIST" in lines:
        raise FeedError()
    return final, [s.strip() for s in lines if s.strip()]


class Stream:
    def __init__(self):
        self.last_use = time.monotonic()
        self.lock = Lock()
        self.master = self.variant = None
        self.text = ""
        self.updated = float("-inf")
        self.parts = OrderedDict()
        self.buffer = OrderedDict()

    def playlist(self, camera):
        now = time.monotonic()
        if camera.stream == self.master and now - self.updated < 1:
            return self.text
        if camera.stream != self.master:
            self.variant = None
        url, lines = read_playlist(self.variant or camera.stream)
        if any(line.startswith("#EXT-X-STREAM-INF:") for line in lines):
            variant = next((line for line in lines if not line.startswith("#")), None)
            if not variant:
                raise FeedError()
            self.variant = media_url(urljoin(url, variant))
            url, lines = read_playlist(self.variant)
        if not any(line.startswith("#EXTINF:") for line in lines):
            raise FeedError()

        # ITS 피드에서 사용하는 TS 태그만 전달합니다. 원본 URI는 서버 메모리에 둡니다.
        tags = ("#EXT-X-VERSION:", "#EXT-X-TARGETDURATION:", "#EXT-X-MEDIA-SEQUENCE:",
                "#EXT-X-DISCONTINUITY-SEQUENCE:", "#EXT-X-PROGRAM-DATE-TIME:")
        out = []
        new_parts = {}
        for line in lines:
            if line.startswith(("#EXT-X-KEY", "#EXT-X-MAP", "#EXT-X-BYTERANGE")):
                raise FeedError()
            if line in ("#EXTM3U", "#EXT-X-INDEPENDENT-SEGMENTS", "#EXT-X-DISCONTINUITY"):
                out.append(line)
            elif line.startswith(tags):
                out.append(line)
            elif line.startswith("#EXTINF:"):
                out.append(line.split(",", 1)[0] + ",")
            elif not line.startswith("#"):
                upstream = media_url(urljoin(url, line))
                token = short_id(upstream)
                new_parts[token] = upstream
                out.append(f"/api/cctv/{camera.id}/parts/{token}.ts")
        if not new_parts:
            raise FeedError()
        for token, upstream in new_parts.items():
            self.parts[token] = upstream
            self.parts.move_to_end(token)
        while len(self.parts) > 48:
            self.parts.popitem(last=False)
        self.master, self.text, self.updated = camera.stream, "\n".join(out) + "\n", now
        return self.text

    def segment(self, token):
        if token not in self.parts or time.monotonic() - self.updated > 90:
            raise HTTPException(404, "영상 조각의 재생 시간이 지났어요.")
        if token not in self.buffer:
            _, data = fetch(self.parts[token], SEGMENT_LIMIT)
            if data[0] != 0x47:
                raise FeedError()
            self.buffer[token] = data
            if len(self.buffer) > 3:
                self.buffer.popitem(last=False)
        return self.buffer[token]


sessions = {}
sessions_lock = Lock()


def stream_for(camera_id, *, create):
    now = time.monotonic()
    with sessions_lock:
        for key in list(sessions):
            if now - sessions[key].last_use > 90:
                del sessions[key]
        if camera_id not in sessions:
            if not create:
                raise HTTPException(404, "재생 세션이 끝났어요.")
            if len(sessions) >= 8:
                raise HTTPException(503, "사용 중인 카메라가 많아요. 잠시 뒤 다시 연결해 주세요.")
            sessions[camera_id] = Stream()
        stream = sessions[camera_id]
        stream.last_use = now
        return stream
