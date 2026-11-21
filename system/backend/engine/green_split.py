"""녹색신호 가중 배분 엔진(기술설계서 6장).

주기마다 CCTV로 잰 이동류별 도착 대수와 잔류 대기를 받아 다음 주기의 현시별 녹색시간을 낸다.
신호주기, 황색, 전적색은 건드리지 않으므로 녹색시간 합 G는 항상 그대로다.

순서(기술설계서 6.5절의 주기별 실행 순서):
    1. 측정 품질 확인. 하나라도 측정할 수 없으면 목표를 현행 계획으로 둔다(5.6절).
    2. 이동류 수요 = 도착 대수의 지수평균 + 잔류 대기(6.2절).
    3. 현시 필요 녹색 = 우선 계수 x 이동류 가운데 가장 큰 (출발 손실 + 포화 차두시간 x 수요 / 차로 수).
    4. 현시별 하한과 상한(최소 녹색, 보행 녹색, 최대 녹색, 현행 대비 허용 폭, 하류 막힘, 관측 한계, 6.4절).
    5. 범위 안에서 G를 필요 녹색 비율로 나눈 목표(6.3절, 6.4절).
    6. 현재 값에서 목표 쪽으로 alpha만큼 옮기고 정수 초로 맞춘다(6.5절).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Movement:
    """이동류(예: 동측 접근 직진과 좌회전). CCTV 검지 영역 하나에 대응한다."""

    id: str
    lanes: int = 1
    sat_headway: float = 2.0  # 포화 차두시간(초/대/차로). 영상으로 다시 추정하기 전 표준값


@dataclass(frozen=True)
class Phase:
    """현시. 방면마다 따로 녹색을 주는 교차로는 현시 하나에 방면 하나가 들어간다."""

    id: str
    movements: tuple[Movement, ...]
    plan_green: int  # 현행 계획의 녹색시간 g0
    min_green: int
    max_green: int
    ped_min_green: int = 0  # 함께 켜지는 횡단보도의 보행 녹색시간
    priority: float = 1.0  # 기관이 정하는 방향 우선 계수 rho


@dataclass(frozen=True)
class EngineConfig:
    startup_loss: float = 2.0  # 출발 손실시간 l_s
    alpha: float = 0.5  # 점진 계수
    beta: float = 0.5  # 도착 대수 지수평균에서 최근 주기 비중
    max_change: int = 10  # 현행 계획 대비 허용 폭 B(초)


@dataclass(frozen=True)
class MovementMeasure:
    """한 주기 동안 CCTV로 잰 이동류 값."""

    arrivals: float  # 진입선을 지난 도착 대수 A
    residual: float = 0.0  # 녹색이 끝날 때 남은 대기 R
    downstream_blocked: bool = False  # 하류 점유율이 기준 이상
    queue_overflow: bool = False  # 대기열 끝이 화면 밖(관측 한계)
    valid: bool = True  # 화각 일치, 프레임 수신, 검출 신뢰도를 통과했는지


@dataclass
class Decision:
    """한 주기의 판단 기록. 운영 화면의 "근거" 칸과 판단 기록 저장에 그대로 쓴다."""

    cycle: int
    greens: dict[str, int]  # 다음 주기에 적용할 녹색시간
    target: dict[str, float]  # 제약 안의 목표 녹색시간
    need: dict[str, float]  # 현시 필요 녹색시간 r_i
    weights: dict[str, float]  # w_i
    bounds: dict[str, tuple[int, int]]
    bound_hits: dict[str, str] = field(default_factory=dict)  # "upper" 또는 "lower"
    oversaturated: bool = False  # 필요 녹색 합이 G보다 큼. 녹색 재배분만으로 대기를 다 못 푼다
    fallback: str | None = None  # 현행 계획으로 되돌린 이유


class GreenSplitController:
    def __init__(self, phases: list[Phase], config: EngineConfig | None = None):
        if not phases:
            raise ValueError("현시가 하나 이상 있어야 합니다")
        self.phases = list(phases)
        self.config = config or EngineConfig()
        self.total_green = sum(p.plan_green for p in self.phases)
        self.current = {p.id: p.plan_green for p in self.phases}
        self.mean_arrivals: dict[str, float] = {}
        self.cycle = 0

    def step(self, measures: dict[str, MovementMeasure]) -> Decision:
        self.cycle += 1
        cfg = self.config
        plan = {p.id: float(p.plan_green) for p in self.phases}

        invalid = [m.id for p in self.phases for m in p.movements
                   if m.id not in measures or not measures[m.id].valid]

        need: dict[str, float] = {}
        for p in self.phases:
            best = 0.0
            for m in p.movements:
                meas = measures.get(m.id)
                if meas is None or not meas.valid:
                    continue  # 결측을 0으로 채우지 않는다. 지수평균도 갱신하지 않는다
                prev = self.mean_arrivals.get(m.id, meas.arrivals)
                mean = cfg.beta * meas.arrivals + (1 - cfg.beta) * prev
                self.mean_arrivals[m.id] = mean
                demand = mean + meas.residual
                best = max(best, cfg.startup_loss + m.sat_headway * demand / max(m.lanes, 1))
            need[p.id] = p.priority * best
        need_sum = sum(need.values())
        weights = {k: (v / need_sum if need_sum > 0 else 0.0) for k, v in need.items()}

        bounds = self._bounds(measures)
        fallback = None
        if invalid:
            fallback = f"측정 불가 이동류 {', '.join(invalid)}"
        elif sum(lo for lo, _ in bounds.values()) > self.total_green:
            fallback = "하한 합이 녹색시간 합보다 큼"
        elif sum(hi for _, hi in bounds.values()) < self.total_green:
            fallback = "상한 합이 녹색시간 합보다 작음"
        elif need_sum <= 0:
            fallback = "필요 녹색시간을 계산할 수 없음"

        if fallback:
            target = plan
            hits: dict[str, str] = {}
        else:
            target, hits = self._allocate(need, bounds)

        moved = {k: self.current[k] + cfg.alpha * (target[k] - self.current[k]) for k in self.current}
        order = [p.id for p in self.phases]
        greens = round_preserving_sum(moved, self.total_green, order, toward=target)
        greens = self._nudge_if_stalled(greens, target, bounds if not fallback else None)
        self.current = greens
        return Decision(
            cycle=self.cycle, greens=dict(greens), target=target, need=need, weights=weights,
            bounds=bounds, bound_hits=hits, oversaturated=need_sum > self.total_green, fallback=fallback,
        )

    def _nudge_if_stalled(self, greens: dict[str, int], target: dict[str, float],
                          bounds: dict[str, tuple[int, int]] | None) -> dict[str, int]:
        """정수 맞춤 때문에 목표와 1초 이상 차이 나는데도 값이 그대로면 1초를 직접 옮긴다.

        alpha만큼만 옮기고 정수로 맞추면 목표 바로 옆에서 같은 값을 되풀이할 수 있다.
        (예: 31, 19초에서 목표 30, 20초로 가지 못함)
        """
        if greens != self.current:
            return greens
        gap = {k: target[k] - greens[k] for k in greens}
        give = min(gap, key=gap.get)  # 목표보다 가장 많이 받은 현시
        take = max(gap, key=gap.get)  # 목표보다 가장 적게 받은 현시
        if gap[take] < 1 or gap[give] > -1:
            return greens
        if bounds is not None and (greens[give] - 1 < bounds[give][0] or greens[take] + 1 > bounds[take][1]):
            return greens
        out = dict(greens)
        out[give] -= 1
        out[take] += 1
        return out

    def _bounds(self, measures: dict[str, MovementMeasure]) -> dict[str, tuple[int, int]]:
        b = self.config.max_change
        out = {}
        for p in self.phases:
            lo = max(p.min_green, p.ped_min_green, p.plan_green - b)
            hi = min(p.max_green, p.plan_green + b)
            cur = self.current[p.id]
            ms = [measures.get(m.id) for m in p.movements]
            if any(m is not None and m.valid and m.downstream_blocked for m in ms):
                hi = min(hi, cur)  # 빠져나갈 공간이 없는 방향에 녹색을 더 주지 않는다
            if any(m is not None and m.valid and m.queue_overflow for m in ms):
                lo = max(lo, cur)  # 수요를 적게 잰 방향의 녹색을 줄이지 않는다
            out[p.id] = (math.ceil(lo), math.floor(max(hi, lo)))
        return out

    def _allocate(self, need: dict[str, float], bounds: dict[str, tuple[int, int]]):
        """범위 안에서 G를 필요 녹색 비율로 나눈다.

        목표 = clamp(lam x 필요 녹색, 하한, 상한)이고 합이 G가 되는 lam을 이분법으로 찾는다.
        기술설계서 6.4절의 "경계를 넘은 현시를 고정하고 남은 녹색을 나머지에 다시 나누기를 반복"과
        같은 해를 내면서, 반복 순서와 상관없이 항상 끝난다.
        """
        g = self.total_green

        def total(lam: float) -> float:
            return sum(min(max(lam * need[k], bounds[k][0]), bounds[k][1]) for k in need)

        lo_lam, hi_lam = 0.0, 1.0
        while total(hi_lam) < g and hi_lam < 1e9:
            hi_lam *= 2
        for _ in range(200):
            mid = (lo_lam + hi_lam) / 2
            if total(mid) < g:
                lo_lam = mid
            else:
                hi_lam = mid
        lam = hi_lam
        target, hits = {}, {}
        for k in need:
            raw = lam * need[k]
            lo, hi = bounds[k]
            if raw >= hi:
                target[k], hits[k] = float(hi), "upper"
            elif raw <= lo:
                target[k], hits[k] = float(lo), "lower"
            else:
                target[k] = raw
        # 이분법 오차를 경계에 걸리지 않은 현시에 나눠 합을 정확히 G로 맞춘다
        free = [k for k in target if k not in hits] or list(target)
        diff = g - sum(target.values())
        for k in free:
            target[k] += diff / len(free)
        return target, hits


def round_preserving_sum(values: dict[str, float], total: int, order: list[str],
                         toward: dict[str, float] | None = None) -> dict[str, int]:
    """내림한 뒤 소수점 아래가 큰 현시부터 1초씩 더해 합을 total로 맞춘다(기술설계서 6.5절).

    소수점 아래가 같으면 목표(toward)보다 더 모자란 현시에 먼저 준다. 순서로만 정하면
    같은 현시가 계속 1초를 가져가 목표에 닿지 못한다.
    """
    floors = {k: math.floor(v + 1e-9) for k, v in values.items()}
    remain = total - sum(floors.values())
    short = {k: (toward[k] - values[k]) if toward else 0.0 for k in order}
    by_frac = sorted(order, key=lambda k: (-round(values[k] - floors[k], 9), -short[k], order.index(k)))
    for k in by_frac[:max(remain, 0)]:
        floors[k] += 1
    return floors
