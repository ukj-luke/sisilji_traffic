# 실제 실행한 합성 검증 결과

이 파일은 SUMO 1.28.0, Python 3.13.7, macOS arm64에서 실행한 결과를 요약한다. 실제 둔대교차로의 실측 결과가 아니다. 정상·편중·하류 수요 스트레스 조건마다 출발 수요 시드 1·2를 사용했다. 각 실행은 1,200초이고 수요는 960초까지 생성했으며, J 집계는 준비 구간 480초 이후이다. 추천 판단은 580초·700초 두 번 수행했다.

```bash
python -m sisilji_traffic benchmark --seeds 1 2 \
  --scenarios normal imbalanced downstream --decisions 2 \
  --policies fixed recommended --out runs/validation
```

기본 20초 계산 예산·2주기 계획 지평·동일 가상 채택 조건을 사용했다. 후보 평가에는 과거 관측에서 만든 9개 계획 표본만 사용했다. 각 정책은 같은 실현 출발 수요로 자신의 상태를 유지하며 반복했다. 원본 수요는 설정·시드로 재생성할 수 있고 해시는 각 `summary.json`에 저장했다. 소스 해시도 포함했다. 하드웨어·SUMO 빌드·실측 계산시간에 따라 재실행의 보류 여부와 수치가 달라질 수 있다.

| 가상 조건 | 시드 | 고정 J (차량초) | 추천 J (차량초) | 고정 대비 J 변화 | 추천 적용/판단 | 종료 활성/미삽입 | 원본 기록 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| downstream | 1 | 61,659 | 61,659 | +0.00% | 0 / 2 | 9 / 0 | [결과](downstream_seed1/summary.json) · [추천 근거](downstream_seed1/recommended/decisions.json) |
| downstream | 2 | 66,952 | 66,952 | +0.00% | 0 / 2 | 14 / 0 | [결과](downstream_seed2/summary.json) · [추천 근거](downstream_seed2/recommended/decisions.json) |
| imbalanced | 1 | 38,978 | 38,291 | -1.76% | 2 / 2 | 16 / 0 | [결과](imbalanced_seed1/summary.json) · [추천 근거](imbalanced_seed1/recommended/decisions.json) |
| imbalanced | 2 | 40,433 | 40,433 | +0.00% | 0 / 2 | 11 / 0 | [결과](imbalanced_seed2/summary.json) · [추천 근거](imbalanced_seed2/recommended/decisions.json) |
| normal | 1 | 28,897 | 28,897 | +0.00% | 0 / 2 | 0 / 0 | [결과](normal_seed1/summary.json) · [추천 근거](normal_seed1/recommended/decisions.json) |
| normal | 2 | 33,020 | 32,684 | -1.02% | 1 / 2 | 0 / 0 | [결과](normal_seed2/summary.json) · [추천 근거](normal_seed2/recommended/decisions.json) |

J 감소는 이 실험의 누적 차량 부담 감소를 뜻한다. 편중 시드 1에서 687차량초, 정상 시드 2에서 336차량초 감소했고 다른 네 실행은 기준을 유지했다. 각 조건은 2개 시드만 실행했으므로 일반 성능이나 통계적으로 확정된 개선율로 제시할 수 없다. 후보 탈락·유지 근거도 모두 남겼다. 제안 모델의 진단 필터가 다른 탐색보다 우수하다는 증거도 아직 아니다. 이 검증 묶음은 고정/추천 비교만 포함한다. 기본 `demo` 명령은 진단 필터 없는 탐색을 추가로 비교한다.

12개 정책 실행에서 평가 구간 충돌·텔레포트는 모두 0이었다. 종료 잔여량이 남은 실행이 있으므로 차량 완료 평균만으로 효과를 계산하지 않는다. `scheduled`는 전체 요청 수이며 `arrived/departed`는 480초 이후 집계임에 주의한다.

[짝지은 차이와 탐색적 신뢰구간](benchmark.json)을 함께 제공한다. 4·8주기 지평이나 실제 영상·버스·실행 신호를 사용한 현장 검증은 이 결과에 포함되지 않는다. 테스트 20개(규칙 14개·실제 SUMO 통합 6개)가 통과했다. 미진입 차량 부담, 상태 복원 일치, 미래 수요 비누출, B 변경 시 A/C 신호 유지도 검증했다.
