"""경기도교통정보센터(GITS) 오픈API 키로 시흥 중부권 자료가 받아지는지 확인한다.

사용법 (저장소 루트에서):
    python3 system/api_check/check_gits_api.py

system/.env 의 GITS_API_KEY를 쓴다. API마다 한 번씩만 부르고 요청 사이에 1초를 쉰다.
GITS 오픈API는 돌발, 도로와 링크 소통(속도, 교통량, 혼잡), 주차장 정보를 주고 CCTV는 주지 않는다.
결과는 system/api_check/out/ 에 저장하며 Git에 올리지 않는다.
"""

from __future__ import annotations

import collections
import json
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_cctv_api import OUT_DIR, ROOT, SYSTEM_DIR, curl_get, in_bbox, load_env  # noqa: E402

BASE = "https://openapigits.gg.go.kr/api/rest/"

# 중부권 6개 행정동의 교차로와 지명. 링크 시작, 종료 노드 이름에서 찾는다.
MIDDLE_KEYWORDS = (
    "물왕", "목감", "논곡", "하중", "월곶", "장곡", "시흥경찰서", "마전", "상곡", "거모", "군자",
    "능곡", "연성", "관곡지", "나분들", "봉화로", "수질보건센터", "조남", "산현", "장현", "광석",
    "하상", "둔대", "포동사거리",
)


def call(name: str, key: str, **params: str) -> tuple[str, str, list[dict]]:
    code, body = curl_get(BASE + name, {"serviceKey": key, **params}, timeout=60)
    if code != 200:
        return str(code), f"HTTP {code}", []
    root = ET.fromstring(body)
    header_cd = root.findtext(".//headerCd", default="?")
    header_msg = root.findtext(".//headerMsg", default="")
    items = [{c.tag: (c.text or "").strip() for c in it} for it in root.iter("itemList")]
    return header_cd, header_msg, items


def middle_match(item: dict) -> bool:
    names = item.get("startNodeNm", "") + " " + item.get("endNodeNm", "")
    return any(k in names for k in MIDDLE_KEYWORDS)


def main() -> int:
    key = load_env(SYSTEM_DIR / ".env").get("GITS_API_KEY", "")
    if not key:
        print("system/.env 에 GITS_API_KEY를 넣어 주세요.")
        return 1

    summary: dict[str, dict] = {}

    def record(name: str, cd: str, msg: str, items: list[dict], **extra) -> None:
        summary[name] = {"headerCd": cd, "headerMsg": msg, "count": len(items), **extra}
        print(f"[{name}] 결과코드 {cd} {msg} / {len(items)}건")

    cd, msg, items = call("getIncidentInfo", key)
    siheung = []
    for it in items:
        try:
            if in_bbox(float(it.get("coord_x", "")), float(it.get("coord_y", ""))):
                siheung.append(it)
        except ValueError:
            pass
    record("getIncidentInfo", cd, msg, items, siheung=siheung)
    for it in siheung:
        print(f"    시흥 범위 돌발: {it.get('inciDesc')}")
    time.sleep(1)

    cd, msg, roads = call("getRoadInfoList", key)
    rank = collections.Counter(r.get("roadRank") for r in roads)
    record("getRoadInfoList", cd, msg, roads, by_rank=dict(rank))
    print(f"    도로 등급별 {dict(rank)} (103 일반국도, 105 국지도, 106 지방도, 107 시군도)")
    time.sleep(1)

    cd, msg, links = call("getRoadTrafficInfoList", key)
    unique = {l.get("linkId"): l for l in links}
    mid = [l for l in unique.values() if middle_match(l)]
    with_vol = [l for l in mid if l.get("vol") not in ("", "0", None)]
    with_spd = [l for l in mid if l.get("spd") not in ("", "0", None)]
    all_vol = sum(1 for l in unique.values() if l.get("vol") not in ("", "0", None))
    record("getRoadTrafficInfoList", cd, msg, links, unique_links=len(unique), links_with_vol=all_vol,
           middle_links=len(mid), middle_links_with_spd=len(with_spd), middle_links_with_vol=len(with_vol),
           middle_links_all=mid)
    latest = max((l.get("collDate", "") for l in links), default="")
    print(f"    고유 링크 {len(unique)}개(교통량 값이 있는 링크 {all_vol}개), 가장 최근 수집시각 {latest}")
    print(f"    중부권 지명이 들어간 링크 {len(mid)}개: 속도 값 {len(with_spd)}개, 교통량 값 {len(with_vol)}개")
    for l in with_vol:
        print(f"    교통량 있음: {l.get('routeNm', '')} {l.get('startNodeNm')} -> {l.get('endNodeNm')}: "
              f"속도 {l.get('spd')}km/h, 교통량 {l.get('vol')}, 혼잡 {l.get('congGrade')}, {l.get('collDate')}")
    for l in [l for l in with_spd if any(k in l.get('startNodeNm', '') for k in ('물왕', '목감', '논곡', '하중'))][:10]:
        print(f"    예: {l.get('routeNm', '')} {l.get('startNodeNm')} -> {l.get('endNodeNm')}: "
              f"속도 {l.get('spd')}km/h, 혼잡 {l.get('congGrade')}, {l.get('collDate')}")
    time.sleep(1)

    cd, msg, congest = call("getRoadLinkCongestInfo", key)
    mid_c = [l for l in congest if middle_match(l)]
    record("getRoadLinkCongestInfo", cd, msg, congest, middle_links=len(mid_c))
    time.sleep(1)

    cd, msg, parks = call("getParkingPlaceInfoList", key)
    by_lae = collections.Counter(p.get("laeNm") for p in parks)
    record("getParkingPlaceInfoList", cd, msg, parks, siheung=by_lae.get("시흥시", 0), by_lae=dict(by_lae))
    print(f"    지자체별 {dict(by_lae)}")
    time.sleep(1)

    cd, msg, avail = call("getParkingPlaceAvailabilityInfoList", key)
    record("getParkingPlaceAvailabilityInfoList", cd, msg, avail,
           siheung=sum(1 for p in avail if p.get("laeNm") == "시흥시"))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"gits_check_{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n결과: {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
