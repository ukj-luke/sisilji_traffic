"""Numerical checks for the isolated point-queue experiment and shared animation."""
import json
import sys
import unittest
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine.evaluation import (  # noqa: E402
    CYCLE, PLAN, _arrival_profile, _expected_profile, _paired, _run, cycle_rng, evaluate,
    generate_arrivals, observe_cycle, serve_cycle,
)


class ServiceTest(unittest.TestCase):
    def test_service_slots_obey_startup_clearance_headway_and_capacity(self):
        crossed = serve_cycle([100] * 4, [[], [], [], []], PLAN, "normal")
        self.assertEqual([len(v) for v in crossed], [28, 9, 28, 9])
        self.assertEqual([v[0] for v in crossed], [2.75, 38.75, 62.75, 98.75])
        self.assertEqual([v[-1] for v in crossed], [29.75, 54.75, 89.75, 114.75])
        self.assertTrue(all(t <= 120 for group in crossed for t in group))

    def test_arrival_after_green_remains_until_next_cycle(self):
        arrivals = [[29.8], [], [], []]
        first = _run([arrivals], [0] * 4, "fixed", PLAN, "normal")
        self.assertEqual(first["end_queue"], 1)
        self.assertAlmostEqual(first["wait_s"], CYCLE - 29.8)
        after = _run([arrivals, [[], [], [], []]], [0] * 4, "fixed", PLAN, "normal")
        self.assertEqual(after["cycle_end_queue"], [1, 0])
        self.assertAlmostEqual(after["wait_s"], CYCLE + 2.75 - 29.8)

    def test_no_service_before_arrival_and_no_full_cycle_lookahead(self):
        arrivals = [[0.25, 29.85, 30.25], [], [], []]
        crossed = serve_cycle([0] * 4, arrivals, PLAN, "normal")
        self.assertEqual(crossed, [[2.75], [], [], []])
        measures = observe_cycle([0] * 4, arrivals, PLAN, crossed, "normal")
        self.assertEqual(measures["P1"].residual, 1)
        self.assertEqual(measures["P1"].arrivals, 3)
        args = [[arrivals], [0] * 4]
        self.assertEqual(_run(*args, "adaptive", PLAN, "normal"), _run(*args, "fixed", PLAN, "normal"))

    def test_poisson_substreams_and_repeat_seed_replay(self):
        rates = [1800] * 4
        stream = generate_arrivals(rates, cycle_rng(42, 2, 0))
        self.assertEqual(stream, generate_arrivals(rates, cycle_rng(44, 0, 0)))
        self.assertNotEqual(stream, generate_arrivals(rates, cycle_rng(42, 2, 1)))
        self.assertTrue(all(group == sorted(group) for group in stream))
        self.assertTrue(all(0 <= t < CYCLE for group in stream for t in group))


class EvaluationTest(unittest.TestCase):
    def test_paired_t_interval(self):
        sample = [{"wait_s": v} for v in [1, 2, 3]]
        result = _paired(sample, [{"wait_s": 0}] * 3)
        self.assertEqual(result["delta_wait_s"], 2)
        self.assertAlmostEqual(result["ci95"][0], 2 - 4.3027 / 3 ** .5)
        self.assertAlmostEqual(result["ci95"][1], 2 + 4.3027 / 3 ** .5)

    def test_control_bounds_and_conservation_under_oversaturation(self):
        result = evaluate([1800] * 4, [1000] * 4, "blocked", cycles=3, replications=4)
        self.assertEqual(sum(result["plans"]["tod"]), 100)
        for g, base in zip(result["plans"]["tod"], PLAN):
            self.assertLessEqual(abs(g - base), 10)
            self.assertLessEqual(15, g)
        for method in result["methods"].values():
            self.assertAlmostEqual(method["served"] + method["end_queue"], result["demand_mean"])
            self.assertEqual(method["by_direction"][0]["served"], 0)
            self.assertGreaterEqual(method["peak_queue"], method["end_queue"])
            self.assertEqual(method["end_queue"], method["cycle_end_queue"][-1])
            for direction in method["by_direction"]:
                self.assertAlmostEqual(direction["served"] + direction["end_queue"], direction["demand"])
        self.assertEqual(result["paired"]["vs_tod"]["n"], 4)

    def test_missing_yields_baseline_and_zero_paired_interval(self):
        result = evaluate([900, 240, 480, 180], [6, 0, 0, 0], "missing", cycles=4, replications=3)
        self.assertEqual(result["methods"]["fixed"], result["methods"]["adaptive"])
        self.assertEqual(result["paired"]["vs_fixed"]["ci95"], [0, 0])
        self.assertEqual(result, evaluate([900, 240, 480, 180], [6, 0, 0, 0], "missing", 4, 3))

    def test_empty_demand_is_null_and_serializes(self):
        result = evaluate([0] * 4, [0] * 4, "normal", cycles=2, replications=2)
        self.assertEqual(result["methods"]["fixed"]["served"], 0)
        self.assertIsNone(result["methods"]["fixed"]["wait_s"])
        self.assertIsNone(result["worst_direction"])
        self.assertEqual(result["paired"]["vs_fixed"], {"n": 0, "delta_wait_s": None, "ci95": None})
        json.dumps(result, allow_nan=False)

    def test_surge_window_and_mean_based_fixed_plan(self):
        baseline = [1800, 240, 480, 180]
        surge = evaluate(baseline, [0] * 4, "normal", 10, 2, 73, profile="surge")
        expected = surge["expected_rates_by_cycle"]
        self.assertEqual([i + 1 for i, row in enumerate(expected) if row[0] == 2700], [4, 5, 6, 7])
        self.assertTrue(all(row[1:] == baseline[1:] for row in expected))
        self.assertEqual(surge["tod_mean_rates"], [2160, 240, 480, 180])
        self.assertEqual(surge["inputs"]["profile"], "surge")
        self.assertEqual(_expected_profile([900] * 4, 1, "surge"), [[1350, 900, 900, 900]])
        other = evaluate(baseline, [0] * 4, "normal", 10, 2, 74, profile="surge")
        self.assertEqual(surge["plans"], other["plans"])
        self.assertEqual(surge, evaluate(baseline, [0] * 4, "normal", 10, 2, 73, profile="surge"))

    def test_surge_replays_background_traffic_and_only_adds_east_west_cars(self):
        rates = [900, 240, 480, 180]
        steady = _arrival_profile(rates, _expected_profile(rates, 10, "steady"), 42, 0)
        surge = _arrival_profile(rates, _expected_profile(rates, 10, "surge"), 42, 0)
        self.assertEqual(steady[:3], surge[:3])
        self.assertEqual(steady[7:], surge[7:])
        for original, stressed in zip(steady[3:7], surge[3:7]):
            self.assertEqual(original[1:], stressed[1:])
            self.assertFalse(Counter(original[0]) - Counter(stressed[0]))
        self.assertGreater(sum(len(row[0]) for row in surge), sum(len(row[0]) for row in steady))

    def test_surge_results_can_favor_either_policy(self):
        evening = evaluate([900, 240, 480, 180], [6, 0, 0, 0], "normal", profile="surge")
        balanced = evaluate([540, 210, 540, 210], [6, 0, 0, 0], "normal", profile="surge")
        self.assertGreater(evening["paired"]["vs_tod"]["delta_wait_s"], 0)
        self.assertLess(balanced["paired"]["vs_tod"]["delta_wait_s"], 0)

    def test_tod_initialized_adaptive_first_cycle_equals_tod_then_responds(self):
        args = ([900, 240, 480, 180], [6, 0, 0, 0], "normal")
        one = evaluate(*args, cycles=1, replications=10)
        sensitivity = one["startup_sensitivity"]
        self.assertEqual(sensitivity["initial_greens"], one["plans"]["tod"])
        self.assertEqual(sensitivity["warmup_cycles"], 0)
        self.assertEqual(sensitivity["adaptive_wait_s"], one["methods"]["tod"]["wait_s"])
        self.assertEqual(sensitivity["vs_tod"]["ci95"], [0.0, 0.0])
        several = evaluate(*args, cycles=10, replications=10)
        self.assertNotEqual(several["startup_sensitivity"]["vs_tod"]["delta_wait_s"], 0)
        self.assertNotEqual(several["startup_sensitivity"]["adaptive_wait_s"], several["methods"]["adaptive"]["wait_s"])

    def test_saved_vehicle_hours_use_paired_observed_demand_and_primary_wait(self):
        result = evaluate([900, 240, 480, 180], [6, 0, 0, 0], "normal", replications=10)
        saved = result["startup_sensitivity"]["primary_saved_vehicle_hours"]
        expected = sum((r["tod_wait_s"] - r["adaptive_wait_s"]) * r["demand"] / 3600 for r in result["runs"]) / 10
        self.assertAlmostEqual(saved["mean"], expected, places=12)
        self.assertEqual(saved["n"], 10)
        wrong_product = -result["paired"]["vs_tod"]["delta_wait_s"] * result["demand_mean"] / 3600
        self.assertNotAlmostEqual(saved["mean"], wrong_product)
        self.assertLess(saved["ci95"][0], saved["mean"])
        self.assertGreater(saved["ci95"][1], saved["mean"])
        empty = evaluate([0] * 4, [0] * 4, "normal", cycles=1, replications=2)["startup_sensitivity"]
        self.assertEqual(empty["primary_saved_vehicle_hours"], {"mean": 0.0, "ci95": [0.0, 0.0], "n": 2})
        self.assertIsNone(empty["vs_tod"]["delta_wait_s"])

    def test_invalid_experiment_rejected(self):
        with self.assertRaises(ValueError):
            evaluate([1801] * 4, [0] * 4, "normal")
        with self.assertRaises(ValueError):
            evaluate([900] * 4, [0] * 4, "normal", replications=1)
        with self.assertRaises(ValueError):
            evaluate([900] * 4, [0] * 4, "normal", profile="unknown")


if __name__ == "__main__":
    unittest.main()
