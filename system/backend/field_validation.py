"""Compare independent observed cycles with the same FIFO model used for policy evaluation."""
import csv
from io import StringIO
import math

from .engine.evaluation import CLEARANCE, CYCLE, serve_cycle

FIELDS = ("cycle", "phase", "green_s", "start_queue", "arrival_times_s", "observed_passed", "end_queue")
TIMING_FIELDS = ("cycle_s", "green_start_s")


def _integer(row, key, low, high):
    value = row[key].strip()
    if not value.isascii() or not value.isdecimal() or not low <= int(value) <= high:
        raise ValueError(f"{key} 값은 {low}~{high} 사이 정수여야 합니다.")
    return int(value)


def validate_field_csv(contents):
    reader = csv.DictReader(StringIO(contents.lstrip("\ufeff")), strict=True)
    columns = sorted(reader.fieldnames or [])
    measured_timing = columns == sorted(FIELDS + TIMING_FIELDS)
    if not measured_timing and columns != sorted(FIELDS):
        raise ValueError("기본 열을 확인하세요. " + ", ".join(FIELDS)
                         + ". 현장 시각을 입력할 때는 cycle_s와 green_start_s 두 열을 함께 넣으세요.")
    groups = {}
    for row in reader:
        try:
            if None in row or any(v is None for v in row.values()):
                raise ValueError("누락되거나 추가된 열이 있습니다.")
            cycle = row["cycle"].strip()
            if not cycle or len(cycle) > 80:
                raise ValueError("cycle에는 80자 이내 관측 주기 식별자가 필요합니다.")
            phase = _integer(row, "phase", 1, 4) - 1
            duration = _integer(row, "cycle_s", 30, 300) if measured_timing else CYCLE
            green_start = _integer(row, "green_start_s", 0, duration - 1) if measured_timing else None
            green = _integer(row, "green_s", 1, duration - green_start if measured_timing else 97)
            start = _integer(row, "start_queue", 0, 10000)
            passed = _integer(row, "observed_passed", 0, 10000)
            end = _integer(row, "end_queue", 0, 10000)
            times = row["arrival_times_s"].strip()
            arrivals = []
            if times:
                try:
                    arrivals = [float(t.strip()) for t in times.split(";")]
                except ValueError:
                    raise ValueError("도착 시각을 초 단위 숫자로 입력하고 세미콜론으로 구분하세요.") from None
            if len(arrivals) > 500 or any(not math.isfinite(t) or not 0 <= t < duration for t in arrivals):
                raise ValueError(f"도착 시각은 0초 이상 {duration}초 미만이며 방향당 최대 500대입니다.")
            if start + len(arrivals) != passed + end:
                raise ValueError("시작 대수 + 도착 대수와 통과 대수 + 종료 대수가 다릅니다.")
            cycle_duration, phases = groups.setdefault(cycle, (duration, {}))
            if duration != cycle_duration:
                raise ValueError(f"{cycle}의 네 행은 cycle_s가 같아야 합니다.")
            if phase in phases:
                raise ValueError("같은 주기의 방향 번호가 중복되었습니다.")
            phases[phase] = green, start, sorted(arrivals), passed, end, green_start
            if len(groups) > 200:
                raise ValueError("한 파일에 최대 200주기까지 대조할 수 있습니다.")
        except ValueError as exc:
            raise ValueError(f"{reader.line_num}행 · {exc}") from exc
    if not groups:
        raise ValueError("헤더 다음에 관측값을 입력하세요.")
    details = []
    abs_error = [0] * 4
    signed_error = [0] * 4
    for cycle, (duration, phases) in groups.items():
        if len(phases) != 4:
            raise ValueError(f"{cycle} 주기에 네 방향이 모두 필요합니다.")
        green, initial, arrivals, passed, end, starts = zip(*(phases[i] for i in range(4)))
        if measured_timing:
            windows = sorted((s, s + g) for s, g in zip(starts, green))
            if any(previous[1] > following[0] for previous, following in zip(windows, windows[1:])):
                raise ValueError(f"{cycle} 주기에 겹치는 녹색 구간이 있습니다.")
        else:
            if sum(green) != 100:
                raise ValueError(f"{cycle} 주기의 네 녹색시간 합이 100초여야 합니다.")
            starts = tuple(sum(green[:i]) + i * CLEARANCE for i in range(4))
        exits = serve_cycle(initial, arrivals, green, "normal", window_starts=starts)
        for i, departures in enumerate(exits):
            predicted = initial[i] + len(arrivals[i]) - len(departures)
            error = predicted - end[i]
            abs_error[i] += abs(error)
            signed_error[i] += error
            details.append({"cycle": cycle, "phase": i + 1, "cycle_s": duration,
                            "green_start_s": starts[i], "green_s": green[i], "observed_end": end[i],
                            "predicted_end": predicted, "observed_passed": passed[i],
                            "predicted_passed": len(departures), "error": error})
    n = len(groups)
    return {"cycles": n, "timing_source": "observed_windows" if measured_timing else "assumed_120s",
            "queue_mae": sum(abs_error) / (4 * n),
            "direction_mae": [v / n for v in abs_error], "direction_bias": [v / n for v in signed_error],
            "rows": details}
