"""Field CSV validation and agreement between event replay and experiment outputs."""
import csv
import io
import sys
import unittest
from pathlib import Path

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from system.backend.field_validation import FIELDS, TIMING_FIELDS
from system.backend.web import (
    EventCycleInput, ExperimentInput, FieldObservations, experiment, trace_step, validate_observations,
)


def csv_document(rows, header=FIELDS):
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(header)
    writer.writerows(rows)
    return output.getvalue()


def validate_text(text):
    return validate_observations(FieldObservations(csv_text=text))


# Observations bracket the end of green and the final service opportunity.
FIELD_ROWS = (
    ("site-A-day-1", 1, 30, 1, "45;29.80;1", 1, 3),
    ("site-A-day-1", 2, 20, 2, "54.90", 3, 0),
    ("site-A-day-1", 3, 30, 0, "", 0, 0),
    ("site-A-day-1", 4, 20, 1, "", 1, 0),
)


class FieldComparisonTests(unittest.TestCase):
    def test_observed_counts_remain_independent_of_predictions(self):
        report = validate_text("\ufeff" + csv_document(reversed(FIELD_ROWS)))
        self.assertEqual(report["cycles"], 1)
        self.assertEqual(report["direction_bias"], [-1, 1, 0, 0])
        self.assertEqual(report["direction_mae"], [1, 1, 0, 0])
        self.assertEqual(report["queue_mae"], 0.5)
        self.assertEqual(report["timing_source"], "assumed_120s")
        self.assertEqual([r["predicted_end"] for r in report["rows"]], [2, 1, 0, 0])
        self.assertEqual([r["predicted_passed"] for r in report["rows"]], [2, 2, 0, 1])

    def test_measured_windows_override_nominal_order_and_clearance(self):
        rows = [
            ("long", 1, 5, 0, "100;151;154.80;299.99", 2, 2, 300, 150),
            ("long", 2, 10, 1, "", 1, 0, 300, 0),
            ("long", 3, 25, 0, "", 0, 0, 300, 30),
            ("long", 4, 12, 0, "", 0, 0, 300, 10),
            ("short", 1, 5, 0, "6", 1, 0, 30, 20),
            ("short", 2, 5, 0, "", 0, 0, 30, 0),
            ("short", 3, 5, 0, "", 0, 0, 30, 5),
            ("short", 4, 4, 0, "", 0, 0, 30, 13),
        ]
        report = validate_text(csv_document(rows, FIELDS + TIMING_FIELDS))
        self.assertEqual(report["cycles"], 2)
        self.assertEqual(report["timing_source"], "observed_windows")
        self.assertEqual(report["queue_mae"], 0)
        first = report["rows"][0]
        # Only two of the four arrivals reach a slot in the actual 150..155 s green.
        self.assertEqual((first["cycle_s"], first["green_start_s"], first["green_s"]), (300, 150, 5))
        self.assertEqual((first["predicted_passed"], first["predicted_end"]), (2, 2))

    def test_observed_windows_validate_cycle_and_time_bounds(self):
        header = FIELDS + TIMING_FIELDS
        rows = [(*row, 120, start) for row, start in zip(FIELD_ROWS, (0, 35, 60, 95))]
        measured = validate_text(csv_document(rows, header))
        legacy = validate_text(csv_document(FIELD_ROWS))
        self.assertEqual(legacy["rows"], measured["rows"])
        for label, index, value in (
            ("cycle below range", -2, 29), ("cycle above range", -2, 301),
            ("inconsistent cycle", -2, 119), ("negative start", -1, -1),
            ("overlap", -1, 6), ("passes cycle end", -1, 92),
            ("fractional window", -1, 0.1), ("empty timing value", -1, ""),
        ):
            updated = [list(row) for row in rows]
            updated[0][index] = value
            with self.subTest(label=label), self.assertRaises(HTTPException) as ctx:
                validate_text(csv_document(updated, header))
            self.assertEqual(ctx.exception.status_code, 422)
        for column in TIMING_FIELDS:
            with self.subTest(column=column), self.assertRaises(HTTPException) as ctx:
                validate_text(csv_document(rows, (*FIELDS, column)))
            self.assertEqual(ctx.exception.status_code, 422)

    def test_rejects_inconsistent_observations_with_http_422(self):
        bad_documents = {
            "header": csv_document(FIELD_ROWS, header=FIELDS[:-1]),
            "no data": csv_document([]),
            "missing phase": csv_document(FIELD_ROWS[:-1]),
            "duplicate phase": csv_document((*FIELD_ROWS, FIELD_ROWS[0])),
            "timing sum": csv_document([(*FIELD_ROWS[0][:2], 29, *FIELD_ROWS[0][3:]), *FIELD_ROWS[1:]]),
            "broken quotes": csv_document([]) + '"unfinished',
        }
        for label, column, value in (
            ("conservation", 6, 0), ("non-finite timestamp", 4, "nan;3;5"),
            ("cycle boundary", 4, "0;3;120"), ("negative time", 4, "-1;3;5"),
            ("invalid vehicle count", 3, "1.2"),
        ):
            row = list(FIELD_ROWS[0])
            row[column] = value
            bad_documents[label] = csv_document([row, *FIELD_ROWS[1:]])
        for label, contents in bad_documents.items():
            with self.subTest(label=label), self.assertRaises(HTTPException) as ctx:
                validate_text(contents)
            self.assertEqual(ctx.exception.status_code, 422)


class TraceAgreementTests(unittest.TestCase):
    def test_seeded_replay_matches_paired_experiment_and_recorded_field_rows(self):
        rates = (900, 240, 480, 180)
        initial = (6, 0, 0, 0)
        cycles = 4
        seed = 107
        field_rows = []
        for condition in ("normal", "missing", "blocked"):
            results = experiment(ExperimentInput(
                rates=rates, initial=initial, condition=condition, cycles=cycles, replications=2, seed=seed,
            ))
            paired_arrivals = []
            for mode, name in (("fixed", "fixed"), ("auto", "adaptive")):
                start = initial
                current = (30, 20, 30, 20)
                mean = None
                stopped_vehicle_seconds = 0.0
                entered = sum(initial)
                for cycle in range(cycles):
                    step = trace_step(EventCycleInput(
                        rates=rates, residual=start, current=current, mean=mean, mode=mode,
                        condition=condition, seed=seed, cycle=cycle,
                    ))
                    arrivals, departures = step["arrivals"], step["departures"]
                    if mode == "fixed":
                        paired_arrivals.append(arrivals)
                    else:
                        self.assertEqual(arrivals, paired_arrivals[cycle])
                    entered += sum(map(len, arrivals))
                    green_start = 0
                    for phase, green in enumerate(step["applied"]):
                        self.assertTrue(all(green_start <= t < green_start + green for t in departures[phase]))
                        green_start += green + 5
                        events = [(t, 1) for t in arrivals[phase]] + [(t, -1) for t in departures[phase]]
                        queue = start[phase]
                        last = 0.0
                        for t, change in sorted(events):
                            stopped_vehicle_seconds += (t - last) * queue
                            queue += change
                            self.assertGreaterEqual(queue, 0)
                            last = t
                        stopped_vehicle_seconds += (120 - last) * queue
                        self.assertEqual(queue, step["residual"][phase])
                        if condition == "normal":
                            field_rows.append((
                                f"{mode}-{cycle}", phase + 1, green, start[phase],
                                ";".join(map(str, arrivals[phase])), len(departures[phase]), queue,
                            ))
                    if condition == "blocked":
                        self.assertEqual(departures[0], [])
                    start = step["residual"]
                    current = step["recommended"] if mode == "auto" else step["applied"]
                    mean = step["mean"]
                self.assertAlmostEqual(stopped_vehicle_seconds / entered, results["runs"][0][f"{name}_wait_s"])
        # Replaying generated records checks software consistency; it does not
        # establish whether the model reproduces independent field observations.
        report = validate_text(csv_document(field_rows))
        self.assertEqual(report["cycles"], cycles * 2)
        self.assertEqual(report["direction_mae"], [0, 0, 0, 0])


if __name__ == "__main__":
    unittest.main()
