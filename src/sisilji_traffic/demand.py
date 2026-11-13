"""Synthetic, seeded departure requests, independent of SUMO's future state."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path
import random
from typing import Mapping

from .network import ROUTES

SCENARIOS = ("normal", "imbalanced", "surge", "downstream")


@dataclass(frozen=True, order=True)
class Departure:
    time: int
    route_id: str
    vehicle_id: str


def generate_from_rates(
    rates: Mapping[str, float], start: int, end: int, seed: int, prefix: str = "forecast"
) -> list[Departure]:
    """Draw a Poisson arrival process per route, quantised to integer seconds.

    Rates are requests per second, not assumed successful insertions. A forecast
    caller must pass only rates computed from completed observed history.
    """
    if start < 0 or end <= start:
        raise ValueError("Demand requires 0 <= start < end")
    rng = random.Random(seed)
    departures = []
    for route in sorted(rates):
        if route not in ROUTES:
            raise ValueError(f"Unknown route: {route}")
        rate = float(rates[route])
        if not math.isfinite(rate) or rate < 0:
            raise ValueError("Arrival rates must be finite and nonnegative")
        if rate == 0:
            continue
        time = float(start)
        index = 0
        while True:
            time += rng.expovariate(rate)
            second = math.floor(time)
            if second >= end:
                break
            departures.append(Departure(second, route, f"{prefix}_{route}_{index}"))
            index += 1
    return sorted(departures)


def generate_demand(scenario: str, duration: int, seed: int = 42) -> list[Departure]:
    """Generate fictional requests; no camera or historical dataset is needed.

    'downstream' raises C's cross traffic. It does not secretly change physical
    capacity or A/C signal programs and is only a congestion stress scenario,
    not a guaranteed labelled downstream blockage.
    """
    if scenario not in SCENARIOS:
        raise ValueError(f"Choose one of {SCENARIOS}")
    rates = {route: 180 / 3600 for route in ROUTES}
    rates.update(eastbound=280 / 3600, westbound=280 / 3600)
    if scenario in ("imbalanced", "surge"):
        rates.update(eastbound=520 / 3600, westbound=180 / 3600,
                     B_ns=95 / 3600, B_sn=95 / 3600)
    elif scenario == "downstream":
        rates.update(eastbound=570 / 3600, westbound=240 / 3600,
                     C_ns=430 / 3600, C_sn=430 / 3600)
    if scenario == "surge":
        split = duration // 2
        first = {route: rate * 0.55 for route, rate in rates.items()}
        return sorted(generate_from_rates(first, 0, split, seed, "real_before") +
                      generate_from_rates(rates, split, duration, seed + 1, "real_after"))
    return generate_from_rates(rates, 0, duration, seed, "real")


def write_demand(path: str | Path, departures: list[Departure]) -> None:
    Path(path).write_text(json.dumps([asdict(d) for d in departures], indent=2) + "\n", encoding="utf-8")
