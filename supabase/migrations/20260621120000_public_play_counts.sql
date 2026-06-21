-- ============================================================================
--  SHARKY — Публичный счётчик «играли» (как просмотры видео на YouTube)
-- ----------------------------------------------------------------------------
--  «Игра» (play) = сессия с dwell >= 3с: строка game_stats, где loaded = true
--  и active_ms >= 3000. Семантика совпадает с sessions_3s в admin_games_overview.
--
--  game_stats закрыта RLS (политика «select own stats» — пользователь видит
--  только свои строки), а для плашки «N играли» в ленте нужен агрегат по ВСЕМ
--  строкам. Поэтому отдаём ТОЛЬКО count(*) по game_id через SECURITY DEFINER
--  (минует RLS). Наружу уходит исключительно публичный счётчик показов — ни
--  user_id, ни время, ни какие-либо поля пользователя не утекают.
--
--  В отличие от admin_*-RPC, тут НЕТ guard is_admin(): функция намеренно
--  публичная (счётчик «играли» виден всем, как лайки/шеры). Аддитивная,
--  неразрушающая миграция.
-- ============================================================================
create or replace function public.public_play_counts()
returns table(game_id text, plays bigint)
language sql
security definer
set search_path = public
stable
as $$
  select gs.game_id, count(*)::bigint as plays
  from public.game_stats gs
  where gs.loaded and gs.active_ms >= 3000
  group by gs.game_id;
$$;

-- Доступ на ВЫЗОВ: и гостям (anon), и залогиненным. Счётчик публичный.
revoke all on function public.public_play_counts() from public;
grant execute on function public.public_play_counts() to anon, authenticated;
