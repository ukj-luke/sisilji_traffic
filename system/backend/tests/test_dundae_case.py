"""Regression checks for the Dundae signal comparison and published artifact."""
import json
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from system.backend import dundae_case as case
from system.backend.engine.green_split import Movement


class DundaeCaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.survey = json.loads(case.SURVEY.read_text(encoding="utf-8"))
        cls.report = case.experiment(cls.survey, include_runs=True)

    def test_draws_preserve_each_observed_quarter_and_vehicle_class_total(self):
        for hour in ("07:00", "08:00"):
            row = self.survey["hourly"][hour]
            counts = row["quarterCountsByDirection"]
            arrivals = case.arrivals_for_hour(counts, random.Random(42))
            for code in case.CODES:
                self.assertEqual([sum(quarter) for quarter in row["classCountsByDirection"][code]], counts[code])
                for quarter, count in enumerate(counts[code]):
                    cycles = arrivals[quarter * 5:(quarter + 1) * 5]
                    self.assertEqual(sum(len(c[code]) for c in cycles), count)
                    for cycle in cycles:
                        self.assertEqual(cycle[code], sorted(cycle[code]))
                        self.assertTrue(all(0 <= t < case.CYCLE for t in cycle[code]))
        self.assertEqual(self.survey["hourly"]["08:00"]["quarterTotals"], [1430, 1528, 1410, 1380])

    def test_fractional_headways_startup_and_strict_green_end(self):
        three_lanes = Movement("2", lanes=3, sat_headway=2)
        saturated = case.service_times(100, [], 10, 16, three_lanes)
        self.assertEqual(len(saturated), 6)
        self.assertGreater(saturated[0], 12)
        self.assertLess(saturated[-1], 16)
        self.assertAlmostEqual(saturated[1] - saturated[0], 2 / 3)
        self.assertEqual(case.service_times(0, [saturated[-1], 16], 10, 16, three_lanes), [saturated[-1]])
        self.assertEqual(case.service_times(0, [0], 10, 12, three_lanes), [])

    def test_green_end_feedback_and_queue_integral(self):
        plan = self.survey["greenSeconds"]
        phases = case.make_phases(case.GROUPS, case.assumed_lanes(4), plan)
        cycle = {code: [] for code in case.CODES}
        cycle["1"] = [0, 23.9, 24.0, 26.9]
        initial = dict.fromkeys(case.CODES, 0)
        step = case.run_cycle(cycle, initial, phases, plan, self.survey["yellowSeconds"])
        # A single-lane stream has slots 3,5,...,23 seconds. Only t=0 departs.
        self.assertEqual(step.served["1"], 1)
        self.assertEqual(step.measures["1"].residual, 1)
        self.assertEqual(step.measures["1"].arrivals, 4)
        self.assertEqual(step.queues["1"], 3)
        self.assertAlmostEqual(step.queue_seconds, 3 + (180 - 23.9) + (180 - 24.0) + (180 - 26.9))

    def test_raw_paired_runs_share_boundary_and_conserve_direction_counts(self):
        plan = self.survey["greenSeconds"]
        by_code = self.survey["hourly"]["08:00"]["quarterCountsByDirection"]
        for scenario in self.report["scenarios"].values():
            for pair in scenario["runs"]:
                fixed, adaptive = pair["fixed"], pair["adaptive"]
                self.assertEqual(fixed["startQueueByCode"], adaptive["startQueueByCode"])
                self.assertEqual(fixed["cycleGreens"], [plan] * 20)
                self.assertEqual(adaptive["cycleGreens"][0], plan)
                self.assertEqual(fixed["cycleEndByCode"][0], adaptive["cycleEndByCode"][0])
                for run in (fixed, adaptive):
                    self.assertEqual(run["arrivals"], 5748)
                    self.assertEqual(run["startQueue"] + 5748 - run["served"], run["endQueue"])
                    self.assertEqual(run["maxAbsConservationError"], 0)
                    self.assertEqual(run["cycleEndByCode"][-1], [run["endQueueByCode"][code] for code in case.CODES])
                    for code in case.CODES:
                        self.assertLessEqual(run["endQueueByCode"][code], run["startQueueByCode"][code] + sum(by_code[code]))
                    for cycle, green in enumerate(run["cycleGreens"]):
                        self.assertEqual(sum(green), 165)
                        self.assertTrue(all(abs(g - p) <= case.LIMIT for g, p in zip(green, plan, strict=True)))
                        self.assertEqual(sum(run["cycleEndByCode"][cycle]), run["cycleEndQueue"][cycle])
            self.assertEqual(scenario["checks"]["maxAbsConservationError"], 0)

    def test_capacity_estimate_uses_warmup_only_and_is_minimal(self):
        warm = self.survey["hourly"]["07:00"]["quarterCountsByDirection"]
        plan = self.survey["greenSeconds"]
        d = self.report["scenarios"]["D"]
        self.assertEqual(d["lanesByCode"], case.estimate_lanes(case.GROUPS, plan, warm))
        self.assertEqual(d["capacityCheck"]["warmExceedances"], [])
        held_out = d["capacityCheck"]["peakExceedances"]
        self.assertTrue({"2", "4", "8"}.issubset(row["code"] for row in held_out))
        self.assertEqual(d["capacityCheck"]["peakExcessVehicles"],
                         sum(row["count"] - row["capacity"] for row in held_out))
        for codes, green in zip(case.GROUPS, plan, strict=True):
            for number in codes:
                code = str(number)
                lanes = d["lanesByCode"][code]
                cap = 5 * ((green - 2) * lanes // 2)
                self.assertEqual(d["capacityCheck"]["slotsPerQuarterByCode"][code], cap)
                self.assertLessEqual(max(warm[code]), cap)
                if lanes > 1:
                    self.assertLess(5 * ((green - 2) * (lanes - 1) // 2), max(warm[code]))

    def test_generated_public_result_is_reproducible(self):
        report = dict(self.report)
        report["scenarios"] = {name: {k: v for k, v in scenario.items() if k != "runs"}
                               for name, scenario in self.report["scenarios"].items()}
        # Compare as JSON data so Python tuples and their JSON array form agree.
        public = json.loads(case.RESULTS.read_text(encoding="utf-8"))
        self.assertEqual(json.loads(json.dumps(report)), public)
        self.assertEqual(public["assumptions"]["seeds"], list(range(42, 62)))
        self.assertEqual(public["scenarios"]["B"]["phaseCodes"][1], [4, 10])
        self.assertEqual(public["scenarios"]["C"]["lanesByCode"]["8"], 3)
        self.assertGreater(public["scenarios"]["A"]["paired"]["endQueue"]["mean"], 0)
        self.assertLess(public["scenarios"]["B"]["paired"]["endQueue"]["mean"], 0)


if __name__ == "__main__":
    unittest.main()
