"""고정형 교차로 CCTV의 720×480 RGB 프레임에서 자막 획과 고정물의 명암 특징을 추출합니다."""
import argparse
import base64
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

# 왼쪽 위 x, y와 너비, 높이는 기준 영상 픽셀 단위입니다.
REGIONS = [
    ("mokgamCaption", [10, 334, 112, 41], "white"),
    ("cityHallCaption", [570, 334, 143, 42], "white"),
    ("nameCaption", [281, 416, 158, 42], "yellow"),
    ("overheadSign", [236, 235, 68, 43], "fixture"),
    ("nearSignal", [591, 437, 66, 32], "fixture"),
    ("turnSignsAndSignal", [621, 417, 62, 34], "fixture"),
    ("upperStreetPlate", [579, 397, 37, 24], "fixture"),
    ("upperRightPlate", [689, 396, 30, 21], "fixture"),
    ("lowerRightPlate", [685, 410, 34, 35], "fixture"),
]
OFFSETS = [(2, 0), (-2, 0), (0, 2), (0, -2), (3, 3), (-3, 3),
           (3, -3), (-3, -3), (5, 0), (-5, 0), (0, 5), (0, -5)]


def edge_pairs(gray, ink):
    """4×4 격자마다 여러 프레임에서 일관되게 명암 차이가 큰 픽셀 쌍 하나를 고릅니다."""
    _, h, w = gray.shape
    pairs = bytearray()
    for y in range(2, h - 2, 4):
        for x in range(2, w - 2, 4):
            best = None
            for py in range(y - 1, min(y + 3, h)):
                for px in range(x - 1, min(x + 3, w)):
                    if ink is not None and not ink[py, px]:
                        continue
                    for dx, dy in OFFSETS:
                        qx, qy = px + dx, py + dy
                        if not (0 <= qx < w and 0 <= qy < h) or (ink is not None and ink[qy, qx]):
                            continue
                        delta = gray[:, py, px] - gray[:, qy, qx]
                        low, high = (delta.min(), delta.max()) if ink is None else np.percentile(delta, [12, 88])
                        strength = low if low > 0 else -high
                        if strength < (65 if ink is not None else 13) or (best and strength <= best[0]):
                            continue
                        points = [px, py, qx, qy] if low > 0 else [qx, qy, px, py]
                        best = strength, points + [round(max(6, min(45, strength * .30)))]
            if best:
                pairs.extend(best[1])
    if len(pairs) < 25:
        raise ValueError("기준 프레임에서 고정물의 명암 특징을 충분히 찾을 수 없습니다.")
    return base64.b64encode(pairs).decode()


# 주간 영상에서는 표지판과 노면 표시의 테두리만 대조합니다.
# 각 항목은 허용할 검출 상자 영역, 특징을 구할 영역, 물체 중심부 순서입니다.
DAY_FIXTURES = [
    ("dayOverheadSign", [239, 228, 76, 55], [249, 247, 56, 30], [252, 253, 47, 16]),
]


# 도색의 외곽과 주변 아스팔트가 드러난 프레임을 사용합니다.
PAINT_CORES = [
    ("outerDiamond", [204, 173, 11, 10]),
    ("middleDiamond", [225, 170, 9, 9]),
    ("innerDiamond", [243, 168, 11, 9]),
    ("outerArrow", [221, 211, 8, 14]),
    ("middleArrow", [247, 211, 8, 10]),
    ("innerArrow", [269, 205, 10, 13]),
]


POLICE_FIXTURES = [
    ("gunjaCaption", [7, 336, 108, 33], "white"),
    ("signal", [330, 235, 31, 29], "fixture"),
    ("innerLamp", [195, 174, 24, 16], "fixture"),
    ("outerLamp", [176, 192, 22, 16], "fixture"),
]
POLICE_SIGN = [("policeOverheadSign", [185, 204, 122, 67], [203, 214, 91, 43], [206, 220, 83, 32])]
SCENE_PAINT = {
    "gits-6581": PAINT_CORES,
    "gits-6578": [("outerDiamond", [237, 28, 10, 10]), ("innerDiamond", [256, 27, 10, 10]),
                  ("roadCover", [405, 264, 36, 21])],
    "gits-6590": [("diamond1", [142, 182, 10, 8]), ("diamond2", [164, 178, 13, 9]),
                  ("diamond3", [185, 174, 15, 10]), ("diamond4", [213, 171, 14, 9]),
                  ("diamond5", [236, 168, 15, 9])],
}


# 군자동 접근로와 맞은편 도색이 모두 드러난 야간 프레임에서 추출합니다.
POLICE_NIGHT_ROAD = SCENE_PAINT["gits-6590"] + [
    ("outerLaneDash", [149, 174, 9, 7]),
    ("middleLaneDash", [176, 176, 9, 8]),
    ("nearOuterDash", [159, 184, 10, 9]),
    ("nearMiddleDash", [189, 187, 10, 9]),
    ("nearStraightDash", [202, 198, 13, 11]),
    ("oppositeLaneDash", [248, 184, 10, 9]),
    ("outerArrow", [151, 165, 13, 11]),
    ("middleDash", [165, 164, 8, 8]),
    ("innerArrow", [173, 162, 14, 10]),
    ("upstreamDash", [148, 151, 5, 5]),
    # 차로 위로 돌출된 가로등은 도색 바로 옆에서 차체처럼 보입니다.
    ("outerLamp", [176, 194, 16, 11]),
]


# E·F 차로 경계에서 보이는 신호등 뒷면과 그 주위 노면을 함께 비교합니다.
POLICE_SIGNAL = [("yeonseongSignalHousing", [352, 244, 30, 17])]


def calibrate(paths, *, daylight=False, road_paint=False, night_road=False, signal_housing=False, camera="gits-6581"):
    if signal_housing and camera != "gits-6590":
        raise ValueError("이 신호등 기준은 시흥경찰서사거리 전용입니다.")
    if night_road and camera != "gits-6590":
        raise ValueError("야간 노면 기준은 시흥경찰서사거리에 등록되어 있습니다.")
    if camera == "gits-6578" and not road_paint:
        raise ValueError("월곶교차로에는 노면 보정값만 등록되어 있습니다.")
    frames = []
    for path in paths:
        with Image.open(path) as image:
            if image.size != (720, 480):
                raise ValueError(f"{path}: 720×480 기준 프레임이 필요합니다.")
            frames.append(np.asarray(image.convert("RGB")))
    frames = np.array(frames, dtype=np.float32)
    result = []
    if road_paint or night_road or signal_housing:
        patterns, pad = SCENE_PAINT[camera], 7
        if night_road:
            patterns, pad = POLICE_NIGHT_ROAD, 9
        elif signal_housing:
            patterns, pad = POLICE_SIGNAL, 17
        for name, core in patterns:
            x, y, w, h = core
            patches = frames[:, y-pad:y+h+pad, x-pad:x+w+pad]
            gray = np.median(patches @ np.array([.299, .587, .114]), axis=0)
            result.append({"name": name, "core": core, "padding": pad,
                           "gray": base64.b64encode(gray.round().astype("uint8").tobytes()).decode()})
        return result
    if daylight:
        for name, rect, features, core in (POLICE_SIGN if camera == "gits-6590" else DAY_FIXTURES):
            x, y, w, h = features
            rgb = frames[:, y:y+h, x:x+w]
            gray = rgb @ np.array([.299, .587, .114])
            pairs = bytearray(base64.b64decode(edge_pairs(gray, None)))
            for i in range(0, len(pairs), 5):
                for j in (0, 2):
                    pairs[i+j] += x - rect[0]
                    pairs[i+j+1] += y - rect[1]
            result.append({"name": name, "rect": rect, "core": core,
                           "edges": base64.b64encode(pairs).decode()})
        return result
    for name, rect, kind in (POLICE_FIXTURES if camera == "gits-6590" else REGIONS):
        x, y, w, h = rect
        rgb = frames[:, y:y+h, x:x+w]
        gray = .299 * rgb[..., 0] + .587 * rgb[..., 1] + .114 * rgb[..., 2]
        ink = None
        entry = {"name": name, "rect": rect}
        if kind != "fixture":
            median = np.median(rgb, axis=0)
            if kind == "white":
                ink = (median.min(axis=-1) > 153) & (np.ptp(median, axis=-1) < 42)
            else:
                rg = np.minimum(median[..., 0], median[..., 1])
                ink = (rg > 153) & (rg - median[..., 2] > 74)
            ink &= np.percentile(gray, 85, axis=0) - np.percentile(gray, 15, axis=0) < 37
        entry["edges"] = edge_pairs(gray, ink)
        if name == "nearSignal":
            entry["core"] = [595, 441, 34, 22]
        if ink is not None:
            outline = Image.fromarray(ink.astype("uint8") * 255).filter(ImageFilter.MaxFilter(7))
            bits = np.packbits(np.asarray(outline).ravel() > 0)
            entry["strokes"] = base64.b64encode(bits.tobytes()).decode()
        result.append(entry)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("frames", type=Path, nargs="+")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--camera", choices=list(SCENE_PAINT), default="gits-6581")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--road-paint", action="store_true", help="노면표시와 주변 노면의 기준 무늬를 생성합니다.")
    mode.add_argument("--night-road", action="store_true", help="시흥경찰서사거리 야간 도색·가로등과 주변 노면의 기준 무늬를 생성합니다.")
    mode.add_argument("--signal-housing", action="store_true", help="E·F 차로 사이 신호등과 주변 도로의 기준 무늬를 생성합니다.")
    mode.add_argument("--daylight", action="store_true", help="주간 고정물 보정값만 생성합니다.")
    args = parser.parse_args()
    args.output.write_text(json.dumps(calibrate(args.frames, daylight=args.daylight, road_paint=args.road_paint, night_road=args.night_road, signal_housing=args.signal_housing, camera=args.camera), indent=2) + "\n")
