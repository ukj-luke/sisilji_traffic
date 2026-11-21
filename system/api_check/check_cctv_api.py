"""M0: 발급받은 ITS, UTIC 키로 시흥 CCTV를 받을 수 있는지 확인한다.

사용법 (저장소 루트에서):
    1. system/.env.example 을 system/.env 로 복사하고 키를 채운다.
    2. python3 system/api_check/check_cctv_api.py

UTIC 키는 신청한 IP(집 라우터)에서만 동작하므로 Odroid나 WSL에서 실행한다.

확인하는 것:
    - ITS 국가교통정보센터 CCTV(고속도로 ex, 국도 its)가 시흥 범위에 몇 대 있는지
    - UTIC 도시교통정보센터 CCTV 목록에 어느 센터가 있는지, 좌표로 본 시흥 범위 카메라
    - 각 카메라가 중부권 스마트교차로에서 얼마나 떨어져 있는지
    - 앞쪽 몇 대의 HLS 재생 목록이 열리는지, 해상도와 대역폭이 얼마인지(ITS만)

UTIC는 같은 URL을 1초에 5회 넘게 부르면 IP를 차단한다고 안내한다. 이 스크립트는
목록과 좌표 파일을 한 번씩만 받고, 스트림 확인은 요청 사이에 쉬는 시간을 둔다.
결과(스트림 주소에 토큰이 들어 있음)는 system/api_check/out/ 에 저장하며 Git에 올리지 않는다.

macOS 기본 Python의 urllib은 이 기관들의 인증서 체인을 검증하지 못해서 curl을 쓴다.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SYSTEM_DIR = ROOT / "system"
OUT_DIR = SYSTEM_DIR / "api_check" / "out"
# 공공데이터포털 「경기도 시흥시_스마트교차로 현황」(2025-11-05)을 UTF-8로 바꾼 사본
# 원본: https://www.data.go.kr/data/15090289/fileData.do
SMART_CSV = SYSTEM_DIR / "data" / "siheung_smart_intersections_2025-11-05.csv"

# 시흥시 전역을 덮는 사각형(경도, 위도). 인접 시 일부가 섞이므로 결과는 이름과 지도로 다시 본다.
SIHEUNG_BBOX = (126.70, 126.90, 37.32, 37.48)

# 중부권 6개 행정동(월곶, 군자, 장곡, 능곡, 연성, 목감)에 속하는 법정동
MIDDLE_LEGAL_DONGS = (
    "월곶동", "거모동", "군자동", "장곡동", "장현동", "화정동", "능곡동",
    "광석동", "하중동", "하상동", "물왕동", "산현동", "조남동", "논곡동", "목감동",
)

ITS_URL = "https://openapi.its.go.kr:9443/cctvInfo"
UTIC_URL = "https://www.utic.go.kr/guide/cctvOpenData.do"


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def curl_get(url: str, params: dict[str, str] | None = None, timeout: int = 20) -> tuple[int, bytes]:
    cmd = ["curl", "-sS", "-L", "-m", str(timeout), "-w", "\n%{http_code}", "-G", url]
    for k, v in (params or {}).items():
        cmd += ["--data-urlencode", f"{k}={v}"]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        return 0, proc.stderr
    body, _, code = proc.stdout.rpartition(b"\n")
    return int(code or 0), body


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def load_middle_smart_intersections() -> list[dict]:
    rows = []
    with SMART_CSV.open(encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            addr = row.get("스마트 교차로 주소(지번)", "")
            if any(d in addr for d in MIDDLE_LEGAL_DONGS):
                rows.append({
                    "name": row["스마트 교차로명"],
                    "lon": float(row["경도"]),
                    "lat": float(row["위도"]),
                })
    return rows


def nearest(smart: list[dict], lon: float, lat: float) -> tuple[str, float]:
    best = min(smart, key=lambda s: haversine_m(lon, lat, s["lon"], s["lat"]))
    return best["name"], haversine_m(lon, lat, best["lon"], best["lat"])


def in_bbox(lon: float, lat: float) -> bool:
    minx, maxx, miny, maxy = SIHEUNG_BBOX
    return minx <= lon <= maxx and miny <= lat <= maxy


def parse_its(body: bytes) -> list[dict]:
    text = body.decode("utf-8", errors="replace").strip()
    if text.startswith("{"):
        data = json.loads(text)
        resp = data.get("response", data)
        items = resp.get("data", [])
        return items if isinstance(items, list) else [items]
    root = ET.fromstring(text)
    return [{c.tag: (c.text or "").strip() for c in d} for d in root.iter("data")]


def check_its(key: str) -> list[dict]:
    minx, maxx, miny, maxy = SIHEUNG_BBOX
    cams: list[dict] = []
    for road_type in ("its", "ex"):
        params = {
            "apiKey": key, "type": road_type, "cctvType": "4",
            "minX": str(minx), "maxX": str(maxx), "minY": str(miny), "maxY": str(maxy),
            "getType": "json",
        }
        code, body = curl_get(ITS_URL, params)
        if code != 200:
            print(f"  [ITS {road_type}] HTTP {code}: {body[:200]!r}")
            continue
        try:
            items = parse_its(body)
        except Exception as e:  # 응답 형식이 명세와 다르면 원문을 보여 준다
            print(f"  [ITS {road_type}] 응답 해석 실패 {e}: {body[:300]!r}")
            continue
        for it in items:
            try:
                lon, lat = float(it.get("coordx")), float(it.get("coordy"))
            except (TypeError, ValueError):
                continue
            cams.append({
                "source": f"ITS-{road_type}", "name": it.get("cctvname", ""),
                "lon": lon, "lat": lat, "stream": it.get("cctvurl", ""),
                "format": it.get("cctvformat", ""), "resolution": it.get("cctvresolution", ""),
                "in_bbox": in_bbox(lon, lat),
            })
        time.sleep(1.0)
    return cams


def read_xlsx_rows(data: bytes) -> list[list[str]]:
    """표준 라이브러리만으로 첫 시트의 행을 읽는다(openpyxl 설치를 피하려고)."""
    import io
    import zipfile
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    z = zipfile.ZipFile(io.BytesIO(data))
    names = z.namelist()
    shared: list[str] = []
    if "xl/sharedStrings.xml" in names:
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % ns["m"])))
    sheet = sorted(n for n in names if n.startswith("xl/worksheets/"))[0]
    rows = []
    for r in ET.fromstring(z.read(sheet)).iter("{%s}row" % ns["m"]):
        vals = []
        for c in r.findall("m:c", ns):
            v, t = c.find("m:v", ns), c.get("t")
            x = v.text if v is not None and v.text is not None else ""
            if t == "s" and x:
                x = shared[int(x)]
            elif t == "inlineStr":
                x = "".join(tt.text or "" for tt in c.iter("{%s}t" % ns["m"]))
            vals.append(x)
        rows.append(vals)
    return rows


def check_utic(key: str) -> tuple[list[dict], dict | None]:
    """UTIC는 키 인증된 CCTV 목록을 HTML로, 좌표 속성을 엑셀로 준다(2026-11-18 확인).

    목록 HTML에서 센터별 대수를 세고, 좌표 엑셀(요청 1회)로 시흥 범위 카메라를 고른다.
    영상 주소는 목록에 없고 UTIC 보기 창으로만 열리므로 여기서는 받지 않는다.
    """
    code, body = curl_get(UTIC_URL, {"key": key}, timeout=60)
    text = body.decode("utf-8", errors="replace")
    if code != 200:
        print(f"  [UTIC] HTTP {code}: {text[:200]}")
        return [], None
    if text.lstrip().startswith("["):
        print(f"  [UTIC] 오류 응답: {text[:200]}")
        return [], None
    entries = re.findall(
        r"javascript:test\('([^']+)'\)\">([^<]*)</a></td>\s*<td[^>]*>\s*<a[^>]*>([^<]*)</a>", text)
    centers: dict[str, int] = {}
    for _, _, center in entries:
        centers[center.strip()] = centers.get(center.strip(), 0) + 1
    print(f"  [UTIC] 목록 {len(entries)}건, 센터 {len(centers)}곳. 시흥 센터: "
          f"{[c for c in centers if '시흥' in c] or '없음'}")

    time.sleep(2.0)
    code, data = curl_get("https://www.utic.go.kr/excel/download/OpenDataCCTV", {"key": key}, timeout=60)
    if code != 200 or not data.startswith(b"PK"):
        print(f"  [UTIC] 좌표 파일을 받지 못함: HTTP {code}")
        return [], {"centers": centers}
    rows = read_xlsx_rows(data)
    header = rows[0]
    col = {h: i for i, h in enumerate(header)}
    cams = []
    for r in rows[1:]:
        try:
            lon, lat = float(r[col["XCOORD"]]), float(r[col["YCOORD"]])
        except (KeyError, ValueError, IndexError):
            continue
        if in_bbox(lon, lat):
            cams.append({"source": "UTIC", "name": r[col["CCTVNAME"]], "center": r[col["CENTERNAME"]],
                         "cctv_id": r[col["CCTVID"]], "lon": lon, "lat": lat, "stream": "",
                         "in_bbox": True})
    by_center: dict[str, int] = {}
    for c in cams:
        by_center[c["center"]] = by_center.get(c["center"], 0) + 1
    print(f"  [UTIC] 좌표 {len(rows) - 1}건 중 시흥 범위 {len(cams)}건, 센터별 {by_center}")
    return cams, {"header": header, "centers": centers}


def probe_hls(url: str) -> dict:
    code, body = curl_get(url, timeout=15)
    text = body.decode("utf-8", errors="replace")
    result = {"http": code, "is_m3u8": text.lstrip().startswith("#EXTM3U")}
    res = re.findall(r"RESOLUTION=(\d+x\d+)", text)
    bw = re.findall(r"BANDWIDTH=(\d+)", text)
    td = re.findall(r"#EXT-X-TARGETDURATION:(\d+)", text)
    if res:
        result["resolution"] = sorted(set(res))
    if bw:
        result["bandwidth_kbps"] = sorted({int(b) // 1000 for b in bw})
    if td:
        result["segment_s"] = int(td[0])
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", type=int, default=5, help="HLS를 열어 볼 카메라 수(중부권에 가까운 순)")
    args = ap.parse_args()

    env = load_env(SYSTEM_DIR / ".env")
    its_key, utic_key = env.get("ITS_API_KEY", ""), env.get("UTIC_API_KEY", "")
    if not its_key and not utic_key:
        print("system/.env 에 ITS_API_KEY 또는 UTIC_API_KEY를 넣어 주세요(system/.env.example 참고).")
        return 1

    smart = load_middle_smart_intersections()
    print(f"중부권 스마트교차로 {len(smart)}곳을 거리 기준으로 씁니다.")

    cams: list[dict] = []
    utic_sample = None
    if its_key:
        print("ITS 국가교통정보센터 CCTV 조회")
        cams += check_its(its_key)
    if utic_key:
        print("UTIC 도시교통정보센터 CCTV 목록 조회(1회)")
        utic_cams, utic_sample = check_utic(utic_key)
        cams += utic_cams

    for c in cams:
        if not math.isnan(c["lon"]):
            c["nearest_smart"], c["nearest_m"] = nearest(smart, c["lon"], c["lat"])
        else:
            c["nearest_smart"], c["nearest_m"] = "", float("inf")
    cams.sort(key=lambda c: c["nearest_m"])

    print("\n중부권 스마트교차로에서 가까운 순(시흥 범위 안)")
    print(f"{'출처':<8} {'거리(m)':>8}  {'가까운 스마트교차로':<14} 카메라 이름")
    for c in cams:
        if c["in_bbox"]:
            center = f" ({c['center']})" if c.get("center") else ""
            print(f"{c['source']:<8} {c['nearest_m']:>8.0f}  {c['nearest_smart']:<14} {c['name']}{center}")

    probes = []
    for c in [c for c in cams if c["in_bbox"] and c["stream"]][: args.probe]:
        time.sleep(1.5)
        p = probe_hls(c["stream"])
        p["name"], p["source"] = c["name"], c["source"]
        probes.append(p)
        print(f"  스트림 {c['source']} {c['name']}: {p}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = OUT_DIR / f"cctv_check_{stamp}.json"
    out.write_text(json.dumps({
        "checked_at": stamp, "bbox": SIHEUNG_BBOX, "cameras": cams,
        "utic_meta": utic_sample, "hls_probes": probes,
    }, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    n_in = sum(c["in_bbox"] for c in cams)
    n_near = sum(c["in_bbox"] and c["nearest_m"] <= 300 for c in cams)
    print(f"\n시흥 범위 카메라 {n_in}대(출처 중복 포함), 중부권 스마트교차로 300m 안 {n_near}대. "
          f"결과: {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
