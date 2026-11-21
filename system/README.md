# 시흥 교통관제 시제품

시흥시 중부권 스마트교차로 18곳을 지도에서 찾고, 가상 교차로의 녹색시간 배분을 시험할 수 있습니다. 웹 화면은 React와 TypeScript로 구성하고, FastAPI가 정적 파일과 기존 Python 배분 엔진을 함께 제공합니다.

## 로컬 실행

저장소 최상위 폴더에서 실행합니다. Node.js 22.12 이상과 uv가 필요합니다.

```sh
npm --prefix system/frontend ci
npm --prefix system/frontend run build
uv run --python 3.13 --with-requirements system/backend/requirements.txt python -m uvicorn system.backend.web:app --host 127.0.0.1 --port 8765
```

브라우저에서 [로컬 관제 화면](http://127.0.0.1:8765/)을 엽니다. 프런트엔드를 수정하면서 확인하려면 API 서버를 켠 상태에서 다른 터미널에서 `npm --prefix system/frontend run dev`를 실행하고 Vite가 표시하는 주소를 엽니다.

## 화면과 자료

- **운영 모드**에서 지도 마커나 목록의 교차로를 선택하면 주소와 영상 연계 상태가 표시됩니다. 교차로 좌표는 [시흥시 스마트교차로 현황](data/siheung_smart_intersections_2025-11-05.csv)의 2025년 11월 5일 자료를 사용합니다. 녹화 파일은 선택한 브라우저 안에서만 재생합니다. 실시간 영상, 차량 검출, 실제 신호 연계는 후속 단계입니다.
- **시뮬레이션**의 기본 시나리오인 ‘퇴근 시간’에서 ‘다음 주기’를 누르면 동서 직진, 동서 좌회전, 남북 직진, 남북 좌회전의 권고값이 각각 35초, 21초, 26초, 18초로 바뀝니다. 다음 주기부터는 새 유입량과 간이 모형으로 추정한 잔류 대수를 반영합니다. 주기별 수요와 포화 차두시간으로 계산하며 SUMO와 현장 측정 자료는 연결 전입니다.
- **배경 지도**는 API 키 없이 표시할 수 있도록 시흥 일대의 도로, 토지 피복, 수계를 정적 지도로 렌더링했습니다. 2026년 11월 15일자 OpenFreeMap 벡터 타일을 사용했습니다. [OpenFreeMap](https://openfreemap.org/) · [© OpenMapTiles](https://openmaptiles.org/) · [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright)

화면 기획과 개발 단계는 [관제 시스템 기획서](../기술설계/관제시스템_기획서.md), 배분 산식과 가상 교차로의 설정은 [기술설계서 6.6절](../기술설계/기술설계서.md)을 따릅니다.
