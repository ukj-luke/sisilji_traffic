"""City intersection CCTV scope and playback tests. No external network or keys required."""
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from system.backend import live_cctv as live


ORIGIN = "https://cctvsec.ktict.co.kr:8082"
CAMERA = live.Camera("camera1", "월곶", 37.39, 126.75, ORIGIN + "/master.m3u8?private=example")
MASTER = ["#EXTM3U", "#EXT-X-STREAM-INF:BANDWIDTH=1000000", "media.m3u8?private=example"]
PLAYLIST = ["#EXTM3U", "#EXT-X-TARGETDURATION:3", "#EXT-X-MEDIA-SEQUENCE:100",
            "#EXTINF:3.0,private title", "current.ts?private=example"]


class LiveRelayTests(unittest.TestCase):
    def test_viewers_share_playlists_and_chunks_without_receiving_source_urls(self):
        stream = live.Stream()
        with patch.object(live, "read_playlist", side_effect=[
            (CAMERA.stream, MASTER), (ORIGIN + "/media.m3u8", PLAYLIST)
        ]) as read:
            playlist = stream.playlist(CAMERA)
            self.assertEqual(playlist, stream.playlist(CAMERA))
            self.assertEqual(read.call_count, 2)
        self.assertIn("#EXT-X-MEDIA-SEQUENCE:100", playlist)
        self.assertNotIn("private", playlist)
        self.assertNotIn(ORIGIN, playlist)
        token = playlist.splitlines()[-1].rsplit("/", 1)[1].removesuffix(".ts")
        with patch.object(live, "fetch", return_value=("ignored", b"\x47" * 188)) as fetch:
            self.assertEqual(stream.segment(token), stream.segment(token))
            fetch.assert_called_once_with(ORIGIN + "/current.ts?private=example", live.SEGMENT_LIMIT)

    def test_unknown_piece_does_not_request_upstream(self):
        with patch.object(live, "fetch") as fetch, self.assertRaises(HTTPException) as exc:
            live.Stream().segment("unknown")
        self.assertEqual(exc.exception.status_code, 404)
        fetch.assert_not_called()

    def test_only_official_source_is_accepted(self):
        for bad in ("https://example.com/x", "http://cctvsec.ktict.co.kr/x",
                    "https://cctvsec.ktict.co.kr:4321/x", "https://guest@cctvsec.ktict.co.kr/x"):
            with self.subTest(bad=bad), self.assertRaises(live.FeedError):
                live.media_url(bad)
        self.assertEqual(live.media_url(CAMERA.stream), CAMERA.stream)

    def test_rejects_unhandled_key_and_external_media(self):
        for lines in [PLAYLIST + ['#EXT-X-KEY:METHOD=AES-128,URI="key"'],
                      [*PLAYLIST[:-1], "https://example.com/media.ts"]]:
            with patch.object(live, "read_playlist", return_value=(CAMERA.stream, lines)), self.assertRaises(live.FeedError):
                live.Stream().playlist(CAMERA)


class RegionalTests(unittest.TestCase):
    def test_gits_public_directory_is_geofenced(self):
        from system.backend import regional_cctv as regional
        rows = "6581/물왕교차로/126.8298/37.38526/1/3/1@49/남동IC/126.83/37.38/1/3/1@1845/논곡삼거리/126.854905/37.39642/3/3/1@6575/신천사거리/126.787/37.43952/1/3/1".encode()
        with patch.object(regional, "fetch", return_value=("ignored", rows)):
            self.assertEqual(list(regional.gits_rows()), ["6581"])

    def test_surface_intersection_uses_catalog_name_and_its_own_provider(self):
        from system.backend import regional_cctv as regional
        rows = "1216/목감지하차도/126.86174534/37.38837875/2/1/1".encode()
        with patch.object(regional, "fetch", return_value=("ignored", rows)):
            camera = regional.gits_rows()["1216"]
        self.assertEqual((camera["name"], camera["agency"], camera["siteId"]), ("목감사거리", "경기도", "스마트_14"))
        clip = "https://gitsview.gg.go.kr/1216/view"
        for owner, valid in [("경기도교통정보센터-경기도", True), ("경찰청UTIS-시흥시", False)]:
            page = f'<span>{owner} 제공</span><video src="{clip}">'.encode()
            with patch.object(regional, "fetch", return_value=("ignored", page)):
                if valid:
                    self.assertEqual(regional.player_source("1216", -2), ("mp4", clip))
                else:
                    with self.assertRaises(live.FeedError):
                        regional.player_source("1216", -3)

    def test_gits_direct_view_does_not_read_video(self):
        from system.backend import regional_cctv as regional
        import json
        url = "https://gitsview.gg.go.kr/6581/public-viewer"
        with patch.object(regional, "known_camera"), patch.object(regional, "player_source", return_value=("mp4", url)), patch.object(regional, "fetch") as read:
            info = json.loads(regional.gits_view("6581").body)
        self.assertEqual(info["src"], url)
        self.assertIn("/gits/6581/relay/", info["relay"])
        read.assert_not_called()

    def test_mp4_fallback_forwards_range_without_buffering(self):
        from system.backend import regional_cctv as regional
        from email.message import Message
        from unittest.mock import MagicMock
        import asyncio
        import time
        source = MagicMock(status=206)
        source.headers = Message()
        for k, v in {"Content-Type":"video/mp4","Content-Length":"4","Content-Range":"bytes 4-7/16"}.items():
            source.headers[k] = v
        source.read1.side_effect = [b"ft",b"yp"]
        window = int(time.monotonic() // 45)
        with patch.object(regional, "known_camera"), patch.object(regional, "player_source", return_value=("mp4","https://gitsview.gg.go.kr/6581/view")), patch.object(regional, "build_opener") as opener:
            opener.return_value.open.return_value = source
            response = regional.relay_mp4("6581", window, "bytes=4-7")
            req = opener.return_value.open.call_args.args[0]
            self.assertEqual(req.get_header("Range"),"bytes=4-7")
            source.read1.assert_not_called()
            self.assertEqual(response.status_code,206)
            async def consume():
                return [part async for part in response.body_iterator]
            self.assertEqual(asyncio.run(consume()), [b"ft",b"yp"])
            source.close.assert_called_once()

    def test_unapproved_cameras_are_rejected_even_if_returned_by_an_old_cache(self):
        from system.backend import regional_cctv as regional
        with patch.object(regional.gits, "get", return_value={"6581":{"id":"gits-6581"},"1845":{"id":"gits-1845"}}):
            self.assertEqual(regional.gits_cameras(), [{"id":"gits-6581"}])
            for ident in ("1845", "1846", "1227", "6575"):
                with self.assertRaises(HTTPException) as err:
                    regional.gits_view(ident)
                self.assertEqual(err.exception.status_code,404)

    def test_camera_must_keep_its_registered_position_and_name(self):
        from system.backend import regional_cctv as regional
        rows="6581/물왕교차로/126.85/37.40/1/3/1@6601/고속도로/126.8531/37.40205/1/3/1".encode()
        with patch.object(regional, "fetch", return_value=("ignored", rows)), self.assertRaises(live.FeedError):
            regional.gits_rows()

    def test_player_with_changed_owner_is_not_published(self):
        from system.backend import regional_cctv as regional
        with patch.object(regional, "fetch", return_value=("ignored", "<span>고속도로 제공</span>".encode())), self.assertRaises(live.FeedError):
            regional.player_source("6581",-1)

    def test_public_directory_survives_process_restart(self):
        import os
        from pathlib import Path
        from tempfile import TemporaryDirectory
        from system.backend.regional_cctv import Directory
        from unittest.mock import Mock
        rows = {"1": {"id": "gits-1", "name":"거리", "lat":37.4, "lon":126.8}}
        with TemporaryDirectory() as root, patch.dict(os.environ, {"SISILJI_CAMERA_CACHE_DIR":root}):
            first = Directory(lambda: rows, 3600, "gits")
            self.assertEqual(first.get(), rows)
            self.assertTrue((Path(root)/"gits.json").is_file())
            second_load = Mock()
            self.assertEqual(Directory(second_load, 3600, "gits").get(), rows)
            second_load.assert_not_called()
