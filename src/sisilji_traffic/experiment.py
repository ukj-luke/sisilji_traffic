"""Offline closed-loop evaluation with a separate, non-oracle planning path.

The planner never receives a scenario name, realized seed or future requests.
Each evaluated policy evolves in its own SUMO process from the same exogenous
departure requests. A SUMO snapshot is the explicitly labelled full-state
initialization assumption, not something reconstructed from real CCTV.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import csv
import hashlib
import html
import json
import math
from pathlib import Path
import random
from statistics import fmean, stdev
import time
from typing import Any

from .planner import (
    CandidateEvaluation, CycleObservation, SampleMetrics, SignalConfig,
    TrafficState, generate_candidates, recommend, select_candidates,
    state_quality_errors,
)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
                    encoding="utf-8")


def content_hash(value: Any) -> str:
    value = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(value.encode()).hexdigest()


def traffic_state(raw: dict[str, Any]) -> TrafficState:
    raw = dict(raw)
    cycles = []
    for item in (raw.pop("cycles", ()) or ()):
        if isinstance(item, CycleObservation):
            cycles.append(item)
            continue
        item = dict(item)
        for key in ("inflow", "residual_queues", "green_no_discharge"):
            value = item.get(key)
            item[key] = tuple(value) if isinstance(value, (list, tuple)) else (None,) * 4
        if item.get("queues_end") is not None:
            item["queues_end"] = tuple(item["queues_end"])
        cycles.append(CycleObservation(**item))
    for key in ("queues", "capacities", "downstream_counts", "downstream_capacities"):
        value = raw.get(key)
        raw[key] = tuple(value) if isinstance(value, (list, tuple)) else (None,) * 4
    return TrafficState(**raw, cycles=tuple(cycles))


def sample_metrics(raw: dict[str, Any], sample_id: str) -> SampleMetrics:
    return SampleMetrics(
        sample_id=sample_id, objective_j=raw["objective_j"],
        terminal_vehicles=raw["terminal_vehicles"],
        terminal_uninserted=raw["terminal_uninserted"],
        terminal_queues=tuple(raw["terminal_queues"]),
        teleports=raw["teleports"], collisions=raw["collisions"],
    )


def planning_departures(rates: dict[str, float], start: int, end: int,
                        seed: int, scale: float, prefix: str):
    """Generate future requests solely from observed rates and a planning RNG.

    This function accepts neither a realized demand list nor its scenario/seed.
    Known active vehicle routes are retained in the full-state snapshot.
    """
    from .demand import Departure

    if start >= end or any(not math.isfinite(v) or v < 0 for v in rates.values()):
        raise ValueError("Invalid planning interval or observed rate")
    rng = random.Random(seed)
    result = []
    for route_id in sorted(rates):
        rate = rates[route_id] * scale
        if rate <= 0:
            continue
        at = float(start)
        while True:
            at += rng.expovariate(rate)
            if at >= end:
                break
            t = max(start, int(at))
            result.append(Departure(time=t, route_id=route_id,
                                    vehicle_id=f"{prefix}_{len(result):06d}"))
    return sorted(result, key=lambda x: (x.time, x.vehicle_id))


def evaluate_cutoff(network, snapshot: Path, state: TrafficState,
                    rates: dict[str, float], workdir: Path, *, planning_seed: int,
                    diagnostic_filter: bool, deadline_seconds: float = 20,
                    full_search: bool = False, horizon_cycles: int = 2) -> dict[str, Any]:
    """One decision; no actual future argument exists at this boundary."""
    from .simulation import Simulator

    config = SignalConfig()
    started = time.perf_counter()
    if horizon_cycles < 2:
        raise ValueError("A candidate cycle and following reference cycle are required")
    cutoff = int(state.observed_at)
    boundary = (cutoff // config.cycle_seconds + 1) * config.cycle_seconds
    end = boundary + horizon_cycles * config.cycle_seconds
    candidates = (generate_candidates(config) if full_search else
                  select_candidates(state, config, diagnostic_filter=diagnostic_filter))
    plan_samples = []
    sample_manifest = []
    # Same nine futures for every candidate; do not derive this seed from a
    # scenario/realized seed, and do not load actual future vehicle XML.
    for scale in (0.8, 1.0, 1.2):
        for repeat in range(3):
            sid = f"scale{scale:.1f}-arrival{repeat}"
            departures = planning_departures(
                rates, cutoff, end, planning_seed + repeat,
                scale, f"plan_{scale:.1f}_{repeat}",
            )
            plan_samples.append((sid, departures))
            sample_manifest.append({"sample_id": sid, "scale": scale,
                                    "request_count": len(departures),
                                    "sha256": content_hash([asdict(d) for d in departures])})
    evaluations = []
    timed_out = False
    errors = state_quality_errors(state, config)
    if not errors:
        # Reuse a single process, restore both SUMO and Python state per branch.
        with Simulator(network, seed=planning_seed, workdir=workdir,
                       snapshot=snapshot) as simulator:
            for candidate in candidates:
                samples = []
                for sid, departures in plan_samples:
                    if time.perf_counter() - started >= deadline_seconds:
                        timed_out = True
                        break
                    simulator.load_snapshot(snapshot)
                    simulator.run_until(end, departures, actions={
                        boundary: candidate.greens,
                        boundary + config.cycle_seconds: config.reference,
                    })
                    samples.append(sample_metrics(simulator.metrics(), sid))
                if len(samples) == len(plan_samples):
                    evaluations.append(CandidateEvaluation(candidate.id, tuple(samples)))
                if timed_out:
                    break
    elapsed = time.perf_counter() - started
    decision = recommend(state, evaluations, config,
                         elapsed_seconds=elapsed, deadline_seconds=deadline_seconds)
    return {
        "cutoff": cutoff, "apply_at": boundary, "planning_end": end,
        "horizon_cycles": horizon_cycles,
        "state": asdict(state), "observed_route_rates": rates,
        "planning_seed": planning_seed,
        "planning_samples": sample_manifest,
        "candidate_ids": [c.id for c in candidates],
        "evaluations": [asdict(e) for e in evaluations],
        "elapsed_seconds": elapsed, "deadline_seconds": deadline_seconds,
        "timed_out": timed_out or elapsed >= deadline_seconds,
        "decision": asdict(decision),
    }


@dataclass(frozen=True)
class ExperimentConfig:
    scenario: str = "imbalanced"
    seed: int = 7
    duration: int = 1200
    demand_duration: int = 960
    decisions: int = 3
    planning_seed: int = 10000
    deadline_seconds: float = 20.0
    policies: tuple[str, ...] = ("fixed", "no_diagnosis", "recommended")
    horizon_cycles: int = 2

    def __post_init__(self):
        from .demand import SCENARIOS
        if self.scenario not in SCENARIOS:
            raise ValueError(f"Choose a supported scenario: {SCENARIOS}")
        if self.duration < 840 or self.demand_duration <= 480:
            raise ValueError("duration must be >=840 and demand_duration >480")
        if self.demand_duration > self.duration:
            raise ValueError("demand_duration must not exceed duration")
        if not 1 <= self.decisions <= 20:
            raise ValueError("decisions must be between 1 and 20")
        if not math.isfinite(self.deadline_seconds) or self.deadline_seconds <= 0:
            raise ValueError("deadline_seconds must be finite and positive")
        if self.horizon_cycles not in (2, 4, 8):
            raise ValueError("horizon_cycles must be 2, 4 or 8")
        allowed = {"fixed", "no_diagnosis", "recommended", "full_search"}
        if (not self.policies or len(set(self.policies)) != len(self.policies)
                or not set(self.policies) <= allowed):
            raise ValueError("Choose unique supported policies")


def run_experiment(out: Path, config: ExperimentConfig) -> dict[str, Any]:
    from . import __version__
    from .demand import generate_demand
    from .network import build_network
    from .simulation import Simulator

    out = out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    network = build_network(out / "network")
    # This list belongs to the evaluator. It is never passed to evaluate_cutoff.
    realized = generate_demand(config.scenario, config.demand_duration, config.seed)
    demand_json = [asdict(d) for d in realized]
    demand_hash = content_hash(demand_json)
    write_json(out / "realized_demand.json", demand_json)
    results = []
    warmup = 480
    for policy in config.policies:
        folder = out / policy
        folder.mkdir(exist_ok=True)
        decisions = []
        actions = {}
        with Simulator(network, seed=config.seed, workdir=folder) as simulator:
            simulator.run_until(warmup, realized)
            simulator.reset_metrics()
            for index in range(config.decisions):
                cutoff = 580 + index * 120
                if cutoff + 20 + 120 > config.duration:
                    break
                simulator.run_until(cutoff, realized, actions=actions)
                if policy == "fixed":
                    continue
                state = traffic_state(simulator.observe())
                snapshot = simulator.save_snapshot(folder / f"cutoff_{cutoff}.json")
                record = evaluate_cutoff(
                    network, snapshot, state, simulator.recent_route_rates(3),
                    folder / "planning", planning_seed=config.planning_seed + index * 100,
                    diagnostic_filter=policy != "no_diagnosis",
                    full_search=policy == "full_search",
                    deadline_seconds=config.deadline_seconds,
                    horizon_cycles=config.horizon_cycles,
                )
                actions[record["apply_at"]] = tuple(record["decision"]["greens"])
                actions[record["apply_at"] + 120] = SignalConfig().reference
                decisions.append(record)
            simulator.run_until(config.duration, realized, actions=actions)
            metrics = simulator.metrics()
            history = simulator.history
            # Store a common runtime identity instead of inferring it from pip.
            version = simulator.version
        write_json(folder / "decisions.json", decisions)
        with (folder / "history.csv").open("w", newline="", encoding="utf-8") as file:
            writer = csv.DictWriter(file, ["time", "active", "uninserted", "queues", "downstream_counts"])
            writer.writeheader()
            writer.writerows(history)
        results.append({"policy": policy, "demand_sha256": demand_hash,
                        "metrics": metrics, "decisions": len(decisions),
                        "recommendations": sum(d["decision"]["status"] == "recommend"
                                               for d in decisions),
                        "abstentions": sum(d["decision"]["status"] == "abstain"
                                           for d in decisions),
                        "decision_log": f"{policy}/decisions.json"})
    fixed = next((x["metrics"]["objective_j"] for x in results if x["policy"] == "fixed"), None)
    for row in results:
        j = row["metrics"]["objective_j"]
        row["relative_j_change_vs_fixed"] = ((j - fixed) / fixed if fixed else None)
    summary = {"schema_version": 1, "package_version": __version__,
               "source_sha256": {
                   p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                   for p in sorted(Path(__file__).parent.glob("*.py"))
               },
               "signal_config": asdict(SignalConfig()),
               "sumo_version": version, "assumptions": {
                   "data": "synthetic, not measured Dundae data",
                   "state_initialization": "full SUMO state with known active routes",
                   "movements": "straight-only; one protected approach per green",
                   "controlled_signal": "B only; A/C identical across policies",
                   "forecast": "past completed external request counts, not realized future",
                   "pedestrians_buses_turns": "not modeled",
                   "evaluation_window": [warmup, config.duration],
                   "clearance_seconds": config.duration - config.demand_duration,
                   "field_effect": "not evaluated",
               }, "config": asdict(config), "demand_sha256": demand_hash,
               "scheduled_requests": len(realized), "results": results}
    write_json(out / "summary.json", summary)
    with (out / "metrics.csv").open("w", newline="", encoding="utf-8") as file:
        fields = ["policy", "objective_j", "terminal_vehicles", "terminal_uninserted",
                  "arrived", "teleports", "collisions", "recommendations", "abstentions",
                  "relative_j_change_vs_fixed", "demand_sha256"]
        writer = csv.DictWriter(file, fields)
        writer.writeheader()
        for row in results:
            writer.writerow({**{k: row.get(k) for k in fields},
                             **{k: row["metrics"][k] for k in fields if k in row["metrics"]}})
    (out / "report.html").write_text(render_report(summary), encoding="utf-8")
    return summary


def render_report(summary: dict[str, Any]) -> str:
    rows = []
    for row in summary["results"]:
        m = row["metrics"]
        change = row["relative_j_change_vs_fixed"]
        pct = "—" if change is None else f"{change:+.2%}"
        rows.append(f'<tr><td>{html.escape(row["policy"])}</td><td>{m["objective_j"]:,.0f}</td>'
                    f'<td>{pct}</td><td>{m["terminal_vehicles"]}</td>'
                    f'<td>{m["terminal_uninserted"]}</td><td>{row["recommendations"]}</td>'
                    f'<td>{row["abstentions"]}</td></tr>')
    return '''<!doctype html><html lang="ko"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SUMO 초기 모델 비교 결과</title><style>
body{font:16px/1.65 system-ui,sans-serif;max-width:1100px;margin:50px auto;padding:0 24px;color:#173047}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #cbd5df;padding:10px;text-align:right}
th:first-child,td:first-child{text-align:left}th{background:#eaf0f5}code{word-break:break-all}
</style><h1>가상 교차로 3개 · 신호 배분 비교</h1>
<p>실측 둔대교차로의 효과가 아닌 합성 실험 결과입니다. J는 도로망 안 차량과 예정시각을 지난 미삽입 차량의 누적 차량초입니다. 감소가 개선이며 종료 잔여량도 함께 확인해야 합니다.</p>
<table><thead><tr><th>정책</th><th>J (차량초)</th><th>고정 대비 변화</th><th>종료 차량</th><th>미삽입</th><th>추천</th><th>보류</th></tr></thead><tbody>''' + "".join(rows) + '''</tbody></table>
<p>같은 실현 수요를 사용하며 각 정책은 자신의 상태로 진화합니다. 완료 차량만의 평균으로 효과를 계산하지 않습니다. 상세 근거·가상 임계값·수요 해시는 JSON에 기록됩니다.</p><p><a href="summary.json">전체 요약</a> · <a href="metrics.csv">지표 CSV</a></p></html>'''


def summarize_repeats(summaries: list[dict[str, Any]]) -> dict[str, Any]:
    """Paired seed differences; small-sample t intervals are exploratory."""
    grouped: dict[tuple[str, str], list[float]] = {}
    for summary in summaries:
        base = next(r for r in summary["results"] if r["policy"] == "fixed")
        for row in summary["results"]:
            if row["policy"] != "fixed":
                grouped.setdefault((summary["config"]["scenario"], row["policy"]), []).append(
                    row["metrics"]["objective_j"] - base["metrics"]["objective_j"])
    output = []
    for (scenario, policy), differences in sorted(grouped.items()):
        # Student-t critical values for low repeat counts; no false precision
        # from counting individual vehicles as independent experiments.
        critical = {1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
                    6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262}
        n = len(differences)
        radius = (critical.get(n - 1, 2.262) * stdev(differences) / math.sqrt(n)
                  if n > 1 else None)
        mean = fmean(differences)
        output.append({"scenario": scenario, "policy": policy, "runs": n,
                       "paired_j_differences": differences, "mean_j_difference": mean,
                       "ci95_student_t_approx": [mean - radius, mean + radius] if radius is not None else None})
    return {"interpretation": "Negative paired J difference favors proposed policy. Small synthetic samples are exploratory; no field claim.",
            "comparisons": output}
