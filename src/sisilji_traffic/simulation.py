"""TraCI runtime with explicit past-only snapshots and counterfactual branches.

This is a complete-SUMO-state experiment, not an estimator validated on video.
No future vehicles or flows are loaded into SUMO: requests are inserted only
when due, and a planning branch receives its own independently generated future.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict
import json
import math
from pathlib import Path
from typing import Iterable, Mapping
import uuid
import xml.etree.ElementTree as ET

from .demand import Departure
from .network import (
    B_DOWNSTREAM, B_INCOMING, CYCLE_SECONDS, Network, REFERENCE_GREENS,
    ROUTES, phase_specs, resolve_binary,
)


class Simulator:
    """Run or restore a fictional corridor; times and requests use seconds.

    ``run_until`` accepts full demand lists and ignores already submitted IDs.
    ``metrics`` integrates from start, or from the most recent snapshot load /
    ``reset_metrics``. ``load_snapshot`` reuses a process for candidate trials,
    while reloading its small network to clear SUMO's pending-vehicle registry.
    A snapshot's Python ledger explicitly restores overdue uninserted requests,
    which SUMO's saveState does not itself retain.
    """

    def __init__(self, network: Network, workdir: str | Path | None = None,
                 seed: int = 0, snapshot: str | Path | None = None):
        self.network = network
        self.workdir = Path(workdir or network.directory / "runtime").resolve()
        self.workdir.mkdir(parents=True, exist_ok=True)
        self.seed = seed
        self.initial_snapshot = snapshot
        self.connection = None
        self._log = None
        self._label = f"sisilji_{uuid.uuid4().hex}"
        self._reset_python_state()

    def _reset_python_state(self):
        self._pending: dict[str, Departure] = {}
        self._submitted: set[str] = set()
        self._request_counts: dict[int, dict[str, int]] = {}
        self._cycles: list[dict] = []
        self._cycle = self._new_cycle()
        self._prior_edge_ids = [set() for _ in range(4)]
        self._green_elapsed = [0] * 4
        self._no_discharge_streak = [0] * 4
        self._last_phase = 0
        self._greens = tuple(REFERENCE_GREENS)
        self._j = 0.0
        self._arrived = 0
        self._departed = 0
        self._teleports = 0
        self._collisions = 0
        self._history: list[dict] = []
        self._origin = (0.0, 0, 0, 0, 0)
        self._restored_observation = None

    @staticmethod
    def _new_cycle():
        return {"inflow": [0] * 4, "residual_queues": [0] * 4,
                "green_no_discharge": [False] * 4, "queues_end": [0] * 4}

    @property
    def time(self) -> int:
        return int(round(self.connection.simulation.getTime()))

    def __enter__(self):
        try:
            import traci
        except ImportError as exc:
            raise RuntimeError("TraCI is required; install the project with its SUMO dependencies") from exc
        self._traci = traci
        self._log = (self.workdir / f"{self._label}.log").open("w", encoding="utf-8")
        cmd = [resolve_binary("sumo"), "-c", str(self.network.config_file),
               "--seed", str(self.seed), "--step-length", "1",
               "--no-step-log", "true", "--duration-log.disable", "true",
               "--time-to-teleport", "-1", "--collision.action", "warn",
               "--save-state.rng", "true", "--save-state.precision", "16",
               "--thread-rngs", "1", "--error-log", str(self.workdir / f"{self._label}.errors.log")]
        self._load_args = cmd[1:]
        try:
            traci.start(cmd, label=self._label, doSwitch=False, stdout=self._log)
            self.connection = traci.getConnection(self._label)
            self.version = self.connection.getVersion()
            self.capacities = tuple(self._capacity(edge) for edge in B_INCOMING)
            self.downstream_capacities = tuple(self._capacity(edge) for edge in B_DOWNSTREAM)
            if self.initial_snapshot is not None:
                self.load_snapshot(self.initial_snapshot)
            return self
        except Exception:
            self.close()
            raise

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()

    def close(self):
        if self.connection is not None:
            self.connection.close()
            self.connection = None
        if self._log is not None:
            self._log.close()
            self._log = None

    def _capacity(self, edge):
        return max(1, math.floor(self.connection.lane.getLength(edge + "_0") / 7.5))

    def _queues(self):
        if self._restored_observation is not None:
            return tuple(self._restored_observation["queues"])
        return tuple(self.connection.edge.getLastStepHaltingNumber(edge) for edge in B_INCOMING)

    def _downstream(self):
        if self._restored_observation is not None:
            return tuple(self._restored_observation["downstream_counts"])
        return tuple(self.connection.edge.getLastStepVehicleNumber(edge) for edge in B_DOWNSTREAM)

    def _set_greens(self, greens):
        phases = [self._traci.trafficlight.Phase(duration, state)
                  for duration, state in phase_specs(greens)]
        logic = self._traci.trafficlight.Logic("reference", 0, 0, phases)
        self.connection.trafficlight.setProgramLogic("B", logic)
        self.connection.trafficlight.setProgram("B", "reference")
        self.connection.trafficlight.setPhase("B", 0)
        self.connection.trafficlight.setPhaseDuration("B", float(greens[0]))
        self._greens = tuple(greens)

    def _add_request(self, departure: Departure, restoring=False):
        if departure.route_id not in ROUTES:
            raise ValueError(f"Unknown route {departure.route_id}")
        # Restored pending departures are made eligible immediately. Their
        # original requested departure remains in the ledger and burden metric.
        depart = "now" if restoring else str(departure.time)
        self.connection.vehicle.add(departure.vehicle_id, departure.route_id,
                                    typeID="car", depart=depart, departLane="0", departSpeed="0")
        self._pending[departure.vehicle_id] = departure
        self._submitted.add(departure.vehicle_id)
        if not restoring:
            bucket = departure.time // CYCLE_SECONDS
            counts = self._request_counts.setdefault(bucket, {r: 0 for r in ROUTES})
            counts[departure.route_id] += 1

    def run_until(self, end: int, departures: Iterable[Departure] = (),
                  actions: Mapping[int, tuple[int, int, int, int]] | None = None):
        """Step to ``end``, applying B programs only at global cycle boundaries.

        Caller-owned departures may include hidden future demand only in the
        evaluator's process. The simulator submits none of it before it is due.
        """
        if int(end) != end or end < self.time:
            raise ValueError("end must be an integer at or after current time")
        schedule: dict[int, list[Departure]] = defaultdict(list)
        seen = set()
        for departure in departures:
            if departure.vehicle_id in seen:
                raise ValueError(f"Duplicate departure ID: {departure.vehicle_id}")
            seen.add(departure.vehicle_id)
            if departure.time >= self.time and departure.time < end and departure.vehicle_id not in self._submitted:
                schedule[departure.time].append(departure)
        actions = actions or {}
        for when, greens in actions.items():
            if int(when) != when or when % CYCLE_SECONDS:
                raise ValueError("Signal changes must be at a 120-second cycle boundary")
            phase_specs(greens)
        while self.time < end:
            now = self.time
            if now in actions:
                self._set_greens(actions[now])
            for departure in sorted(schedule.get(now, ())):
                self._add_request(departure)
            before_phase = self.connection.trafficlight.getPhase("B")
            self.connection.simulationStep()
            self._restored_observation = None
            for vid in self.connection.simulation.getDepartedIDList():
                self._pending.pop(vid, None)
                self._departed += 1
            self._arrived += self.connection.simulation.getArrivedNumber()
            self._teleports += self.connection.simulation.getStartingTeleportNumber()
            self._collisions += self.connection.simulation.getCollidingVehiclesNumber()
            active = self.connection.vehicle.getIDCount()
            # A right-endpoint, one-second integral includes all unfinished and
            # overdue uninserted requests; it never averages completed trips only.
            self._j += active + len(self._pending)
            self._observe_step(before_phase)
        return self.metrics()

    def _observe_step(self, before_phase):
        current_ids = [set(self.connection.edge.getLastStepVehicleIDs(edge)) for edge in B_INCOMING]
        queues = self._queues()
        outflows = []
        for i, ids in enumerate(current_ids):
            self._cycle["inflow"][i] += len(ids - self._prior_edge_ids[i])
            outflows.append(len(self._prior_edge_ids[i] - ids))
            if before_phase == i * 3:
                self._green_elapsed[i] += 1
                if self._green_elapsed[i] > 3 and self._prior_edge_ids[i] and outflows[i] == 0:
                    self._no_discharge_streak[i] += 1
                    if self._no_discharge_streak[i] >= 10:
                        self._cycle["green_no_discharge"][i] = True
                else:
                    self._no_discharge_streak[i] = 0
            else:
                self._green_elapsed[i] = 0
                self._no_discharge_streak[i] = 0
        after_phase = self.connection.trafficlight.getPhase("B")
        if before_phase % 3 == 0 and after_phase != before_phase:
            self._cycle["residual_queues"][before_phase // 3] = queues[before_phase // 3]
        self._prior_edge_ids = current_ids
        self._last_phase = after_phase
        if self.time % CYCLE_SECONDS == 0:
            self._cycle["queues_end"] = list(queues)
            self._cycles.append(self._cycle)
            self._cycle = self._new_cycle()
        if self.time % 10 == 0:
            self._history.append({"time": self.time, "queues": list(queues),
                                  "downstream_counts": list(self._downstream()),
                                  "active": self.connection.vehicle.getIDCount(),
                                  "uninserted": len(self._pending)})

    def observe(self) -> dict:
        """Planner-facing current/past features, explicitly complete-state mode."""
        return {
            "observed_at": self.time,
            "queues": self._queues(),
            "capacities": self.capacities,
            "downstream_counts": self._downstream(),
            "downstream_capacities": self.downstream_capacities,
            "cycles": tuple(dict(c) for c in self._cycles[-4:]),
            "valid_fraction": 1.0,
            "signal_complete": True,
            "state_valid": True,
        }

    def recent_route_rates(self, cycles: int = 3) -> dict[str, float]:
        """Completed-cycle external request rates, not future file contents.

        This assumes perfect observation of attempted boundary entry requests,
        including those unable to insert. It is a fictional full-state sensor
        assumption; real roadside counts would need queue/censoring treatment.
        """
        completed = self.time // CYCLE_SECONDS
        first = max(0, completed - cycles)
        count = completed - first
        if count == 0:
            return {route: 0.0 for route in ROUTES}
        return {route: sum(self._request_counts.get(k, {}).get(route, 0)
                           for k in range(first, completed)) / (count * CYCLE_SECONDS)
                for route in ROUTES}

    @property
    def history(self) -> list[dict]:
        return list(self._history)

    def reset_metrics(self):
        self._origin = (self._j, self._arrived, self._departed, self._teleports, self._collisions)

    def metrics(self) -> dict:
        return {
            "objective_j": self._j - self._origin[0],
            "terminal_vehicles": self.connection.vehicle.getIDCount(),
            "terminal_uninserted": len(self._pending),
            "terminal_queues": self._queues(),
            "teleports": self._teleports - self._origin[3],
            "collisions": self._collisions - self._origin[4],
            "arrived": self._arrived - self._origin[1],
            "departed": self._departed - self._origin[2],
            "scheduled": len(self._submitted),
            "time": self.time,
        }

    def save_snapshot(self, path: str | Path) -> Path:
        """Save the current state and due pending ledger, never future requests."""
        path = Path(path).resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        xml_path = path.with_suffix(".sumo.xml")
        self.connection.simulation.saveState(str(xml_path))
        # SUMO 1.28 writes TraCI-created pending vehicle records but does not
        # restore their insertion queue. Canonicalise the XML to active state
        # only, then restore every overdue request from our explicit ledger.
        # This also works with versions that omit pending records altogether.
        if self._pending:
            tree = ET.parse(xml_path)
            root = tree.getroot()
            for vehicle in list(root.findall("vehicle")):
                if vehicle.get("id") in self._pending:
                    root.remove(vehicle)
            tree.write(xml_path, encoding="utf-8", xml_declaration=True)
        signals = {}
        for junction in "ABC":
            signals[junction] = {
                "phase": self.connection.trafficlight.getPhase(junction),
                "remaining": max(0.001, self.connection.trafficlight.getNextSwitch(junction) - self.time),
            }
        state = {
            "schema_version": 1, "time": self.time, "sumo_state": xml_path.name,
            "complete_state_assumption": True,
            "pending": [asdict(d) for d in sorted(self._pending.values())],
            "submitted": sorted(self._submitted),
            "request_counts": self._request_counts, "cycles": self._cycles,
            "cycle": self._cycle, "prior_edge_ids": [sorted(x) for x in self._prior_edge_ids],
            "green_elapsed": self._green_elapsed, "no_discharge_streak": self._no_discharge_streak,
            "greens": list(self._greens), "signals": signals,
            "j": self._j, "arrived": self._arrived, "departed": self._departed,
            "teleports": self._teleports, "collisions": self._collisions,
            "history": self._history,
            "observation": {"queues": list(self._queues()),
                            "downstream_counts": list(self._downstream())},
        }
        path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        return path

    def load_snapshot(self, path: str | Path):
        """Restore a past-only snapshot, reusing the same TraCI process.

        A full ``load`` first clears pending IDs retained in SUMO's vehicle
        registry by ``simulation.loadState`` alone. Then the saved signal
        program and state are restored and overdue pending requests re-added.
        """
        path = Path(path).resolve()
        state = json.loads(path.read_text(encoding="utf-8"))
        if state.get("schema_version") != 1:
            raise ValueError("Unsupported snapshot schema")
        self.connection.load(self._load_args)
        # loadState restores phase and its elapsed time, but it relies on the
        # current program definition. Restore that definition first; calling
        # setPhase after loadState would discard the restored phase clock.
        self._set_greens(tuple(state["greens"]))
        self.connection.simulation.loadState(str(path.parent / state["sumo_state"]))
        self._pending = {}
        self._submitted = set(state["submitted"])
        self._request_counts = {int(k): v for k, v in state["request_counts"].items()}
        self._cycles = state["cycles"]
        self._cycle = state["cycle"]
        self._prior_edge_ids = [set(x) for x in state["prior_edge_ids"]]
        self._green_elapsed = state["green_elapsed"]
        self._no_discharge_streak = state["no_discharge_streak"]
        self._greens = tuple(state["greens"])
        self._j = state["j"]
        self._arrived = state["arrived"]
        self._departed = state["departed"]
        self._teleports = state["teleports"]
        self._collisions = state["collisions"]
        self._history = state["history"]
        # Last-step edge aggregates are not populated until the first step
        # after loadState. Preserve the actual cutoff observation meanwhile.
        self._restored_observation = state.get("observation")
        for junction, info in state["signals"].items():
            phase = self.connection.trafficlight.getPhase(junction)
            remaining = self.connection.trafficlight.getNextSwitch(junction) - self.time
            if phase != info["phase"] or abs(remaining - info["remaining"]) > 0.01:
                raise RuntimeError(f"Signal phase/remaining time was not restored at {junction}")
        # SUMO explicitly omits not-yet-departed vehicles from saveState. Its
        # present IDs include active vehicles; ledger entries describe only
        # already requested but still uninserted vehicles.
        active = set(self.connection.vehicle.getIDList())
        pending_in_sumo = set(self.connection.simulation.getPendingVehicles())
        for item in state["pending"]:
            departure = Departure(**item)
            if departure.time >= state["time"]:
                raise ValueError("Snapshot includes a future departure request")
            if departure.vehicle_id in active:
                continue
            if departure.vehicle_id in pending_in_sumo:
                self._pending[departure.vehicle_id] = departure
            else:
                self._add_request(departure, restoring=True)
        self._last_phase = self.connection.trafficlight.getPhase("B")
        self.reset_metrics()
        if self.time != state["time"]:
            raise RuntimeError("Snapshot time was not restored")
