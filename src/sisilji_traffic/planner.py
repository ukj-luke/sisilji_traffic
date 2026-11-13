"""Pure, reproducible rules for the *virtual* four-phase signal prototype.

This is an explainable baseline, not a trained model or a field-safety system.
All vectors use west, north, east, south approach order.  One protected through
movement is served per phase in the generated network; no conflict matrix is
inferred here.  Every action is relative to the approved reference, never to the
previous recommendation.  No future evaluation demand is accepted by this API.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from statistics import fmean
from typing import Sequence


DIRECTIONS = ("west", "north", "east", "south")
Vector = tuple[float, float, float, float]
Greens = tuple[int, int, int, int]


@dataclass(frozen=True)
class SignalConfig:
    reference: Greens = (30, 20, 30, 20)
    min_green: int = 15
    max_green: int = 45
    transfer: int = 5
    yellow: int = 3
    all_red: int = 2
    max_candidates: int = 5
    min_valid_fraction: float = 0.90
    min_mean_improvement: float = 0.01
    max_sample_deterioration: float = 0.02
    terminal_vehicle_allowance: float = 2.0
    direction_queue_factor: float = 1.1
    direction_queue_allowance: float = 2.0

    def __post_init__(self) -> None:
        if len(self.reference) != 4:
            raise ValueError("Exactly four reference phases are required")
        durations = (*self.reference, self.min_green, self.max_green,
                     self.transfer, self.yellow, self.all_red)
        if any(not isinstance(v, int) or isinstance(v, bool) or v <= 0
               for v in durations):
            raise ValueError("Signal durations must be positive integers")
        if not self.min_green <= min(self.reference) <= max(self.reference) <= self.max_green:
            raise ValueError("Reference greens violate the configured bounds")
        if not 1 <= self.max_candidates <= 9:
            raise ValueError("max_candidates must be in [1, 9]")
        thresholds = (self.min_valid_fraction, self.min_mean_improvement,
                      self.max_sample_deterioration,
                      self.terminal_vehicle_allowance,
                      self.direction_queue_factor, self.direction_queue_allowance)
        if any(not _finite(v) or v < 0 for v in thresholds):
            raise ValueError("Acceptance thresholds must be finite and nonnegative")
        if not 0 <= self.min_valid_fraction <= 1:
            raise ValueError("min_valid_fraction must be in [0, 1]")

    @property
    def cycle_seconds(self) -> int:
        return sum(self.reference) + 4 * (self.yellow + self.all_red)


@dataclass(frozen=True)
class CycleObservation:
    """Completed cycle only, ordered from oldest to newest in TrafficState.

    ``green_no_discharge`` must be measured with demand present and after the
    start-up interval. ``residual_queues`` is measured at each green's end;
    ``queues_end`` is the queue at the common cycle boundary.
    """

    inflow: Vector
    residual_queues: Vector
    green_no_discharge: tuple[bool, bool, bool, bool]
    queues_end: Vector | None = None


@dataclass(frozen=True)
class TrafficState:
    observed_at: float
    queues: Vector
    capacities: Vector
    downstream_counts: Vector
    downstream_capacities: Vector
    cycles: tuple[CycleObservation, ...] = ()
    valid_fraction: float = 1.0
    signal_complete: bool = True
    state_valid: bool = True


@dataclass(frozen=True)
class Diagnosis:
    cause: str
    directions: tuple[str, ...]
    evidence: tuple[str, ...]
    evidence_id: str


@dataclass(frozen=True)
class Candidate:
    id: str
    greens: Greens
    donor: int | None = None
    recipient: int | None = None


@dataclass(frozen=True)
class SampleMetrics:
    sample_id: str
    objective_j: float
    terminal_vehicles: float
    terminal_uninserted: float
    terminal_queues: Vector
    teleports: int = 0
    collisions: int = 0


@dataclass(frozen=True)
class CandidateEvaluation:
    candidate_id: str
    samples: tuple[SampleMetrics, ...]


@dataclass(frozen=True)
class CandidateAssessment:
    candidate_id: str
    accepted: bool
    reasons: tuple[str, ...]
    mean_relative_change: float | None = None
    worst_relative_change: float | None = None


@dataclass(frozen=True)
class Recommendation:
    status: str
    candidate_id: str
    greens: Greens
    reason: str
    diagnoses: tuple[Diagnosis, ...]
    assessments: tuple[CandidateAssessment, ...] = ()


def _finite(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _vector_ok(values: Sequence[float], *, positive: bool = False) -> bool:
    try:
        return (len(values) == 4
                and all(_finite(v) and (v > 0 if positive else v >= 0) for v in values))
    except TypeError:
        # Runtime data can violate the type annotation (for example JSON null).
        return False


def state_quality_errors(state: TrafficState,
                         config: SignalConfig | None = None) -> tuple[str, ...]:
    """Return explicit reasons to abstain instead of replacing missing data by 0."""
    config = config or SignalConfig()
    errors: list[str] = []
    if not _finite(state.observed_at) or state.observed_at < 0:
        errors.append("invalid observation time")
    if not state.state_valid:
        errors.append("state flagged invalid")
    if not state.signal_complete:
        errors.append("signal observation incomplete")
    if (not _finite(state.valid_fraction)
            or not config.min_valid_fraction <= state.valid_fraction <= 1):
        errors.append("valid feature fraction below configured threshold")
    for name, values, positive in (
        ("queues", state.queues, False),
        ("capacities", state.capacities, True),
        ("downstream counts", state.downstream_counts, False),
        ("downstream capacities", state.downstream_capacities, True),
    ):
        if not _vector_ok(values, positive=positive):
            errors.append(f"invalid or missing {name}")
    if not errors:
        if any(q > cap for q, cap in zip(state.queues, state.capacities)):
            errors.append("queue exceeds storage capacity")
        if any(n > cap for n, cap in zip(state.downstream_counts, state.downstream_capacities)):
            errors.append("downstream count exceeds storage capacity")
    if not isinstance(state.cycles, (tuple, list)):
        return (*errors, "completed observation cycles missing")
    if len(state.cycles) < 4:
        errors.append("four completed observation cycles required")
    for i, cycle in enumerate(state.cycles[-4:]):
        if not isinstance(cycle, CycleObservation):
            errors.append(f"invalid completed cycle {i}")
            continue
        if (not _vector_ok(cycle.inflow)
                or not _vector_ok(cycle.residual_queues)
                or (cycle.queues_end is not None and not _vector_ok(cycle.queues_end))
                or len(cycle.green_no_discharge) != 4
                or not all(isinstance(v, bool) for v in cycle.green_no_discharge)):
            errors.append(f"invalid completed cycle {i}")
    return tuple(errors)


def diagnose(state: TrafficState, config: SignalConfig | None = None) -> tuple[Diagnosis, ...]:
    """Generate *candidate explanations*, never definitive causal claims.

    No bus diagnosis is emitted: the initial prototype has no bus observations.
    Low downstream storage usage is not detector time occupancy.
    """
    config = config or SignalConfig()
    errors = state_quality_errors(state, config)
    if errors:
        return (Diagnosis("unknown", (), errors, "state:invalid"),)
    history = state.cycles[-4:]
    latest, previous = history[-1], history[-2]
    result: list[Diagnosis] = []

    def add(cause: str, direction: int, evidence: str) -> None:
        name = DIRECTIONS[direction]
        result.append(Diagnosis(cause, (name,), (evidence,),
                                f"{cause}:{name}:{state.observed_at:g}"))

    for i, direction in enumerate(DIRECTIONS):
        prior_mean = fmean(c.inflow[i] for c in history[:-1])
        now_queue = (latest.queues_end or latest.residual_queues)[i]
        prior_queue = (previous.queues_end or previous.residual_queues)[i]
        occupancy = state.downstream_counts[i] / state.downstream_capacities[i]
        # A zero historical denominator is insufficient evidence of a ratio surge.
        if prior_mean > 0 and latest.inflow[i] > 1.2 * prior_mean and now_queue > prior_queue:
            add("inflow_surge", i,
                f"{direction}: latest inflow {latest.inflow[i]:g} > 1.2 × preceding "
                f"3-cycle mean {prior_mean:g}; queue {prior_queue:g} → {now_queue:g}")
        if (latest.residual_queues[i] > 0 and previous.residual_queues[i] > 0
                and occupancy < 0.6):
            add("green_imbalance", i,
                f"{direction}: residual queue in two completed greens; "
                f"downstream storage usage {occupancy:.3f} < 0.6; "
                "inflow changes or lane blockage remain alternative explanations")
        if latest.green_no_discharge[i] and latest.residual_queues[i] > 0 and occupancy >= 0.8:
            add("downstream_block", i,
                f"{direction}: observed green with demand but no discharge after start-up; "
                f"downstream storage usage {occupancy:.3f} ≥ 0.8")
    if not result:
        if max(q / cap for q, cap in zip(state.queues, state.capacities)) <= 0.10:
            result.append(Diagnosis("normal", (),
                                    ("good observations and all current queue/storage ratios ≤ 0.10",),
                                    f"normal:{state.observed_at:g}"))
        else:
            result.append(Diagnosis("unknown", (),
                                    ("congestion is observed but no implemented cause rule is supported",),
                                    f"unexplained:{state.observed_at:g}"))
    return tuple(result)


def generate_candidates(config: SignalConfig | None = None) -> tuple[Candidate, ...]:
    """Return no-change plus legal ±5 s transfers for four adjacent phase pairs."""
    config = config or SignalConfig()
    result = [Candidate("baseline", config.reference)]
    for first, second in ((0, 1), (1, 2), (2, 3), (3, 0)):
        for donor, recipient in ((first, second), (second, first)):
            greens = list(config.reference)
            greens[donor] -= config.transfer
            greens[recipient] += config.transfer
            if (min(greens) >= config.min_green and max(greens) <= config.max_green
                    and sum(greens) == sum(config.reference)):
                result.append(Candidate(f"p{donor + 1}_to_p{recipient + 1}",
                                        tuple(greens), donor, recipient))
    return tuple(result)


def select_candidates(state: TrafficState, config: SignalConfig | None = None,
                      diagnostic_filter: bool = True) -> tuple[Candidate, ...]:
    """Rank by residual/storage benefit; optionally exclude blocked recipients.

    Both diagnosis-enabled and diagnosis-free searches use the same residual
    ranking, candidate budget, information cutoff and no-change alternative.
    Missing mandatory state produces only no-change; ``recommend`` abstains.
    """
    config = config or SignalConfig()
    all_candidates = generate_candidates(config)
    if state_quality_errors(state, config):
        return all_candidates[:1]
    blocked = {direction for d in diagnose(state, config) if d.cause == "downstream_block"
               for direction in d.directions} if diagnostic_filter else set()
    residual = state.cycles[-1].residual_queues
    ratios = [q / cap for q, cap in zip(residual, state.capacities)]
    alternatives = [candidate for candidate in all_candidates[1:]
                    if DIRECTIONS[candidate.recipient] not in blocked]
    alternatives.sort(key=lambda c: (-(ratios[c.recipient] - ratios[c.donor]), c.id))
    return (all_candidates[0], *alternatives[:config.max_candidates - 1])


def _metric_errors(metrics: SampleMetrics) -> tuple[str, ...]:
    errors = []
    if not isinstance(metrics.sample_id, str) or not metrics.sample_id:
        errors.append("missing sample ID")
    for name in ("objective_j", "terminal_vehicles", "terminal_uninserted", "teleports", "collisions"):
        value = getattr(metrics, name)
        if not _finite(value) or value < 0:
            errors.append(f"invalid {name}")
    if not _vector_ok(metrics.terminal_queues):
        errors.append("invalid terminal queues")
    if metrics.teleports:
        errors.append("teleport observed")
    if metrics.collisions:
        errors.append("collision observed")
    return tuple(errors)


def recommend(state: TrafficState,
              evaluations: Sequence[CandidateEvaluation],
              config: SignalConfig | None = None,
              elapsed_seconds: float = 0.0,
              deadline_seconds: float = 20.0) -> Recommendation:
    """Apply paired sample gates and choose worst/mean relative-J change.

    J integrates active + overdue-uninserted vehicles over a common horizon.
    Samples must be matched by ID; the caller constructs the default 9 planning
    samples (3 demand multipliers × 3 arrival seeds) from *past observations*.
    These are virtual acceptance parameters, not field-safety guarantees.
    """
    config = config or SignalConfig()
    diagnoses = diagnose(state, config)

    def hold(reason: str, *, abstain: bool = False,
             assessments: Sequence[CandidateAssessment] = ()) -> Recommendation:
        return Recommendation("abstain" if abstain else "keep", "baseline",
                              config.reference, reason, diagnoses, tuple(assessments))

    errors = state_quality_errors(state, config)
    if errors:
        return hold("; ".join(errors), abstain=True)
    if (not _finite(elapsed_seconds) or elapsed_seconds < 0
            or not _finite(deadline_seconds) or deadline_seconds <= 0):
        return hold("invalid compute time or deadline", abstain=True)
    if elapsed_seconds >= deadline_seconds:
        return hold("recommendation missed the configured application deadline", abstain=True)
    by_id = {e.candidate_id: e for e in evaluations}
    if len(by_id) != len(evaluations):
        return hold("duplicate candidate evaluation IDs", abstain=True)
    baseline = by_id.get("baseline")
    if baseline is None or not baseline.samples:
        return hold("baseline planning samples missing", abstain=True)
    baseline_by_sample = {m.sample_id: m for m in baseline.samples}
    if len(baseline_by_sample) != len(baseline.samples):
        return hold("duplicate baseline sample IDs", abstain=True)
    for metrics in baseline.samples:
        issues = _metric_errors(metrics)
        if issues:
            return hold("invalid baseline: " + "; ".join(issues), abstain=True)
    if any(m.objective_j == 0 for m in baseline.samples):
        return hold("zero baseline J: relative improvement is undefined")
    legal = {c.id: c for c in generate_candidates(config)}
    assessments: list[CandidateAssessment] = []
    for candidate_id, evaluation in by_id.items():
        if candidate_id == "baseline":
            continue
        reasons: list[str] = []
        if candidate_id not in legal:
            reasons.append("candidate violates the configured action template")
        sample_by_id = {m.sample_id: m for m in evaluation.samples}
        if (set(sample_by_id) != set(baseline_by_sample)
                or len(sample_by_id) != len(evaluation.samples)):
            reasons.append("candidate samples do not match baseline sample IDs exactly")
        metric_issues = [f"{m.sample_id}: {issue}" for m in evaluation.samples
                         for issue in _metric_errors(m)]
        reasons.extend(metric_issues)
        if reasons:
            assessments.append(CandidateAssessment(candidate_id, False, tuple(reasons)))
            continue
        changes = []
        for sample_id, base in baseline_by_sample.items():
            metrics = sample_by_id[sample_id]
            relative = (metrics.objective_j - base.objective_j) / base.objective_j
            changes.append(relative)
            if relative > config.max_sample_deterioration + 1e-12:
                reasons.append(f"{sample_id}: J deterioration exceeds limit")
            if metrics.terminal_vehicles > base.terminal_vehicles + config.terminal_vehicle_allowance:
                reasons.append(f"{sample_id}: terminal active vehicle count exceeds allowance")
            if metrics.terminal_uninserted > base.terminal_uninserted:
                reasons.append(f"{sample_id}: uninserted demand increases")
            for direction, q, baseline_q in zip(DIRECTIONS, metrics.terminal_queues, base.terminal_queues):
                limit = max(config.direction_queue_factor * baseline_q,
                            baseline_q + config.direction_queue_allowance)
                if q > limit + 1e-12:
                    reasons.append(f"{sample_id}: {direction} terminal queue exceeds allowance")
        mean_change, worst_change = fmean(changes), max(changes)
        if mean_change > -config.min_mean_improvement + 1e-12:
            reasons.append("mean paired relative-J improvement below configured minimum")
        assessments.append(CandidateAssessment(candidate_id, not reasons, tuple(reasons),
                                               mean_change, worst_change))
    accepted = [a for a in assessments if a.accepted]
    if not accepted:
        return hold("no candidate passes all configured planning gates", assessments=assessments)
    accepted.sort(key=lambda a: (a.worst_relative_change, a.mean_relative_change, a.candidate_id))
    winner = accepted[0]
    return Recommendation("recommend", winner.candidate_id, legal[winner.candidate_id].greens,
                          "passes paired planning gates; minimum worst relative J, then mean and ID",
                          diagnoses, tuple(assessments))
