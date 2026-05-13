# 프론트엔드 에이전트용: 배포된 백엔드(Fly)와 맞추기

아래 블록을 **tmap_web_fe** 레포에서 작업하는 에이전트에게 그대로 붙여 넣는다.

---

## 시스템 프롬프트 (복사용)

```
당신은 이미 배포된 TMAP 웹 프론트엔드(tmap_web_fe)를 수정한다. 백엔드 API가 Fly.io에 올라갔으므로, 로컬 전용 mock이 아니라 **실제 API 베이스 URL**과 **CORS·OAuth·AI** 설정을 맞춘다.

### 1) API 베이스 URL
- 프로덕션(또는 스테이징) 빌드에서 백엔드 베이스 URL을 **배포 주소**로 고정한다.
  - 예: `VITE_API_BASE_URL=https://tmap-web-be.fly.dev`
  - 끝에 슬래시(`/`)를 붙이지 않는다. 기존 코드가 `base + "/clusters/..."` 형태인지 `base + "clusters/..."` 형태인지 확인하고 한쪽으로 통일한다.
- 호스트 플랫폼(Vercel/Netlify/Cloudflare Pages 등)의 **환경 변수 UI**에 동일한 값을 넣고, 재배포한다.
- `VITE_API_BASE_URL`이 비어 있으면 기존처럼 localStorage mock 위주로 동작할 수 있으므로, **배포 환경에서는 반드시 설정**되게 한다.

### 2) Google 로그인 (GIS)
- 프론트의 `VITE_GOOGLE_CLIENT_ID`(또는 동등 변수)와 백엔드 Fly 시크릿 `GOOGLE_CLIENT_ID`는 **동일한 OAuth Web 클라이언트 ID**여야 한다.
- Google Cloud Console에서 **승인된 JavaScript 출처**에 프론트 배포 도메인(예: `https://your-app.vercel.app`)을 추가한다.
- `POST {VITE_API_BASE_URL}/auth/google`에 GIS `credential`을 보내 JWT를 받는 기존 흐름이 있다면, 베이스 URL만 바뀌었는지 점검한다.

### 3) CORS (백엔드 쪽 작업 — 프론트 담당자가 Fly에 요청하거나 직접 설정)
- 브라우저에서 `credentials: true`로 API를 호출한다면, 백엔드는 `CORS_ORIGIN`에 **프론트 실제 출처**를 넣어야 한다. (쉼표로 여러 개 가능)
  - 예: `fly secrets set CORS_ORIGIN="https://your-frontend.example" -a tmap-web-be`
- 로컬 개발 시에는 `http://localhost:5173` 등을 포함할지 팀 규칙에 맞게 정한다.

### 4) 인증 헤더
- 로그인 후 API 호출 시 `Authorization: Bearer <저장된 JWT>`를 붙인다. 토큰 저장 위치·키 이름(`tmap_api_token_v1` 등)은 기존 `lib/http.ts` 관례를 따른다.
- **POI 리뷰 요약**(`POST /ai/gemini/poi-review-summary`): 비로그인도 호출 가능하지만, 백엔드는 **로그인한 경우에만** DB에 모인 사용자 코멘트 코퍼스로 전역 관심사를 뽑는다. 개인화를 살리려면 이 엔드포인트 호출에도 Bearer를 붙인다.

### 5) AI·기타 엔드포인트
- Gemini 키는 브라우저에 두지 않는다. `GEMINI_API_KEY`는 백엔드 Fly 시크릿에만 둔다. 키가 없으면 AI 관련 라우트는 503일 수 있으므로 UI는 graceful degrade 한다.
- 문서 `docs/frontend-agent-poi-review-summary.md`의 요청/응답 스키마·하이라이트 렌더 규칙을 그대로 따른다. 베이스 URL만 위 Fly 주소로 맞춘다.

### 6) 점검 체크리스트
- [ ] 배포 프론트에서 즐겨찾기 모음 목록/상세 GET이 새 베이스 URL로 성공하는가
- [ ] 로그인 후 클러스터 생성·노트 작성 등 인증 필요 API가 401 없이 동작하는가
- [ ] POI 상세의 리뷰 요약이 (로그인 시) 기대대로 호출되는가
- [ ] 혼합 콘텐츠/HTTPS 경고 없이 API가 `https://`로만 호출되는가

구현은 기존 패턴을 깨지 말고, 환경 변수·`fetch` 래퍼·배포 파이프라인 설정만 최소 변경으로 마친다.
```

---

## 참고 (사람용)

| 항목 | 값 |
|------|-----|
| 백엔드(예시) | `https://tmap-web-be.fly.dev` |
| 헬스 | `GET /health` → `{"ok":true}` |
| 프론트 주요 변수 | `VITE_API_BASE_URL`, `VITE_GOOGLE_CLIENT_ID` |
| 백엔드 Fly 시크릿 예 | `DATABASE_URL`, `JWT_SECRET`, `GOOGLE_CLIENT_ID`, `GEMINI_API_KEY`, `CORS_ORIGIN` |

백엔드 레포: `https://github.com/JaeAn0715/tmap_web_be` — `README.md`, `intro.md`, `docs/frontend-agent-poi-review-summary.md` 참고.
