-- ============================================================================
--  SHARKY — закрытие RLS (применять ПОСЛЕДНИМ, после перевода фронта на сессии)
-- ----------------------------------------------------------------------------
--  ВНИМАНИЕ: пока фронт не получает сессию через Edge Function tg-auth и не
--  вызывает supabase.auth.verifyOtp(...), эта миграция СЛОМАЕТ запись/вход в
--  боевом приложении. Порядок выката:
--    1) задеплоить функцию tg-auth + секрет TG_BOT_TOKEN;
--    2) выкатить фронт, который логинится через функцию (auth.uid() появляется);
--    3) только потом применить ЭТУ миграцию.
--
--  Идея: запись разрешена только владельцу (user_id = app_uid()); чтение
--  контента остаётся публичным, но из users скрыты password_hash/telegram_id;
--  все массовые INSERT/UPDATE/DELETE от анонима закрыты.
-- ============================================================================

-- 0) Связь Telegram-пользователя с Supabase Auth ----------------------------
alter table public.users
  add column if not exists auth_uid uuid references auth.users(id) on delete set null;
create unique index if not exists users_auth_uid_key on public.users(auth_uid) where auth_uid is not null;

-- helper: public.users.id текущего залогиненного auth-пользователя
create or replace function public.app_uid()
returns uuid
language sql
stable
security definer
set search_path = public
as $$ select id from public.users where auth_uid = auth.uid() $$;

revoke all on function public.app_uid() from public;
grant execute on function public.app_uid() to authenticated;

-- ============================ USERS ========================================
-- Чтение: публичное, НО без чувствительных колонок (через права на колонки).
drop policy if exists "public read users" on public.users;
create policy "public read users" on public.users for select using (true);

revoke select on public.users from anon, authenticated;
grant  select (id, username, display_name, avatar_emoji, gradient, bio,
               is_virtual, role, status, created_at)
       on public.users to anon, authenticated;

-- Запись: создание пользователей — только service_role (Edge Function),
-- поэтому анонимный INSERT убираем полностью.
drop policy if exists "insert users" on public.users;

-- Обновлять можно только свою строку и только безопасные поля.
drop policy if exists "update users" on public.users;
create policy "update own user" on public.users
  for update to authenticated
  using (id = public.app_uid())
  with check (id = public.app_uid());

revoke update on public.users from anon, authenticated;
grant  update (display_name, avatar_emoji, bio, gradient) on public.users to authenticated;

-- (опционально, по подтверждению) выпилить неиспользуемую колонку хеша пароля:
-- alter table public.users drop column if exists password_hash;

-- ============================ LIKES ========================================
drop policy if exists "insert likes" on public.likes;
drop policy if exists "delete likes" on public.likes;
create policy "insert own like" on public.likes
  for insert to authenticated with check (user_id = public.app_uid());
create policy "delete own like" on public.likes
  for delete to authenticated using (user_id = public.app_uid());

-- ============================ SAVES ========================================
drop policy if exists "insert saves" on public.saves;
drop policy if exists "delete saves" on public.saves;
create policy "insert own save" on public.saves
  for insert to authenticated with check (user_id = public.app_uid());
create policy "delete own save" on public.saves
  for delete to authenticated using (user_id = public.app_uid());

-- ============================ FOLLOWS ======================================
drop policy if exists "insert follows" on public.follows;
drop policy if exists "delete follows" on public.follows;
create policy "insert own follow" on public.follows
  for insert to authenticated with check (follower_id = public.app_uid());
create policy "delete own follow" on public.follows
  for delete to authenticated using (follower_id = public.app_uid());

-- ============================ COMMENTS =====================================
drop policy if exists "insert comments" on public.comments;
drop policy if exists "update comments" on public.comments;
drop policy if exists "delete comments" on public.comments;
create policy "insert own comment" on public.comments
  for insert to authenticated with check (user_id = public.app_uid());
create policy "update own comment" on public.comments
  for update to authenticated
  using (user_id = public.app_uid()) with check (user_id = public.app_uid());
-- удалять может автор комментария (расширить на админа/автора игры — позже)
create policy "delete own comment" on public.comments
  for delete to authenticated using (user_id = public.app_uid());

-- ========================= COMMENT_LIKES ===================================
-- (RLS включён, но политик не было — добавляем владельческие)
drop policy if exists "insert own comment_like" on public.comment_likes;
drop policy if exists "delete own comment_like" on public.comment_likes;
create policy "insert own comment_like" on public.comment_likes
  for insert to authenticated with check (user_id = public.app_uid());
create policy "delete own comment_like" on public.comment_likes
  for delete to authenticated using (user_id = public.app_uid());
create policy "public read comment_likes" on public.comment_likes
  for select using (true);

-- ============================ GAME_STATS ===================================
drop policy if exists "insert stats" on public.game_stats;
drop policy if exists "update stats" on public.game_stats;
create policy "insert own stats" on public.game_stats
  for insert to authenticated
  with check (user_id is null or user_id = public.app_uid());
create policy "update own stats" on public.game_stats
  for update to authenticated
  using (user_id = public.app_uid()) with check (user_id = public.app_uid());

-- ============================ is_admin() ===================================
-- НЕ отзываем EXECUTE: is_admin() вызывается ВНУТРИ политики "games read"
-- (status='published' OR is_admin()) для роли anon, и внутри users/games admin —
-- отзыв EXECUTE сломает публичное чтение игр и админ-доступ. Функция возвращает
-- лишь boolean о САМОМ вызывающем, риск низкий (адвайзор — WARN/defense-in-depth).
-- Если всё же захотим закрыть прямой RPC — сперва переписать "games read", чтобы
-- не звать is_admin() для анонима, и только потом точечно ограничивать.
