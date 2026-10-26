# sharky-games worker
Serves multi-file HTML/WebGL builds from R2 bucket `sharky-games` at
`https://sharky-games.vgametikok.workers.dev/g/<gameId>/v<version>/...` and accepts admin zip uploads:
`POST /api/upload/start` → `PUT /api/upload/part?part=N&upload_id=` (≤100 MB each) → `POST /api/upload/complete` (server unpacks, finds index.html, validates paths).
Auth: Supabase JWT + `is_admin()` (see `requireUploader` — the single place to allow game authors later).
Deploy: `npm i && npx wrangler deploy`. Local test: `npx wrangler dev --local --var DEV_NO_AUTH:1`.
