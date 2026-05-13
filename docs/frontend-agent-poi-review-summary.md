# 프론트엔드 에이전트용: POI 리뷰 요약(Gemini) 연동

백엔드에 `POST /ai/gemini/poi-review-summary`가 구현되어 있다. 아래 블록을 **프론트 레포**에서 작업하는 에이전트에게 그대로 붙여 넣으면 된다.

---

## 에이전트 시스템 프롬프트 (복사용)

```
당신은 Tmap 웹 프론트엔드 코드를 수정한다. 목표는 다음이다.

1) 검색 결과·즐겨찾기·즐겨찾기 모음 등 **어느 경로로 POI 상세를 열든**, 상세가 열릴 때 백엔드 `POST /ai/gemini/poi-review-summary`를 호출해 **장소 리뷰 성격의 장점(pros)·단점(cons)** 과 **highlightTerms** 배열을 받는다.

2) `Authorization: Bearer <JWT>` 헤더는 **선택**이다. 비로그인 사용자도 AI 요약을 볼 수 있어야 한다(로그인 시 `userComments`에 본인 노트를 넣을 수 있음).

3) 요청 JSON 스키마:
   - `poi`: 백엔드 `poiSchema`와 맞는 객체 (최소 id, name, lat, lng, address; roadAddress, category, bizCategory, tel 등 있으면 포함).
   - `userComments`: string[] — **로그인한 경우** 이 사용자 본인이 어떤 즐겨찾기 모음에서든 이 POI(`poi.id`)에 대해 남긴 노트 본문만 넣는다(비로그인이면 `[]`). 다른 사용자 노트는 절대 넣지 않는다. 이미지 전용 줄 `(이미지)`는 제외해도 된다.
   - `interestHints`: string[] — 최근 검색어, 사용자가 자주 쓰는 관심 키워드, 현재 검색창 맥락 등. 예: 사용자가 "유모차"를 검색한 뒤 상세를 열면 `["유모차"]`를 포함시켜, 백엔드가 **영유아·유모차 동반 방문** 관점을 요약에 우선 반영하도록 한다. 빈 배열이면 힌트 없음.

4) 응답 JSON:
   - `pros`, `cons`: 한국어 평문, 각 최대 200자. 마크다운 볼드 없음.
   - `highlightTerms`: 5~12개, 각 문자열 길이 2~16자. **각 항목은 pros 또는 cons에 부분 문자열로 그대로 포함**되어야 한다(백엔드가 검증·보정함). UI에서는 이 문자열을 찾아 **볼드(또는 브랜드 컬러)** 로 감싼다.

5) UI 렌더링:
   - pros/ cons를 각각 제목(예: "장점" / "단점")과 함께 표시한다.
   - 볼드: `highlightTerms`를 **긴 문자열 우선**으로 정렬한 뒤, pros 텍스트에서 순차적으로 `indexOf` 또는 유니코드 안전 탐색으로 매칭해 `<strong>` 또는 디자인 시스템 컴포넌트로 감싼다. 겹침이 있으면 긴 구문을 먼저 처리한다. 매칭 실패한 힌트는 무시한다.
   - 로딩·에러(502, 503): 스켈레톤 또는 짧은 안내; 키 미설정 503은 조용히 섹션 숨김 가능.

6) 호출 시점·캐시:
   - 동일 POI 상세를 짧은 시간에 반복 열면 불필요한 재호출을 줄이기 위해, 클라이언트에서 `(poi.id + 정규화된 userComments 해시 + interestHints 정렬 키)` 기준 메모리 또는 짧은 TTL 캐시를 두는 것을 권장한다.

7) 구현 위치는 코드베이스 관례에 따른다: POI 상세 카드/드로어 컴포넌트, 기존 `fetch`/`api` 래퍼, React Query 등 프로젝트 표준을 따른다.

백엔드 베이스 URL은 환경 변수(예: `VITE_API_BASE_URL`)로 이미 쓰고 있을 가능성이 높다. 새 엔드포인트 경로만 추가하면 된다.
```

---

## API 요약 (개발자용)

| 항목 | 값 |
|------|-----|
| Method / path | `POST /ai/gemini/poi-review-summary` |
| Auth | 선택. 비로그인 호출 가능 |
| Body | `{ poi, userComments?, interestHints? }` |
| Response | `{ pros, cons, highlightTerms }` |
| Errors | `400` 본문 검증 실패, `503` `GEMINI_API_KEY` 미설정, `502` Gemini 실패 |

---

## 예시 요청

```json
{
  "poi": {
    "id": "poi-123",
    "name": "○○식당",
    "address": "서울시 …",
    "roadAddress": "서울특별시 …",
    "lat": 37.5,
    "lng": 127.0,
    "category": "음식점"
  },
  "userComments": ["유모차 넣기 좁았음", "아기의자는 있었음"],
  "interestHints": ["유모차", "아기"]
}
```

응답의 `highlightTerms`에 `유모차`, `아기의자` 등이 포함되면 pros/cons 본문에서 해당 구간을 강조하면 된다.
