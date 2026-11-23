"""Reproduce the Dundae measured-count experiment with python -m system.backend.dundae_case.

Public survey direction numbers are preserved. Grouping those numbers into phases,
lane counts and saturation flow are assumptions in the sensitivity cases.
"""
from __future__ import annotations

import argparse
from bisect import bisect_left
from dataclasses import dataclass
import json
import math
from pathlib import Path
import random
from statistics import fmean

from .engine.evaluation import _paired_summary
from .engine.green_split import EngineConfig, GreenSplitController, Movement, MovementMeasure, Phase


CASES_DIR = Path(__file__).resolve().parents[1] / "data"
SURVEY = CASES_DIR / "dundae-survey.json"
RESULTS = CASES_DIR / "dundae-results.json"
CODES = tuple(str(n) for n in range(1, 13))
SEEDS = range(42, 62)
QUARTER = 900
CYCLE = 180
CYCLES_PER_HOUR = 3600 // CYCLE
STARTUP = 2.0
HEADWAY = 2.0
LIMIT = 10
GROUPS = ((1, 7), (2, 8), (3, 9), (4, 10), (5, 6, 11, 12))
SCENARIOS = {
    "A": (GROUPS, 4),
    "B": ((GROUPS[0], GROUPS[3], GROUPS[2], GROUPS[1], GROUPS[4]), 4),
    "C": (GROUPS, 3),
    "D": (GROUPS, None),
}


def assumed_lanes(trunk_lanes):
    return {code: trunk_lanes if code in ("2", "8") else (2 if code == "10" else 1) for code in CODES}


def estimate_lanes(groups, plan, warm_counts):
    """Minimum integer equivalent lanes for each code to serve every 07:00 quarter.

    A quarter contains five full cycles at the fixed plan. For each direction,
    use the largest warm-up quarter and round its required slots per cycle up.
    No 08:00–09:00 counts enter this estimate.
    """
    counts = {}
    for codes, green in zip(groups, plan, strict=True):
        for code in map(str, codes):
            slots_needed = math.ceil(max(warm_counts[code]) / (QUARTER // CYCLE))
            counts[code] = max(1, math.ceil(slots_needed * HEADWAY / (green - STARTUP)))
    return counts


def check_capacity(phases, warm_counts, peak_counts):
    capacities = {movement.id: (QUARTER // CYCLE) * math.floor(
        (phase.plan_green - STARTUP) * movement.lanes / movement.sat_headway)
        for phase in phases for movement in phase.movements}

    def exceedances(counts):
        return [{"code": code, "quarter": q, "count": observed, "capacity": capacities[code]}
                for code in CODES for q, observed in enumerate(counts[code]) if observed > capacities[code]]

    peak = exceedances(peak_counts)
    return {"slotsPerQuarterByCode": capacities, "warmExceedances": exceedances(warm_counts),
            "peakExceedances": peak, "peakExcessVehicles": sum(v["count"] - v["capacity"] for v in peak)}


def make_phases(groups, lanes, plan):
    phases = []
    for index, (codes, green) in enumerate(zip(groups, plan, strict=True), 1):
        moves = tuple(Movement(str(code), lanes[str(code)], HEADWAY) for code in codes)
        phases.append(Phase(f"P{index}", moves, green, green - LIMIT, green + LIMIT))
    return phases


def arrivals_for_hour(counts, rng):
    """Condition on each of the 48 measured counts, then sample arrival instants.

    Times within each cycle are seconds since the start of that cycle. This
    realization is generated once and replayed in both arms and all scenarios.
    """
    traffic = [{code: [] for code in CODES} for _ in range(CYCLES_PER_HOUR)]
    if set(counts) != set(CODES):
        raise ValueError("교통량 표의 진행방향 코드가 1~12여야 합니다.")
    for code in CODES:
        if len(counts[code]) != 4:
            raise ValueError("각 진행방향에 15분 단위 교통량 4개가 필요합니다.")
        for quarter, count in enumerate(counts[code]):
            if type(count) is not int or count < 0:
                raise ValueError("15분 교통량은 0 이상의 정수여야 합니다.")
            for offset in sorted(rng.random() * QUARTER for _ in range(count)):
                cycle, local_time = divmod(offset, CYCLE)
                traffic[quarter * (QUARTER // CYCLE) + int(cycle)][code].append(local_time)
    return traffic


def service_times(initial, arrivals, green_start, green_end, movement):
    """Use one capacity slot per complete aggregate headway, at its midpoint.

    Slot times fall strictly inside the usable green. Slots offered to an empty
    queue expire. Vehicles already in the queue precede new arrivals.
    """
    effective_start = green_start + STARTUP
    headway = movement.sat_headway / movement.lanes
    slots = max(0, math.floor((green_end - effective_start) / headway + 1e-9))
    departures = []
    for i in range(slots):
        slot = effective_start + (i + 0.5) * headway
        head = len(departures) - initial
        if head < 0 or (head < len(arrivals) and arrivals[head] <= slot):
            departures.append(slot)
    return departures


@dataclass
class CycleResult:
    queues: dict[str, int]
    served: dict[str, int]
    measures: dict[str, MovementMeasure]
    queue_seconds: float


def run_cycle(traffic, initial, phases, greens, yellows):
    queues = {}
    served = {}
    measures = {}
    queue_seconds = 0.0
    start = 0
    for phase, green, yellow in zip(phases, greens, yellows, strict=True):
        end = start + green
        for movement in phase.movements:
            code = movement.id
            arrivals = traffic[code]
            departures = service_times(initial[code], arrivals, start, end, movement)
            served[code] = len(departures)
            queues[code] = initial[code] + len(arrivals) - served[code]
            residual_at_green_end = initial[code] + bisect_left(arrivals, end) - served[code]
            measures[code] = MovementMeasure(len(arrivals), residual_at_green_end)
            # Each vehicle contributes from arrival (or cycle start for existing
            # queues) until departure (or cut-off). No post-09:00 drain.
            queue_seconds += initial[code] * CYCLE + sum(CYCLE - t for t in arrivals)
            queue_seconds -= sum(CYCLE - t for t in departures)
        start = end + yellow
    if start != CYCLE:
        raise ValueError(f"신호 합계 {start}초가 실험 주기 {CYCLE}초와 다릅니다.")
    return CycleResult(queues, served, measures, queue_seconds)


def warm_up(traffic, phases, yellows):
    queue = dict.fromkeys(CODES, 0)
    greens = [p.plan_green for p in phases]
    for cycle in traffic:
        queue = run_cycle(cycle, queue, phases, greens, yellows).queues
    return queue


def run_peak(traffic, phases, yellows, initial, *, adaptive):
    """Start both arms at 08:00 with the fixed plan and a common 07:00–08:00 history."""
    greens = [p.plan_green for p in phases]
    controller = GreenSplitController(phases, EngineConfig(startup_loss=STARTUP, max_change=LIMIT)) if adaptive else None
    queue = dict(initial)
    by_code = []
    green_series = []
    served_series = []
    served = dict.fromkeys(CODES, 0)
    arrivals = dict.fromkeys(CODES, 0)
    area = 0.0
    max_error = 0
    for cycle in traffic:
        green_series.append(greens)
        step = run_cycle(cycle, queue, phases, greens, yellows)
        queue = step.queues
        for code in CODES:
            arrivals[code] += len(cycle[code])
            served[code] += step.served[code]
            max_error = max(max_error, abs(initial[code] + arrivals[code] - served[code] - queue[code]))
        by_code.append([queue[code] for code in CODES])
        served_series.append(sum(step.served.values()))
        area += step.queue_seconds
        if controller:
            decision = controller.step(step.measures)
            greens = [decision.greens[p.id] for p in phases]
    if max_error:
        raise ArithmeticError("방향별 도착·통과·잔류 대수 보존 검증 실패")
    return {
        "startQueue": sum(initial.values()), "arrivals": sum(arrivals.values()),
        "served": sum(served.values()), "endQueue": sum(queue.values()),
        "meanQueue": area / (len(traffic) * CYCLE), "startQueueByCode": dict(initial),
        "endQueueByCode": queue, "cycleEndQueue": [sum(row) for row in by_code],
        "cycleServed": served_series, "cycleEndByCode": by_code, "cycleGreens": green_series,
        "maxAbsConservationError": max_error,
    }


def summarize(runs):
    out = {key: fmean(run[key] for run in runs)
           for key in ("startQueue", "arrivals", "served", "endQueue", "meanQueue")}
    for key in ("startQueueByCode", "endQueueByCode"):
        out[key] = {code: fmean(run[key][code] for run in runs) for code in CODES}
    for key in ("cycleEndQueue", "cycleServed"):
        out[key] = [fmean(column) for column in zip(*(run[key] for run in runs), strict=True)]
    for key in ("cycleGreens", "cycleEndByCode"):
        out[key] = [[fmean(column) for column in zip(*rows, strict=True)]
                    for rows in zip(*(run[key] for run in runs), strict=True)]
    return out


def experiment(survey, *, include_runs=False):
    plan, yellow = survey["greenSeconds"], survey["yellowSeconds"]
    hourly = survey["hourly"]
    prior = hourly[survey["priorHour"]]["quarterCountsByDirection"]
    peak = hourly[survey["peakHour"]]["quarterCountsByDirection"]
    draws = []
    for seed in SEEDS:
        rng = random.Random(seed)
        draws.append((arrivals_for_hour(prior, rng), arrivals_for_hour(peak, rng)))

    scenarios = {}
    for key, (groups, trunk_lanes) in SCENARIOS.items():
        lanes = assumed_lanes(trunk_lanes) if trunk_lanes is not None else estimate_lanes(groups, plan, prior)
        phases = make_phases(groups, lanes, plan)
        runs = {"fixed": [], "adaptive": []}
        for warm_traffic, peak_traffic in draws:
            initial = warm_up(warm_traffic, phases, yellow)
            for method in runs:
                runs[method].append(run_peak(peak_traffic, phases, yellow, initial, adaptive=method == "adaptive"))
        paired = {}
        for metric in ("served", "endQueue", "meanQueue"):
            differences = [a[metric] - f[metric] for a, f in zip(runs["adaptive"], runs["fixed"], strict=True)]
            paired[metric] = _paired_summary(differences)
        scenarios[key] = {
            "phaseCodes": groups, "lanesByCode": lanes, "capacityCheck": check_capacity(phases, prior, peak),
            "fixed": summarize(runs["fixed"]),
            "adaptive": summarize(runs["adaptive"]), "paired": paired,
            "checks": {"maxAbsConservationError": max(run["maxAbsConservationError"]
                                                      for method in runs.values() for run in method)},
        }
        if include_runs:
            scenarios[key]["runs"] = [{"seed": seed, "fixed": f, "adaptive": a}
                                      for seed, f, a in zip(SEEDS, runs["fixed"], runs["adaptive"], strict=True)]
    return {
        "modelVersion": "dundae-point-queue-v1", "surveyDate": survey["surveyDate"],
        "assumptions": {
            "codeOrder": CODES, "model": "per-code FIFO point queues",
            "warmup": "07:00–08:00 measured counts, fixed plan, zero queues at 07:00",
            "evaluation": "08:00–09:00 common warm-up queue and fixed initial plan; no drain",
            "arrivals": "Independent uniform instants per measured quarter and code, exact counts",
            "controller": "GreenSplitController, alpha=0.5, beta=0.5, feedback from preceding cycle only",
            "service": "One slot at the midpoint of each complete aggregate headway after startup loss",
            "greenEndResidual": "Queue immediately before end of green excludes arrivals at the boundary",
            "phaseAndLanes": "Scenario assumptions; field code-to-phase mapping and lane counts unverified",
            "capacityCheck": "Fixed-plan saturated slots per code per 15 min; five complete 180 s cycles",
            "scenarioD": "Minimum whole equivalent lanes per code covering every 07:00 quarter under scenario A phase assignments",
            "cycleSeconds": CYCLE, "cyclesPerHour": CYCLES_PER_HOUR, "startupSeconds": STARTUP,
            "saturationHeadwaySecondsPerLane": HEADWAY, "allRedSeconds": 0, "greenChangeLimitSeconds": LIMIT,
            "seeds": list(SEEDS), "treatmentDifference": "adaptive minus fixed",
            "ci95": "paired Student t interval over within-quarter random arrival draws only",
        },
        "scenarios": scenarios,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--survey", type=Path, default=SURVEY)
    parser.add_argument("--output", type=Path, default=RESULTS)
    parser.add_argument("--include-runs", action="store_true", help="Include full per-seed runs in output")
    args = parser.parse_args()
    data = experiment(json.loads(args.survey.read_text(encoding="utf-8")), include_runs=args.include_runs)
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
