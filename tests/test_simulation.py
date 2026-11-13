"""Small real-SUMO integration tests for comparison and information contracts.

These require the installed SUMO/TraCI dependencies and local TCP sockets.
They assert reproducibility and accounting, never a positive policy benefit.
"""

import json
import math
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET

from sisilji_traffic.demand import Departure, generate_from_rates
from sisilji_traffic.network import (
    B_DOWNSTREAM,
    B_INCOMING,
    CYCLE_SECONDS,
    REFERENCE_GREENS,
    ROUTES,
    build_network,
    phase_specs,
)
from sisilji_traffic.simulation import Simulator


def signal_state(simulator, junction):
    tls = simulator.connection.trafficlight
    return (
        tls.getProgram(junction),
        tls.getPhase(junction),
        tls.getRedYellowGreenState(junction),
        tls.getNextSwitch(junction),
        tuple((phase.duration, phase.state)
              for logic in tls.getAllProgramLogics(junction)
              for phase in logic.phases),
    )


class SimulationContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="sisilji-sumo-tests-")
        cls.directory = Path(cls.temporary.name)
        cls.network = build_network(cls.directory / "network")

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_three_junction_directions_and_protected_phase_mapping(self):
        root = ET.parse(self.network.net_file).getroot()
        logics = {logic.get("id"): logic for logic in root.findall("tlLogic")}
        self.assertEqual(set(logics), {"A", "B", "C"})
        positions = {j.get("id"): float(j.get("x")) for j in root.findall("junction")
                     if j.get("id") in {"A", "B", "C"}}
        self.assertAlmostEqual(positions["B"] - positions["A"], 300.0)
        self.assertAlmostEqual(positions["C"] - positions["B"], 300.0)
        expected = phase_specs()
        self.assertEqual(len(expected), 12)
        self.assertEqual(sum(duration for duration, _ in expected), CYCLE_SECONDS)
        for junction, logic in logics.items():
            with self.subTest(junction=junction):
                self.assertEqual(float(logic.get("offset")), 0.0)
                actual = [(int(p.get("duration")), p.get("state"))
                          for p in logic.findall("phase")]
                self.assertEqual(actual, expected)
                for i in range(4):
                    self.assertEqual(actual[i * 3][1].count("G"), 1)
                    self.assertEqual(actual[i * 3][1][i], "G")
                    self.assertEqual(actual[i * 3 + 1], (3, "r" * i + "y" + "r" * (3 - i)))
                    self.assertEqual(actual[i * 3 + 2], (2, "rrrr"))
        b_connections = sorted((c for c in root.findall("connection") if c.get("tl") == "B"),
                               key=lambda c: int(c.get("linkIndex")))
        self.assertEqual(tuple(c.get("from") for c in b_connections), B_INCOMING)
        self.assertEqual(tuple(c.get("to") for c in b_connections), B_DOWNSTREAM)
        # All requests belong to the external ledger; route definitions contain
        # no preloaded vehicle/flow with a possibly hidden future departure.
        definitions = ET.parse(self.network.routes_file).getroot()
        self.assertEqual(definitions.findall("vehicle"), [])
        self.assertEqual(definitions.findall("flow"), [])

    def test_pending_burden_and_snapshot_replay_match_reference_continuation(self):
        requests = [Departure(0, "eastbound", f"load_{i:03}") for i in range(100)]
        snapshot_path = self.directory / "pending.json"
        with Simulator(self.network, self.directory / "pending", seed=7) as simulation:
            active_integral = pending_integral = 0
            for second in range(1, 11):
                step = simulation.run_until(second, requests)
                active_integral += step["terminal_vehicles"]
                pending_integral += step["terminal_uninserted"]
            self.assertGreater(pending_integral, 0)
            self.assertEqual(step["objective_j"], active_integral + pending_integral)
            self.assertGreater(step["objective_j"], active_integral)
            # No request can finish the complete corridor in these ten seconds.
            self.assertEqual(step["arrived"], 0)
            self.assertEqual(step["objective_j"], 1000.0)
            pending_at_cutoff = step["terminal_uninserted"]
            observed_at_cutoff = simulation.observe()
            simulation.save_snapshot(snapshot_path)
            ledger = json.loads(snapshot_path.read_text(encoding="utf-8"))
            self.assertEqual(len(ledger["pending"]), pending_at_cutoff)
            self.assertTrue(all(item["time"] < 10 for item in ledger["pending"]))

            simulation.reset_metrics()
            direct = simulation.run_until(140, requests, {120: REFERENCE_GREENS})
            direct_observation = simulation.observe()
            direct_signals = {j: signal_state(simulation, j) for j in "ABC"}

            for replay in range(2):
                with self.subTest(replay=replay):
                    simulation.load_snapshot(snapshot_path)
                    self.assertEqual(simulation.time, 10)
                    self.assertEqual(simulation.observe(), observed_at_cutoff)
                    self.assertEqual(simulation.metrics()["objective_j"], 0.0)
                    self.assertEqual(simulation.metrics()["terminal_uninserted"], pending_at_cutoff)
                    branch = simulation.run_until(140, requests, {120: REFERENCE_GREENS})
                    self.assertEqual(branch, direct)
                    self.assertEqual(simulation.observe(), direct_observation)
                    self.assertEqual({j: signal_state(simulation, j) for j in "ABC"}, direct_signals)

    def test_cutoff_snapshot_and_observed_rates_ignore_changed_future_tail(self):
        cutoff = 480
        past = generate_from_rates({route: 0.025 for route in ROUTES}, 0, cutoff, 19, "past")
        future_a = [Departure(cutoff, "eastbound", "future_a")]
        future_b = [Departure(cutoff + i, "B_ns", f"future_b_{i}") for i in range(400)]
        records = []
        for index, future in enumerate((future_a, future_b)):
            with Simulator(self.network, self.directory / f"cutoff_{index}", seed=23) as simulation:
                metrics = simulation.run_until(cutoff, past + future)
                path = simulation.save_snapshot(self.directory / f"cutoff_{index}.json")
                record = json.loads(path.read_text(encoding="utf-8"))
                xml = ET.parse(path.with_suffix(".sumo.xml")).getroot()
                xml_vehicle_ids = {vehicle.get("id") for vehicle in xml.iter("vehicle")}
                self.assertFalse(any(vid.startswith("future") for vid in record["submitted"]))
                self.assertFalse(any(item["vehicle_id"].startswith("future") for item in record["pending"]))
                self.assertFalse(any(vid.startswith("future") for vid in xml_vehicle_ids))
                self.assertEqual(set(record["submitted"]), {item.vehicle_id for item in past})
                record.pop("sumo_state")  # Snapshot filename is not traffic state.
                records.append((simulation.observe(), simulation.recent_route_rates(3), metrics, record))
        self.assertEqual(records[0], records[1])
        self.assertEqual(len(records[0][0]["cycles"]), 4)

    def test_restored_observation_preserves_nonzero_last_step_queue(self):
        # A north approach starts red, so vehicles queue before its first green.
        # SUMO's LastStep edge caches are not guaranteed to survive loadState;
        # the planner must still see the actual cutoff observation immediately.
        requests = [Departure(0, "B_ns", f"queue_{i:03}") for i in range(60)]
        with Simulator(self.network, self.directory / "queue_cache", seed=29) as simulation:
            simulation.run_until(30, requests)
            observed = simulation.observe()
            self.assertGreater(sum(observed["queues"]), 0)
            path = simulation.save_snapshot(self.directory / "queue_cache.json")
            simulation.run_until(60, requests)
            simulation.load_snapshot(path)
            self.assertEqual(simulation.observe(), observed)
            self.assertEqual(simulation.metrics()["terminal_queues"], observed["queues"])

    def test_b_candidate_keeps_a_c_controls_identical_and_outputs_finite_metrics(self):
        requests = generate_from_rates({route: 0.02 for route in ROUTES}, 0, 240, 31, "smoke")
        arms = []
        for index, greens in enumerate((REFERENCE_GREENS, (25, 25, 30, 20))):
            with Simulator(self.network, self.directory / f"controls_{index}", seed=37) as simulation:
                signal_trace = []
                for second in range(1, 241):
                    metrics = simulation.run_until(second, requests, {120: greens})
                    signal_trace.append({j: signal_state(simulation, j) for j in "ABC"})
                for name in ("objective_j", "terminal_vehicles", "terminal_uninserted",
                             "arrived", "departed", "scheduled"):
                    self.assertTrue(math.isfinite(metrics[name]), name)
                    self.assertGreaterEqual(metrics[name], 0, name)
                self.assertEqual(metrics["scheduled"], len(requests))
                self.assertEqual(metrics["teleports"], 0)
                self.assertEqual(metrics["collisions"], 0)
                self.assertEqual(len(metrics["terminal_queues"]), 4)
                self.assertEqual(metrics["time"], 240)
                arms.append(signal_trace)
        for index, (reference, candidate) in enumerate(zip(*arms), start=1):
            with self.subTest(second=index):
                self.assertEqual(reference["A"], candidate["A"])
                self.assertEqual(reference["C"], candidate["C"])
        self.assertTrue(any(reference["B"] != candidate["B"]
                            for reference, candidate in zip(*arms)))

    def test_rejects_non_boundary_action_and_illegal_green_program(self):
        with self.assertRaises(ValueError):
            phase_specs((30, 20, 30, 21))
        with self.assertRaises(ValueError):
            phase_specs((10, 40, 30, 20))
        with Simulator(self.network, self.directory / "invalid", seed=41) as simulation:
            with self.assertRaisesRegex(ValueError, "cycle boundary"):
                simulation.run_until(10, (), {1: REFERENCE_GREENS})
            self.assertEqual(simulation.time, 0)


if __name__ == "__main__":
    unittest.main()
