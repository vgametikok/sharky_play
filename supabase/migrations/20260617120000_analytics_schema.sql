-- ============================================================================
--  SHARKY — Аналитика, часть 1: модель данных (таблицы/колонки/индексы/RLS)
-- ----------------------------------------------------------------------------
--  Для админ-дашборда (Аудитория + Игры). Аддитивная, неразрушающая миграция.
--    1) Атрибуты Telegram на public.users (язык/премиум/платформа/last_seen/реферал)
--    2) public.app_opens — лог запусков (DAU/WAU/MAU, удержание). Пишет только
--       tg-auth через service_role; читает только админ через definer-RPC.
--    3) public.game_stats — +active_ms (dwell в мс) и +loaded (догрузилась ли игра)
--    4) public.shares — реальные шеры (раньше счётчик жил только в памяти фронта)
--  RPC-агрегации — в отдельной миграции (..._analytics_rpcs.sql).
-- ============================================================================

-- 1) USERS — аудиторные атрибуты ---------------------------------------------
-- ВАЖНО: эти колонки НЕ добавляем в колоночные GRANT для anon/authenticated
-- (см. lockdown_rls) — премиум/реферал не должны утекать публично. Доступ к ним
-- только через SECURITY DEFINER RPC, защищённый is_admin().
alter table public.users add column if not exists language_code  text;
alter table public.users add column if not exists is_premium      boolean not null default false;
alter table public.users add column if not exists platform        text;
alter table public.users add column if not exists last_seen_at    timestamptz;
alter table public.users add column if not exists referral_source text;  -- first-touch

-- 2) APP_OPENS — лог запусков -------------------------------------------------
create table if not exists public.app_opens (
  id            bigint generated always as identity primary key,
  user_id       uuid references public.users(id) on delete cascade,
  opened_at     timestamptz not null default now(),
  platform      text,
  language_code text,
  is_premium    boolean,
  referral      text
);
create index if not exists app_opens_opened_at_idx on public.app_opens(opened_at);
create index if not exists app_opens_user_idx       on public.app_opens(user_id, opened_at);

alter table public.app_opens enable row level security;
-- Никаких клиентских политик: пишет tg-auth (service_role минует RLS),
-- читает админ через definer-RPC. Явно убираем любые таблич. гранты у клиентов.
revoke all on public.app_opens from anon, authenticated;

-- 3) GAME_STATS — dwell-time сессии -------------------------------------------
-- active_ms = точное время «просмотра» (карточка активна/видима/не на паузе),
-- источник истины для метрик; active_seconds оставляем для читаемости.
-- loaded = игра успела догрузиться во время показа (знаменатель hook-rate).
alter table public.game_stats add column if not exists active_ms integer not null default 0;
alter table public.game_stats add column if not exists loaded    boolean not null default true;

create index if not exists game_stats_game_idx      on public.game_stats(game_id);
create index if not exists game_stats_created_idx   on public.game_stats(created_at);
create index if not exists game_stats_user_game_idx on public.game_stats(user_id, game_id, created_at);

-- 4) SHARES — реальные шеры ---------------------------------------------------
create table if not exists public.shares (
  id         bigint generated always as identity primary key,
  game_id    text references public.games(id) on delete cascade,
  user_id    uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists shares_game_idx    on public.shares(game_id);
create index if not exists shares_created_idx on public.shares(created_at);

alter table public.shares enable row level security;
grant select on public.shares to anon, authenticated;   -- счётчик шеров публичен (как лайки)
grant insert on public.shares to authenticated;

drop policy if exists "public read shares" on public.shares;
create policy "public read shares" on public.shares for select using (true);

drop policy if exists "insert own share" on public.shares;
create policy "insert own share" on public.shares
  for insert to authenticated
  with check (user_id is null or user_id = public.app_uid());
