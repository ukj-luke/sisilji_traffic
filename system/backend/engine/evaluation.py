"""Paired, seeded experiment for one isolated, hypothetical four-phase junction.

The four FIFO point queues follow the movement order in the traffic console. A
cycle advances on a 1 s grid. Waiting is the area under each queue through the
fixed horizon, including vehicles still present. No travel time, acceleration,
physical storage, pedestrian calls, coordination or downstream propagation is
modelled. Parameters are scenario assumptions, not a calibrated field model.
"""
from __future__ import annotations

from bisect import bisect_left
import math
import random
from statistics import fmean, stdev

from .green_split import EngineConfig, GreenSplitController, Movement, MovementMeasure, Phase

MODEL_VERSION = "isolated-fifo-1s-v1"
CYCLE = 120
CLEARANCE = 5
PHASES = [
    Phase(key, (Movement(key, lanes=lanes),), plan_green=green, min_green=15, max_green=45)
    for key, lanes, green in [("P1", 2, 30), ("P2", 1, 20), ("P3", 2, 30), ("P4", 1, 20)]
]
PLAN = tuple(p.plan_green for p in PHASES)
METHODS = ("fixed", "tod", "adaptive")

# Two-sided 95% Student t critical values, df 1..29 (2..30 replications).
T975 = (0.0, 12.7062, 4.3027, 3.1824, 2.7764, 2.5706, 2.4469, 2.3646,
        2.3060, 2.2622, 2.2281, 2.2010, 2.1788, 2.1604, 2.1448, 2.1314,
        2.1199, 2.1098, 2.1009, 2.0930, 2.0860, 2.0796, 2.0739, 2.0687,
        2.0639, 2.0595, 2.0555, 2.0518, 2.0484, 2.0452)


def cycle_rng(seed, replication, cycle):
    """Stable cycle substream, independently replayable by the animation."""
    run_seed = (seed + replication) % (2**31)
    return random.Random(f"{MODEL_VERSION}/{run_seed}/{cycle}")


def generate_arrivals(rates, rng):
    """Four independent constant-rate Poisson streams in one 120 s cycle.

    Exponential gaps permit several arrivals in one second. We place all
    arrivals for a time bin at +0.25 s and service opportunities at +0.75 s.
    The same generated arrays are replayed unchanged in all three arms.
    """
    arrivals = []
    for rate in rates:
        times = []
        if rate > 0:
            t = rng.expovariate(rate / 3600)
            while t < CYCLE:
                times.append(math.floor(t) + 0.25)
                t += rng.expovariate(rate / 3600)
        arrivals.append(times)
    return arrivals


def _expected_profile(rates, cycles, profile):
    # Include each cycle intersecting the middle third of the horizon; for ten
    # cycles (1-based) this is 4..7. A single-cycle surge covers that one cycle.
    first = cycles // 3
    end = (2 * cycles + 2) // 3
    return [
        [rates[0] * 1.5, *rates[1:]] if profile == "surge" and first <= i < end else list(rates)
        for i in range(cycles)
    ]


def _arrival_profile(rates, expected_rates, seed, repeat):
    """Add an independent Poisson stream only to the stressed movement.

    Reusing the seed across profiles keeps the original arrivals identical,
    including in the stress window. The exogenous surge adds vehicles on top.
    """
    traffic = []
    run_seed = (seed + repeat) % (2**31)
    for cycle, expected in enumerate(expected_rates):
        arrivals = generate_arrivals(rates, cycle_rng(seed, repeat, cycle))
        extra_rate = expected[0] - rates[0]
        if extra_rate > 0:
            surge_rng = random.Random(f"{MODEL_VERSION}/{run_seed}/{cycle}/surge")
            extra = generate_arrivals([extra_rate], surge_rng)[0]
            arrivals[0] = sorted(arrivals[0] + extra)
        traffic.append(arrivals)
    return traffic


def _windows(greens):
    start = 0
    for green in greens:
        yield start, start + green
        start += green + CLEARANCE


def serve_cycle(initial, arrivals, greens, condition, *, window_starts=None):
    """Return sorted stop-line crossings, one per served vehicle, by movement.

    Initial vehicles head the FIFO. A scheduled service opportunity is lost if
    the head has not arrived yet. Straight greens have one aggregate slot per
    second; single-lane turns have one every two seconds. No new entry during
    intergreens or the first 2 s of green. Field replay can supply observed
    nonoverlapping green starts, already validated within the measured cycle.
    """
    departures = []
    windows = (_windows(greens) if window_starts is None else
               ((s, s + g) for s, g in zip(window_starts, greens, strict=True)))
    for i, (start, end) in enumerate(windows):
        crossed = []
        if not (condition == "blocked" and i == 0):
            movement = PHASES[i].movements[0]
            interval = int(movement.sat_headway / movement.lanes)
            startup = int(EngineConfig.startup_loss)
            for tick in range(start + startup + interval - 1, end, interval):
                slot = tick + 0.75
                head = len(crossed) - initial[i]
                if head < 0 or (head < len(arrivals[i]) and arrivals[i][head] <= slot):
                    crossed.append(slot)
        departures.append(crossed)
    return departures


def observe_cycle(initial, arrivals, greens, departures, condition):
    """Build the controller's input *after* observing this complete cycle."""
    measures = {}
    for i, (_, end) in enumerate(_windows(greens)):
        residual_at_green_end = initial[i] + bisect_left(arrivals[i], end) - len(departures[i])
        measures[PHASES[i].id] = MovementMeasure(
            arrivals=len(arrivals[i]), residual=residual_at_green_end,
            downstream_blocked=condition == "blocked" and i == 0,
            valid=not (condition == "missing" and i == 0),
        )
    return measures


def _tod_plan(rates):
    # One plan for the entire experiment. Apply the same bounded split rule to
    # the prescribed *mean* demand, without feedback or data from the test seeds.
    if not any(rates):
        return list(PLAN)
    offline = GreenSplitController(PHASES, EngineConfig(alpha=1))
    measures = {p.id: MovementMeasure(arrivals=rate * CYCLE / 3600) for p, rate in zip(PHASES, rates)}
    result = offline.step(measures)
    return [result.greens[p.id] for p in PHASES]


def _run(traffic, initial, method, tod, condition, *, adaptive_start=None):
    controller = GreenSplitController(PHASES) if method == "adaptive" else None
    greens = list(tod if method == "tod" else PLAN)
    if adaptive_start is not None:
        # The sensitivity arm changes only the starting green plan. The initial
        # queues and empty observation history match the primary adaptive arm.
        greens = list(adaptive_start)
        controller.current = {phase.id: green for phase, green in zip(PHASES, greens)}
    queue = list(initial)
    demanded = list(initial)
    served = [0] * 4
    wait = [0.0] * 4
    peak = sum(initial)
    queue_series = []
    for arrivals in traffic:
        departures = serve_cycle(queue, arrivals, greens, condition)
        if controller:
            # Observations from this cycle affect only the *next* green plan.
            observation = observe_cycle(queue, arrivals, greens, departures, condition)
            decision = controller.step(observation)
            greens = [decision.greens[p.id] for p in PHASES]
        events = [0] * (CYCLE * 2)
        before = sum(queue)
        for i in range(4):
            # Integral of Q(t): initial queue contributes T per vehicle, an
            # arrival adds T-a, a departure subtracts T-d. This carries waiting
            # through red, through multiple cycles and through the final cutoff.
            wait[i] += queue[i] * CYCLE
            for arrival in arrivals[i]:
                wait[i] += CYCLE - arrival
                events[int(arrival) * 2] += 1
            for departure in departures[i]:
                wait[i] -= CYCLE - departure
                events[int(departure) * 2 + 1] -= 1
            count = len(arrivals[i])
            releases = len(departures[i])
            queue[i] += count - releases
            demanded[i] += count
            served[i] += releases
        for change in events:
            before += change
            peak = max(peak, before)
        queue_series.append(sum(queue))
    total = sum(demanded)
    return {
        "wait_s": sum(wait) / total if total else None,
        "queue_vehicle_seconds": sum(wait),
        "served": sum(served),
        "end_queue": sum(queue),
        "peak_queue": peak,
        "cycle_end_queue": queue_series,
        "by_direction": [
            {"wait_s": wait[i] / count if count else None, "demand": count,
             "served": served[i], "end_queue": queue[i]}
            for i, count in enumerate(demanded)
        ],
    }


def _mean_present(values):
    present = [value for value in values if value is not None]
    return fmean(present) if present else None


def _summarize(runs):
    summary = {key: _mean_present(run[key] for run in runs)
               for key in ("wait_s", "served", "peak_queue", "end_queue")}
    summary["by_direction"] = [
        {key: _mean_present(run["by_direction"][i][key] for run in runs)
         for key in ("wait_s", "demand", "served", "end_queue")}
        for i in range(4)
    ]
    summary["cycle_end_queue"] = [fmean(values) for values in zip(*(r["cycle_end_queue"] for r in runs))]
    return summary


def _paired_summary(deltas):
    n = len(deltas)
    mean = fmean(deltas) if n else None
    interval = None
    if n >= 2:
        half_width = T975[n - 1] * stdev(deltas) / math.sqrt(n)
        interval = [mean - half_width, mean + half_width]
    return {"mean": mean, "ci95": interval, "n": n}


def _paired(adaptive, comparison):
    deltas = [a["wait_s"] - b["wait_s"] for a, b in zip(adaptive, comparison)
              if a["wait_s"] is not None and b["wait_s"] is not None]
    result = _paired_summary(deltas)
    return {"delta_wait_s": result["mean"], "ci95": result["ci95"], "n": result["n"]}


def _bounded_int(value, low, high):
    return type(value) is int and low <= value <= high


def evaluate(rates, initial, condition, cycles=10, replications=10, seed=42, profile="steady"):
    """Return replication means and paired adaptive-minus-baseline effects.

    The baseline is an assumed fixed plan. Time-of-day (TOD) uses one split
    based on the externally supplied mean rates across the full horizon,
    including the predeclared surge. The first adaptive cycle uses
    the baseline, then sees previous observations. Queue waiting is stopped at
    the common end of the observation period with no warm-up or draining.
    """
    if len(rates) != 4 or not all(_bounded_int(value, 0, 1800) for value in rates):
        raise ValueError("네 방향의 시간당 유입량은 0~1800 정수여야 합니다.")
    if len(initial) != 4 or not all(_bounded_int(value, 0, 1000) for value in initial):
        raise ValueError("네 방향의 초기 대기 차량은 0~1000 정수여야 합니다.")
    if condition not in ("normal", "missing", "blocked"):
        raise ValueError("지원하지 않는 시나리오 조건입니다.")
    if profile not in ("steady", "surge"):
        raise ValueError("지원하지 않는 시간대별 수요 변화입니다.")
    if not (_bounded_int(cycles, 1, 30) and _bounded_int(replications, 2, 30)
            and _bounded_int(seed, 0, 2**31 - 1)):
        raise ValueError("주기 수, 반복 횟수 또는 난수 시드가 허용 범위를 벗어났습니다.")
    expected = _expected_profile(rates, cycles, profile)
    tod_mean_rates = [fmean(values) for values in zip(*expected)]
    tod = _tod_plan(tod_mean_rates)
    experiments = {method: [] for method in METHODS}
    tod_start_runs = []
    records = []
    for repeat in range(replications):
        run_seed = (seed + repeat) % (2**31)
        traffic = _arrival_profile(rates, expected, seed, repeat)
        demand = sum(initial) + sum(len(group) for arrivals in traffic for group in arrivals)
        record = {"seed": run_seed, "demand": demand}
        for method in METHODS:
            run = _run(traffic, initial, method, tod, condition)
            experiments[method].append(run)
            record[f"{method}_wait_s"] = run["wait_s"]
        tod_start_runs.append(_run(traffic, initial, "adaptive", tod, condition, adaptive_start=tod))
        records.append(record)
    methods = {name: _summarize(runs) for name, runs in experiments.items()}
    differences = []
    for i, (a, b) in enumerate(zip(methods["adaptive"]["by_direction"], methods["tod"]["by_direction"])):
        if a["wait_s"] is not None and b["wait_s"] is not None:
            differences.append({"index": i, "delta_wait_s": a["wait_s"] - b["wait_s"]})
    # Positive = fewer vehicle-hours under primary adaptive than TOD. Integrate
    # within each paired run so demand and delay may vary together across seeds.
    saved_vehicle_hours = [
        (baseline["queue_vehicle_seconds"] - adaptive["queue_vehicle_seconds"]) / 3600
        for baseline, adaptive in zip(experiments["tod"], experiments["adaptive"])
    ]
    return {
        "model_version": MODEL_VERSION,
        "inputs": {"rates": list(rates), "initial": list(initial), "condition": condition,
                   "cycles": cycles, "replications": replications, "seed": seed, "profile": profile},
        "expected_rates_by_cycle": expected, "tod_mean_rates": tod_mean_rates,
        "plans": {"fixed": list(PLAN), "tod": tod}, "methods": methods,
        "paired": {f"vs_{name}": _paired(experiments["adaptive"], experiments[name]) for name in ("fixed", "tod")},
        "worst_direction": max(differences, key=lambda diff: diff["delta_wait_s"], default=None),
        "demand_mean": fmean(record["demand"] for record in records),
        "runs": records,
        "startup_sensitivity": {
            "initial_greens": tod,
            "warmup_cycles": 0,
            "adaptive_wait_s": _mean_present(run["wait_s"] for run in tod_start_runs),
            "vs_tod": _paired(tod_start_runs, experiments["tod"]),
            "primary_saved_vehicle_hours": _paired_summary(saved_vehicle_hours),
        },
    }
