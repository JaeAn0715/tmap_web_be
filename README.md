# tmap_web_be

TMAP 웹 프론트([tmap_web_fe](https://github.com/JaeAn0715/tmap_web_fe))와 연동하는 **백엔드 API**(Fastify, Prisma, PostgreSQL). 즐겨찾기 모음(코드상 `cluster`), Google 로그인, 공유 코멘트·좋아요, POI 개인 메모, 서버 사이드 Gemini 프록시 등을 담당합니다.

제품·구조 소개는 **[intro.md](./intro.md)**를 참고하세요. 환경 변수 예시는 [.env.example](./.env.example)입니다.

---

## 실배포·데모 링크를 붙일 때 (포트폴리오용 고지)

배포 URL을 이력서·포트폴리오에 넣는 경우, 아래를 README나 지원 페이지에 **한 블록으로 명시**해 두는 것을 권장합니다. 기술 면접관이 **의도된 프로토타입·스테이징**으로 읽기 쉬워집니다.

- **TMAP API 키**: 지도·POI 검색은 브라우저에서 TMAP Web / OPEN API를 사용합니다. 키 발급·도메인(또는 로컬) 허용 설정이 없으면 지도·검색이 동작하지 않을 수 있습니다.
- **Google 로그인**: 데모·개발용 OAuth 클라이언트로 연결된 경우가 많습니다. **상용 서비스 수준의 계정 보안·약관·운영 정책을 전제로 한 로그인이 아닐 수 있습니다.**
- **Gemini 등**: `GEMINI_API_KEY`가 없으면 AI 관련 엔드포인트는 동작하지 않거나 503을 반환할 수 있습니다.
- **데이터**: 스테이징 DB는 언제든 초기화·중단될 수 있으며, 데모 목적의 데이터만 넣는 것이 좋습니다.

---

## 로컬 개발 (요약)

- Node.js 20+
- `.env`는 `.env.example`을 참고해 작성합니다.
- PostgreSQL: `npm run docker:up` 후 `DATABASE_URL` 맞추기, 또는 `npm run dev:pglite`로 로컬만 빠르게 실행할 수 있습니다.
- `npm install` → `npx prisma migrate deploy` → `npm run dev`

자세한 API·인증 규칙은 [docs/openapi.yaml](./docs/openapi.yaml), [docs/api-auth-rules.md](./docs/api-auth-rules.md)를 참고하세요.

---

## Fly.io 배포 (예시)

- **API 베이스 URL**: `https://tmap-web-be.fly.dev` — 헬스 체크: `GET /health` → `{"ok":true}`
- **빌드**: 루트 `Dockerfile` 멀티 스테이지, 배포 시 `npx prisma migrate deploy`가 `fly.toml`의 `release_command`로 실행됩니다.
- **시크릿**: `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGIN`, `GOOGLE_CLIENT_ID` 등. **`GEMINI_API_KEY`가 없으면** `POST /ai/gemini/...` 는 **503** (`GEMINI_API_KEY is not configured`)을 반환합니다.
  - 예: `fly secrets set GEMINI_API_KEY="..." -a tmap-web-be` (모델은 선택: `GEMINI_MODEL`, 기본 `gemini-2.5-flash-lite`)
- **과금 주의**: `fly launch --db=mpg`로 붙인 **Managed Postgres(Basic)** 는 Fly 요금제상 **월 정액에 가까운 비용**이 붙을 수 있습니다. 실험만 하려면 Fly 대시보드에서 **앱·Postgres 클러스터를 삭제**하거나, 더 싼 **Neon 등 외부 Postgres URL**만 `fly secrets set DATABASE_URL=...` 로 바꾸는 방식을 검토하세요.
