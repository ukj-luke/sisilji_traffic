"""Decision-contract tests; these do not establish simulated or field benefit."""

from dataclasses import replace
import unittest

from sisilji_traffic.planner import (
    CandidateEvaluation,
    CycleObservation,
    SampleMetrics,
    SignalConfig,
    TrafficState,
    diagnose,
    generate_candidates,
    recommend,
    select_candidates,
)


ZERO = (0.0, 0.0, 0.0, 0.0)
FALSE = (False, False, False, False)


def cycle(inflow=(10.0, 10.0, 10.0, 10.0), residual=ZERO,
          no_discharge=FALSE, queue=ZERO):
    return CycleObservation(inflow, residual, no_discharge, queue)


def good_state(**changes):
    state = TrafficState(
        observed_at=480.0,
        queues=ZERO,
        capacities=(40.0, 40.0, 40.0, 40.0),
        downstream_counts=(1.0, 1.0, 1.0, 1.0),
        downstream_capacities=(10.0, 10.0, 10.0, 10.0),
        cycles=(cycle(), cycle(), cycle(), cycle()),
    )
    return replace(state, **changes)


def metric(sample_id, objective_j=100.0, **changes):
    base = SampleMetrics(
        sample_id=sample_id,
        objective_j=objective_j,
        terminal_vehicles=50.0,
        terminal_uninserted=0.0,
        terminal_queues=(10.0, 20.0, 0.0, 3.0),
    )
    return replace(base, **changes)


def evaluation(candidate_id, values=(100.0, 100.0), **changes):
    return CandidateEvaluation(candidate_id, tuple(
        metric(f"sample-{i}", value, **changes)
        for i, value in enumerate(values)
    ))


def causes(state):
    return {item.cause for item in diagnose(state)}


class CandidateContractTests(unittest.TestCase):
    def test_reference_relative_transfers_preserve_cycle_and_clearances(self):
        config = SignalConfig()
        candidates = generate_candidates(config)
        self.assertEqual(config.cycle_seconds, 120)
        self.assertEqual(len(candidates), 9)
        self.assertEqual(len({c.id for c in candidates}), 9)
        self.assertEqual(candidates[0].id, "baseline")
        self.assertEqual(candidates[0].greens, config.reference)
        for candidate in candidates[1:]:
            with self.subTest(candidate=candidate.id):
                delta = [v - ref for v, ref in zip(candidate.greens, config.reference)]
                self.assertEqual(sorted(delta), [-5, 0, 0, 5])
                self.assertEqual(sum(candidate.greens) + 4 * (config.yellow + config.all_red), 120)
                self.assertTrue(all(15 <= value <= 45 for value in candidate.greens))
                self.assertEqual(delta[candidate.donor], -5)
                self.assertEqual(delta[candidate.recipient], 5)

    def test_boundary_greens_remove_illegal_transfers_and_do_not_accumulate(self):
        config = SignalConfig(reference=(15, 45, 15, 25))
        before = generate_candidates(config)
        self.assertLess(len(before), 9)
        for candidate in before:
            self.assertEqual(sum(candidate.greens), sum(config.reference))
            self.assertTrue(all(15 <= value <= 45 for value in candidate.greens))
        first_action = next(c for c in before if c.id != "baseline")
        result = recommend(good_state(), [
            evaluation("baseline"), evaluation(first_action.id, (80.0, 80.0))
        ], config)
        self.assertEqual(result.candidate_id, first_action.id)
        self.assertEqual(config.reference, (15, 45, 15, 25))
        self.assertEqual(generate_candidates(config), before)

    def test_blocked_direction_filter_changes_candidates_without_changing_budget(self):
        blocked_cycle = cycle(residual=(20.0, 1.0, 0.0, 0.0),
                              no_discharge=(True, False, False, False),
                              queue=(20.0, 1.0, 0.0, 0.0))
        state = good_state(queues=(20.0, 1.0, 0.0, 0.0),
                           downstream_counts=(8.0, 1.0, 1.0, 1.0),
                           cycles=(cycle(), cycle(), cycle(), blocked_cycle))
        filtered = select_candidates(state)
        unfiltered = select_candidates(state, diagnostic_filter=False)
        self.assertEqual(len(filtered), 5)
        self.assertEqual(len(unfiltered), 5)
        self.assertEqual(filtered[0].id, "baseline")
        self.assertEqual(unfiltered[0].id, "baseline")
        self.assertTrue(all(c.recipient != 0 for c in filtered[1:]))
        self.assertTrue(any(c.recipient == 0 for c in unfiltered[1:]))


class ObservationAndDiagnosisTests(unittest.TestCase):
    def test_surge_needs_positive_history_strict_ratio_and_queue_growth(self):
        latest = cycle(inflow=(13.0, 10.0, 10.0, 10.0),
                       residual=(2.0, 0.0, 0.0, 0.0), queue=(3.0, 0.0, 0.0, 0.0))
        state = good_state(cycles=(cycle(), cycle(), cycle(), latest))
        self.assertIn("inflow_surge", causes(state))
        at_threshold = replace(latest, inflow=(12.0, 10.0, 10.0, 10.0))
        self.assertNotIn("inflow_surge", causes(replace(
            state, cycles=(cycle(), cycle(), cycle(), at_threshold))))
        flat_queue = replace(latest, queues_end=ZERO)
        self.assertNotIn("inflow_surge", causes(replace(
            state, cycles=(cycle(), cycle(), cycle(), flat_queue))))
        zero_history = cycle(inflow=ZERO)
        self.assertNotIn("inflow_surge", causes(replace(
            state, cycles=(zero_history, zero_history, zero_history, latest))))

    def test_residual_imbalance_and_blockage_are_distinct_candidate_explanations(self):
        residual = cycle(residual=(4.0, 0.0, 0.0, 0.0), queue=(4.0, 0.0, 0.0, 0.0))
        state = good_state(queues=(4.0, 0.0, 0.0, 0.0),
                           downstream_counts=(5.0, 1.0, 1.0, 1.0),
                           cycles=(cycle(), cycle(), residual, residual))
        self.assertIn("green_imbalance", causes(state))
        self.assertNotIn("downstream_block", causes(state))
        blocked = replace(residual, green_no_discharge=(True, False, False, False))
        high_usage = replace(state, downstream_counts=(8.0, 1.0, 1.0, 1.0),
                             cycles=(cycle(), cycle(), residual, blocked))
        self.assertIn("downstream_block", causes(high_usage))
        self.assertNotIn("green_imbalance", causes(high_usage))
        discharging = replace(high_usage, cycles=(cycle(), cycle(), residual, residual))
        self.assertNotIn("downstream_block", causes(discharging))

    def test_high_unexplained_queue_is_unknown_instead_of_normal(self):
        self.assertEqual(causes(good_state()), {"normal"})
        unexplained = good_state(queues=(20.0, 0.0, 0.0, 0.0))
        self.assertEqual(causes(unexplained), {"unknown"})

    def test_missing_or_invalid_observations_abstain_instead_of_zero_filling(self):
        variants = {
            "missing_vector": {"queues": None},
            "missing_queue": {"queues": (None, 0.0, 0.0, 0.0)},
            "nonfinite_count": {"downstream_counts": (float("nan"), 1.0, 1.0, 1.0)},
            "zero_capacity": {"capacities": (0.0, 40.0, 40.0, 40.0)},
            "storage_overflow": {"queues": (41.0, 0.0, 0.0, 0.0)},
            "incomplete_signal": {"signal_complete": False},
            "quality_below_gate": {"valid_fraction": 0.899},
            "flagged_invalid": {"state_valid": False},
            "missing_history": {"cycles": None},
            "unfinished_history": {"cycles": (cycle(), cycle(), cycle())},
        }
        for name, changes in variants.items():
            with self.subTest(case=name):
                state = good_state(**changes)
                self.assertEqual(causes(state), {"unknown"})
                self.assertEqual([c.id for c in select_candidates(state)], ["baseline"])
                self.assertEqual(recommend(state, []).status, "abstain")
        accepted_quality = recommend(good_state(valid_fraction=0.90), [
            evaluation("baseline"), evaluation("p1_to_p2", (80.0, 80.0))
        ])
        self.assertEqual(accepted_quality.status, "recommend")


class RecommendationGateTests(unittest.TestCase):
    def test_samples_pair_by_id_rather_than_position(self):
        baseline = evaluation("baseline", (100.0, 200.0))
        candidate = CandidateEvaluation("p1_to_p2", (
            metric("sample-1", 180.0), metric("sample-0", 99.0)
        ))
        result = recommend(good_state(), [baseline, candidate])
        reordered = recommend(good_state(), [baseline, replace(
            candidate, samples=tuple(reversed(candidate.samples)))])
        self.assertEqual(result.status, "recommend")
        self.assertEqual(result, reordered)
        self.assertAlmostEqual(result.assessments[0].mean_relative_change, -0.055)

    def test_missing_duplicate_or_foreign_sample_ids_are_rejected(self):
        baseline = evaluation("baseline")
        variants = {
            "missing": (metric("sample-0", 80.0),),
            "duplicate": (metric("sample-0", 80.0), metric("sample-0", 80.0)),
            "foreign": (metric("sample-0", 80.0), metric("other", 80.0)),
        }
        for name, samples in variants.items():
            with self.subTest(case=name):
                result = recommend(good_state(), [baseline, CandidateEvaluation("p1_to_p2", samples)])
                self.assertEqual(result.status, "keep")
                self.assertFalse(result.assessments[0].accepted)
        bad_baseline = CandidateEvaluation("baseline", variants["duplicate"])
        self.assertEqual(recommend(good_state(), [bad_baseline]).status, "abstain")

    def test_terminal_and_anomaly_gates_reject_apparent_j_improvement(self):
        # Every candidate improves J; each must still satisfy the other gates.
        violations = {
            "active_vehicles": {"terminal_vehicles": 53.0},
            "uninserted_demand": {"terminal_uninserted": 1.0},
            "queue_allowance": {"terminal_queues": (12.01, 20.0, 0.0, 3.0)},
            "queue_factor": {"terminal_queues": (10.0, 22.01, 0.0, 3.0)},
            "teleport": {"teleports": 1},
            "collision": {"collisions": 1},
            "invalid_metric": {"terminal_vehicles": float("inf")},
        }
        for name, changes in violations.items():
            with self.subTest(case=name):
                result = recommend(good_state(), [evaluation("baseline"),
                    evaluation("p1_to_p2", (80.0, 80.0), **changes)])
                self.assertEqual(result.status, "keep")
                self.assertFalse(result.assessments[0].accepted)
                self.assertTrue(result.assessments[0].reasons)
        at_limits = recommend(good_state(), [evaluation("baseline"), evaluation(
            "p1_to_p2", (80.0, 80.0), terminal_vehicles=52.0,
            terminal_queues=(12.0, 22.0, 2.0, 5.0))])
        self.assertEqual(at_limits.status, "recommend")

    def test_mean_and_worst_sample_gates_are_both_required(self):
        for values in ((99.5, 99.5), (70.0, 103.0), (100.0, 100.0)):
            with self.subTest(j_values=values):
                result = recommend(good_state(), [evaluation("baseline"),
                    evaluation("p1_to_p2", values)])
                self.assertEqual(result.status, "keep")
        at_limits = recommend(good_state(), [evaluation("baseline"),
            evaluation("p1_to_p2", (96.0, 102.0))])
        self.assertEqual(at_limits.status, "recommend")

    def test_zero_j_and_late_results_do_not_produce_an_action(self):
        zero = recommend(good_state(), [evaluation("baseline", (0.0, 100.0)),
            evaluation("p1_to_p2", (0.0, 80.0))])
        self.assertEqual(zero.status, "keep")
        self.assertEqual(zero.candidate_id, "baseline")
        for elapsed in (20.0, 20.01, float("nan")):
            with self.subTest(elapsed=elapsed):
                late = recommend(good_state(), [evaluation("baseline"),
                    evaluation("p1_to_p2", (80.0, 80.0))], elapsed_seconds=elapsed)
                self.assertEqual(late.status, "abstain")
                self.assertEqual(late.greens, SignalConfig().reference)

    def test_ranking_prefers_worst_sample_then_mean_then_stable_id(self):
        cases = (
            # Better worst sample outranks a better mean.
            ((90.0, 99.0), (95.0, 95.0), "p2_to_p1"),
            # Equal worst sample: choose the better mean.
            ((98.0, 90.0), (98.0, 95.0), "p1_to_p2"),
            # Equal worst and mean: ID order is independent of input order.
            ((95.0, 95.0), (95.0, 95.0), "p1_to_p2"),
        )
        for first, second, expected in cases:
            with self.subTest(first=first, second=second):
                evaluations = [evaluation("baseline"), evaluation("p2_to_p1", second),
                               evaluation("p1_to_p2", first)]
                result = recommend(good_state(), evaluations)
                reordered = recommend(good_state(), list(reversed(evaluations)))
                self.assertEqual(result.candidate_id, expected)
                self.assertEqual(reordered.candidate_id, expected)

    def test_unknown_action_and_duplicate_candidate_ids_cannot_be_recommended(self):
        unknown = recommend(good_state(), [evaluation("baseline"),
            evaluation("arbitrary_unsafe_action", (1.0, 1.0))])
        self.assertEqual(unknown.status, "keep")
        self.assertFalse(unknown.assessments[0].accepted)
        duplicate = recommend(good_state(), [evaluation("baseline"),
            evaluation("p1_to_p2", (80.0, 80.0)), evaluation("p1_to_p2", (80.0, 80.0))])
        self.assertEqual(duplicate.status, "abstain")


if __name__ == "__main__":
    unittest.main()
