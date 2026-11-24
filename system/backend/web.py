"""시흥 교차로 관제 시제품의 위치 조회 및 가상 신호주기 계산 API."""
import csv
import math
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .static_assets import TrafficAssets
from .engine import GreenSplitController, MovementMeasure
from .engine.evaluation import PHASES, cycle_rng, evaluate, generate_arrivals, observe_cycle, serve_cycle
from .field_validation import validate_field_csv
from .regional_cctv import router as regional_cctv_router, camera_lifespan

SYSTEM = Path(__file__).resolve().parents[1]
app = FastAPI(title="시흥 교통관제", lifespan=camera_lifespan)
app.include_router(regional_cctv_router)
# 행정동 경계에 걸친 법정동은 기획서의 교차로별 분류를 따릅니다.
DISTRICTS = {
    "월곶동": (7, 37, 38, 45, 46, 82), "군자동": (5, 72), "장곡동": (31,),
    "능곡동": (10,), "연성동": (33, 52, 60), "목감동": (14, 15, 16, 53, 83),
}
PLAN = tuple(p.plan_green for p in PHASES)


@app.get("/api/intersections")
@lru_cache
def intersections():
    areas = {i: name for name, ids in DISTRICTS.items() for i in ids}
    with (SYSTEM / "data" / "siheung_smart_intersections_2025-11-05.csv").open(encoding="utf-8-sig") as f:
        return [
            {"id": row["현장번호"], "name": row["스마트 교차로명"], "district": areas[n],
             "address": row["스마트 교차로 주소(지번)"], "lat": float(row["위도"]),
             "lon": float(row["경도"]), "date": row["데이터기준일"]}
            for row in csv.DictReader(f) if (n := int(row["연번"])) in areas
        ]


Rate = Annotated[int, Field(strict=True, ge=0, le=1800)]
Count = Annotated[float, Field(allow_inf_nan=False, ge=0, le=10000000)]
Second = Annotated[int, Field(strict=True, ge=15, le=45)]
Greens = tuple[Second, Second, Second, Second]
Counts = tuple[Count, Count, Count, Count]


class CycleInput(BaseModel):
    rates: tuple[Rate, Rate, Rate, Rate]
    residual: Counts
    current: Greens = PLAN
    mean: tuple[Count | None, Count | None, Count | None, Count | None] | None = None
    mode: Literal["auto", "fixed", "manual"] = "auto"
    manual: Greens | None = None
    condition: Literal["normal", "blocked", "missing"] = "normal"


def validate_greens(values: Greens):
    if sum(values) != sum(PLAN):
        raise HTTPException(422, "네 현시의 녹색시간 합을 100초로 맞춰 주세요.")
    if any(abs(v - p) > 10 for v, p in zip(values, PLAN)):
        raise HTTPException(422, "각 현시는 기준 계획에서 10초 이내로 조정해 주세요.")


@app.post("/api/simulation/step")
def advance(data: CycleInput):
    validate_greens(data.current)
    if data.mode == "manual":
        if data.manual is None:
            raise HTTPException(422, "수동 녹색시간을 입력해 주세요.")
        validate_greens(data.manual)
    ctl = GreenSplitController(PHASES)
    keys = [p.id for p in PHASES]
    ctl.current = dict(zip(keys, data.current))
    if data.mean is not None:
        ctl.mean_arrivals = {k: value for k, value in zip(keys, data.mean) if value is not None}
    arrivals = [rate / 30 for rate in data.rates]  # 고정 주기 120초
    measures = {
        k: MovementMeasure(arrivals=arrivals[i], residual=data.residual[i],
                           downstream_blocked=data.condition == "blocked" and i == 0,
                           valid=not (data.condition == "missing" and i == 0))
        for i, k in enumerate(keys)
    }
    decision = ctl.step(measures)
    proposed = tuple(decision.greens[k] for k in keys)
    applied = {"auto": proposed, "fixed": PLAN, "manual": data.manual}[data.mode]
    # 한 주기의 유입과 통과 가능 대수만으로 다음 잔류를 근사합니다.
    left = []
    for i, p in enumerate(PHASES):
        m = p.movements[0]
        capacity = math.floor((applied[i] - ctl.config.startup_loss) * m.lanes / m.sat_headway)
        if measures[p.id].downstream_blocked:
            capacity = 0
        left.append(max(0, data.residual[i] + arrivals[i] - capacity))
    return {"recommended": proposed, "applied": applied, "residual": left,
            "mean": [ctl.mean_arrivals.get(k) for k in keys],
            "weights": [decision.weights[k] for k in keys], "limits": [decision.bound_hits.get(k) for k in keys],
            "fallback": decision.fallback, "oversaturated": decision.oversaturated}


VehicleCount = Annotated[int, Field(strict=True, ge=0, le=1000000)]
InitialCount = Annotated[int, Field(strict=True, ge=0, le=1000)]
Seed = Annotated[int, Field(strict=True, ge=0, le=2147483647)]
Condition = Literal["normal", "blocked", "missing"]


class EventCycleInput(BaseModel):
    rates: tuple[Rate, Rate, Rate, Rate]
    residual: tuple[VehicleCount, VehicleCount, VehicleCount, VehicleCount]
    current: Greens = PLAN
    mean: tuple[Count | None, Count | None, Count | None, Count | None] | None = None
    mode: Literal["auto", "fixed"]
    condition: Condition = "normal"
    seed: Seed = 42
    cycle: Annotated[int, Field(strict=True, ge=0, le=1000000)] = 0


@app.post("/api/simulation/trace-step")
def trace_step(data: EventCycleInput):
    validate_greens(data.current)
    keys = [p.id for p in PHASES]
    greens = PLAN if data.mode == "fixed" else data.current
    arrivals = generate_arrivals(data.rates, cycle_rng(data.seed, 0, data.cycle))
    departures = serve_cycle(data.residual, arrivals, greens, data.condition)
    ctl = GreenSplitController(PHASES)
    ctl.current = dict(zip(keys, greens))
    if data.mean is not None:
        ctl.mean_arrivals = {k: v for k, v in zip(keys, data.mean) if v is not None}
    next_plan = ctl.step(observe_cycle(data.residual, arrivals, greens, departures, data.condition))
    return {"applied": greens, "recommended": [next_plan.greens[k] for k in keys],
            "mean": [ctl.mean_arrivals.get(k) for k in keys],
            "residual": [n + len(a) - len(d) for n, a, d in zip(data.residual, arrivals, departures)],
            "weights": [next_plan.weights[k] for k in keys], "limits": [next_plan.bound_hits.get(k) for k in keys],
            "fallback": next_plan.fallback, "oversaturated": next_plan.oversaturated,
            "arrivals": arrivals, "departures": departures}


class ExperimentInput(BaseModel):
    rates: tuple[Rate, Rate, Rate, Rate]
    initial: tuple[InitialCount, InitialCount, InitialCount, InitialCount]
    condition: Condition = "normal"
    cycles: Annotated[int, Field(strict=True, ge=1, le=30)] = 10
    replications: Annotated[int, Field(strict=True, ge=2, le=30)] = 10
    seed: Seed = 42
    profile: Literal["steady", "surge"] = "steady"


@app.post("/api/simulation/evaluate")
def experiment(data: ExperimentInput):
    return evaluate(**data.model_dump())


class FieldObservations(BaseModel):
    csv_text: Annotated[str, Field(min_length=1, max_length=500000)]


@app.post("/api/simulation/validate-field")
def validate_observations(data: FieldObservations):
    try:
        return validate_field_csv(data.csv_text)
    except (ValueError, csv.Error) as exc:
        raise HTTPException(422, str(exc)) from exc


dist = SYSTEM / "frontend" / "dist"
if dist.is_dir():
    app.mount("/", TrafficAssets(directory=dist, html=True), name="frontend")
