// ============================================================================
//  SHARKY — Telegram auth Edge Function (tg-auth)
// ----------------------------------------------------------------------------
//  ЗАЧЕМ: фронт сейчас доверяет tg.initDataUnsafe и пишет в БД anon-ключом —
//  личность подделывается тривиально. Эта функция — ЕДИНСТВЕННОЕ место, где
//  доверяется Telegram-идентификации: она проверяет ПОДПИСЬ initData (HMAC по
//  токену бота) на сервере, создаёт/находит пользователя и выдаёт настоящую
//  Supabase-сессию. После этого RLS можно закрутить на auth.uid().
//
//  СЕКРЕТЫ (Project → Edge Functions → Secrets; НИКОГДА не в репозитории/фронте):
//    TG_BOT_TOKEN              — токен бота @sharkyplay_bot из BotFather
//    SUPABASE_URL              — задаётся платформой автоматически
//    SUPABASE_SERVICE_ROLE_KEY — задаётся платформой автоматически
//
//  ДЕПЛОЙ:  supabase functions deploy tg-auth --no-verify-jwt
//           (--no-verify-jwt: функция вызывается ДО входа, своей JWT ещё нет)
//
//  КОНТРАКТ:
//    POST { initData: "<сырая строка tg.initData>" }
//    200  { token_hash, email }  — фронт делает supabase.auth.verifyOtp(...)
//    401  { error }              — подпись/срок невалидны
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TG_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Сколько секунд initData считается свежей (защита от replay старых строк).
const MAX_AUTH_AGE_SEC = 24 * 60 * 60;

// Разрешённые origins. Добавляй сюда свои домены (свой сайт, прод) — по строке.
// Нативные приложения (Android/iOS) CORS не проверяют, им этот список не мешает:
// заголовок нужен только браузерам. Telegram Mini App грузится с твоего домена,
// поэтому его origin попадёт в список после переноса на свой домен.
const ALLOWED_ORIGINS = [
  "https://vgametikok.github.io",
  // "https://your-domain.com",  // ← раскомментируй и впиши при переносе
];

function corsHeaders(origin: string | null) {
  // Если origin в allowlist — отражаем его; иначе отдаём первый (дефолтный).
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const enc = new TextEncoder();

async function hmacSha256(keyBytes: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, enc.encode(msg));
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Проверка подписи initData по алгоритму Telegram Mini Apps:
//   secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
//   hash       = HMAC_SHA256(key=secret_key,  msg=data_check_string)
// data_check_string — все поля кроме hash, отсортированы, "key=value" через \n.
async function verifyInitData(initData: string): Promise<Record<string, string> | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");

  const secretKey = await hmacSha256(enc.encode("WebAppData"), BOT_TOKEN);
  const computed = toHex(await hmacSha256(new Uint8Array(secretKey), dataCheckString));

  // сравнение постоянного времени
  if (computed.length !== hash.length) return null;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ hash.charCodeAt(i);
  if (diff !== 0) return null;

  // свежесть
  const authDate = Number(params.get("auth_date") || "0");
  if (!authDate || Date.now() / 1000 - authDate > MAX_AUTH_AGE_SEC) return null;

  return Object.fromEntries(params.entries());
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, cors);

  let initData = "";
  try {
    ({ initData } = await req.json());
  } catch {
    return json({ error: "bad request" }, 400, cors);
  }
  if (!initData) return json({ error: "initData required" }, 400, cors);

  const verified = await verifyInitData(initData);
  if (!verified) return json({ error: "invalid initData" }, 401, cors);

  let tgUser: { id: number; username?: string; first_name?: string; last_name?: string };
  try {
    tgUser = JSON.parse(verified.user);
  } catch {
    return json({ error: "no user in initData" }, 401, cors);
  }
  if (!tgUser?.id) return json({ error: "no user id" }, 401, cors);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Детерминированный e-mail на основе telegram_id — НЕ показывается пользователю,
  // нужен только как ключ записи в auth.users.
  const email = `tg_${tgUser.id}@sharky.telegram`;
  const displayName =
    (tgUser.first_name || "") + (tgUser.last_name ? " " + tgUser.last_name : "") || "Игрок";
  const username = tgUser.username || `user${tgUser.id}`;

  // 1) Найти/создать auth-пользователя (service_role) → получить его uid.
  let authUid: string | null = null;
  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { telegram_id: tgUser.id, username },
  });
  if (created.data?.user) {
    authUid = created.data.user.id;
  } else {
    // уже существует — найдём по e-mail (постранично)
    for (let page = 1; page <= 50 && !authUid; page++) {
      const list = await admin.auth.admin.listUsers({ page, perPage: 200 });
      const hit = list.data?.users?.find((u) => u.email === email);
      if (hit) authUid = hit.id;
      if (!list.data?.users?.length) break;
    }
  }
  if (!authUid) return json({ error: "auth user resolution failed" }, 500, cors);

  // 2) Найти/создать строку public.users и связать её с auth_uid.
  const existing = await admin
    .from("users")
    .select("id")
    .eq("telegram_id", tgUser.id)
    .maybeSingle();

  let userId: string;
  if (existing.data?.id) {
    userId = existing.data.id;
    await admin.from("users").update({ auth_uid: authUid }).eq("id", userId);
  } else {
    const inserted = await admin.from("users").insert({
      telegram_id: tgUser.id,
      username,
      display_name: displayName,
      avatar_emoji: "🎮",
      bio: "",
      is_virtual: false,
      auth_uid: authUid,
    }).select("id").single();
    if (!inserted.data?.id) return json({ error: "user creation failed" }, 500, cors);
    userId = inserted.data.id;
  }

  // 3) Выдать сессию без пароля: magiclink → token_hash, фронт зовёт verifyOtp.
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (!tokenHash) return json({ error: "session mint failed" }, 500, cors);

  return json({ token_hash: tokenHash, email, user_id: userId }, 200, cors);
});
