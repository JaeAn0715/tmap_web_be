# API 인증·권한 (401 / 403)

- **401 Unauthorized**: `Authorization: Bearer <JWT>` 가 없거나, 토큰이 만료·위조되어 `GET /me` 등 인증이 필요한 엔드포인트에 접근한 경우. 공개 **`GET /clusters/:id`** 는 인증 없이 200(존재 시) 또는 404.
- **403 Forbidden**: JWT는 유효하지만 **해당 리소스에 대한 역할이 부족**한 경우. 예: 비소유자가 **`PATCH /clusters/:id`**(즐겨찾기 모음 메타·POI 편집) 또는 타인의 **`PATCH /me/poi-notes/:noteId`** 를 시도. 반대로 **즐겨찾기 모음 공유 피드백**(`POST …/likes`, `POST|PATCH|DELETE …/notes`)은 소유자가 아닌 로그인 사용자도 허용(목적지 편집과 분리).
- **404 Not Found**: 리소스가 없거나, **다른 사용자의 개인 노트**처럼 `userId` 스코프 밖의 id로 접근하는 경우(열거 방지를 위해 403 대신 404를 쓸 수도 있음; 현재 개인 POI 노트는 본인 `userId`로만 조회·수정·삭제).

프론트 `tmap_web_fe`는 `VITE_API_BASE_URL` 설정 시 위 규칙으로 `clusterApi`·`/me/*`·`/me/poi-notes` 를 호출한다.
