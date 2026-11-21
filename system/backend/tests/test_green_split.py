"""배분 엔진 단위 시험. 실행: python3 -m unittest discover -s system/backend/tests"""

import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import EngineConfig, GreenSplitController, Movement, MovementMeasure, Phase  # noqa: E402


def doc_example_phases():
    """기술설계서 6.6절 가상 교차로: 주기 120초, 4현시, 녹색 합 100초."""
    return [
        Phase("P1", (Movement("EW_T", lanes=2),), plan_green=30, min_green=15, max_green=45),
        Phase("P2", (Movement("EW_L", lanes=1),), plan_green=20, min_green=15, max_green=45),
        Phase("P3", (Movement("NS_T", lanes=2),), plan_green=30, min_green=15, max_green=45),
        Phase("P4", (Movement("NS_L", lanes=1),), plan_green=20, min_green=15, max_green=45),
    ]


DOC_MEASURES = {
    "EW_T": MovementMeasure(arrivals=30, residual=6),
    "EW_L": MovementMeasure(arrivals=8),
    "NS_T": MovementMeasure(arrivals=16),
    "NS_L": MovementMeasure(arrivals=6),
}


class DocExampleTest(unittest.TestCase):
    def test_reproduces_section_6_6(self):
        ctl = GreenSplitController(doc_example_phases(), EngineConfig(alpha=0.5, max_change=10))
        d1 = ctl.step(DOC_MEASURES)
        self.assertEqual({k: round(v, 1) for k, v in d1.need.items()},
                         {"P1": 38.0, "P2": 18.0, "P3": 18.0, "P4": 14.0})
        self.assertEqual({k: round(v, 1) for k, v in d1.target.items()},
                         {"P1": 40.0, "P2": 21.6, "P3": 21.6, "P4": 16.8})
        self.assertEqual(d1.bound_hits, {"P1": "upper"})
        self.assertEqual(d1.greens, {"P1": 35, "P2": 21, "P3": 26, "P4": 18})
        d2 = ctl.step(DOC_MEASURES)
        self.assertEqual(d2.greens, {"P1": 38, "P2": 21, "P3": 24, "P4": 17})
        self.assertFalse(d2.oversaturated)
        self.assertIsNone(d2.fallback)


class InvariantTest(unittest.TestCase):
    def test_sum_and_bounds_hold_under_random_demand(self):
        rng = random.Random(7)
        ctl = GreenSplitController(doc_example_phases(), EngineConfig())
        for _ in range(500):
            measures = {m: MovementMeasure(arrivals=rng.uniform(0, 60), residual=rng.choice([0, 0, 3, 10]),
                                           downstream_blocked=rng.random() < 0.05,
                                           queue_overflow=rng.random() < 0.05)
                        for m in DOC_MEASURES}
            prev = dict(ctl.current)
            d = ctl.step(measures)
            self.assertEqual(sum(d.greens.values()), 100)
            for k, g in d.greens.items():
                lo, hi = d.bounds[k]
                # 경계가 현재 값을 따라 좁아지는 경우(하류 막힘, 관측 한계)에도 현재와 경계 사이에 있어야 한다
                self.assertGreaterEqual(g, min(lo, prev[k]) - 1)
                self.assertLessEqual(g, max(hi, prev[k]) + 1)
                self.assertGreaterEqual(g, 15)
                self.assertLessEqual(g, 45)

    def test_converges_to_target_within_one_second(self):
        ctl = GreenSplitController(doc_example_phases(), EngineConfig())
        for _ in range(15):
            d = ctl.step(DOC_MEASURES)
        for k, g in d.greens.items():
            self.assertLess(abs(g - d.target[k]), 1.0, (k, g, d.target[k]))

    def test_heavier_approach_gets_more_green(self):
        ctl = GreenSplitController(doc_example_phases(), EngineConfig())
        heavy = {"EW_T": MovementMeasure(40), "EW_L": MovementMeasure(8),
                 "NS_T": MovementMeasure(10), "NS_L": MovementMeasure(5)}
        for _ in range(10):
            d = ctl.step(heavy)
        self.assertGreater(d.greens["P1"], 30)
        self.assertLess(d.greens["P3"], 30)


class SafetyTest(unittest.TestCase):
    def test_invalid_measure_returns_toward_plan(self):
        ctl = GreenSplitController(doc_example_phases(), EngineConfig())
        for _ in range(5):
            ctl.step(DOC_MEASURES)
        self.assertNotEqual(ctl.current["P1"], 30)
        bad = dict(DOC_MEASURES, NS_T=MovementMeasure(16, valid=False))
        for _ in range(10):
            d = ctl.step(bad)
        self.assertIn("NS_T", d.fallback)
        self.assertEqual(d.greens, {"P1": 30, "P2": 20, "P3": 30, "P4": 20})

    def test_missing_measure_is_not_treated_as_zero(self):
        ctl = GreenSplitController(doc_example_phases(), EngineConfig())
        partial = {k: v for k, v in DOC_MEASURES.items() if k != "NS_L"}
        d = ctl.step(partial)
        self.assertIsNotNone(d.fallback)
        self.assertEqual(d.greens, {"P1": 30, "P2": 20, "P3": 30, "P4": 20})

    def test_downstream_blocked_phase_does_not_grow(self):
        ctl = GreenSplitController(doc_example_phases(), EngineConfig())
        blocked = dict(DOC_MEASURES, EW_T=MovementMeasure(30, residual=6, downstream_blocked=True))
        d = ctl.step(blocked)
        self.assertLessEqual(d.greens["P1"], 30)

    def test_infeasible_bounds_fall_back_to_plan(self):
        phases = [Phase("A", (Movement("a"),), plan_green=20, min_green=30, max_green=40),
                  Phase("B", (Movement("b"),), plan_green=20, min_green=15, max_green=40)]
        ctl = GreenSplitController(phases, EngineConfig())
        d = ctl.step({"a": MovementMeasure(10), "b": MovementMeasure(10)})
        self.assertIsNotNone(d.fallback)
        self.assertEqual(sum(d.greens.values()), 40)


if __name__ == "__main__":
    unittest.main()
