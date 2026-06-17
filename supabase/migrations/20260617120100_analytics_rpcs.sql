-- ============================================================================
--  SHARKY — Аналитика, часть 2: админ-RPC агрегаций для дашборда
-- ----------------------------------------------------------------------------
--  Дашборд работает под ролью authenticated (= админ) с урезанными грантами,
--  поэтому отдаём ТОЛЬКО агрегаты через SECURITY DEFINER функции, защищённые
--  is_admin() (паттерн как у admin_list_users). Сырые app_opens/game_stats
--  клиенту недоступны (RLS), что и нужно.
--
--  Период [p_from, p_to) приходит из JS (день / 7д / 30д / всё время = null).
--  Определения метрик:
--    сессия   = показ игры с dwell >= 3с (active_ms>=3000)
--    hook     = доля догрузившихся показов (loaded) с dwell >= 10с
--    ср.время = avg(dwell) по сессиям >= 3с
--    удержание игры = доля (игрок,день) с сессией игры, вернувшихся к ней за 1/7 дн.
-- ============================================================================

-- ─────────────────────────── АУДИТОРИЯ: обзор ──────────────────────────────
create or replace function public.admin_audience_overview(
  p_from timestamptz default null, p_to timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  f timestamptz := coalesce(p_from, '-infinity');
  t timestamptz := coalesce(p_to,   'infinity');
  res jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  select jsonb_build_object(
    'total_users',    (select count(*) from users where telegram_id is not null and created_at < t),
    'total_audience', (select count(*) from users where telegram_id is not null),
    'new_users',      (select count(*) from users where telegram_id is not null and created_at >= f and created_at < t),
    'active_users',   (select count(distinct user_id) from app_opens where opened_at >= f and opened_at < t),
    'opens',          (select count(*) from app_opens where opened_at >= f and opened_at < t),
    'premium_users',  (select count(*) from users where telegram_id is not null and is_premium),
    'returning_users',(
        with firsts as (select user_id, min(opened_at) fo from app_opens group by user_id)
        select count(distinct o.user_id)
        from app_opens o join firsts fr on fr.user_id = o.user_id
        where o.opened_at >= f and o.opened_at < t and fr.fo < f),
    'platforms', (select coalesce(jsonb_agg(jsonb_build_object('key', coalesce(platform,'—'), 'users', u) order by u desc), '[]'::jsonb)
                  from (select platform, count(distinct user_id) u from app_opens
                        where opened_at >= f and opened_at < t group by platform order by u desc limit 8) p),
    'languages', (select coalesce(jsonb_agg(jsonb_build_object('key', coalesce(language_code,'—'), 'users', u) order by u desc), '[]'::jsonb)
                  from (select language_code, count(distinct user_id) u from app_opens
                        where opened_at >= f and opened_at < t group by language_code order by u desc limit 8) l),
    'referrals', (select coalesce(jsonb_agg(jsonb_build_object('key', coalesce(nullif(referral,''),'direct'), 'users', u) order by u desc), '[]'::jsonb)
                  from (select referral, count(distinct user_id) u from app_opens
                        where opened_at >= f and opened_at < t group by referral order by u desc limit 8) r)
  ) into res;
  return res;
end $$;

-- ─────────────────────── АУДИТОРИЯ: временной ряд ──────────────────────────
create or replace function public.admin_audience_timeseries(
  p_from timestamptz default null, p_to timestamptz default null, p_bucket text default 'day')
returns table(bucket date, new_users bigint, active_users bigint, opens bigint)
language plpgsql security definer set search_path = public as $$
declare f timestamptz; t timestamptz; step interval; trunc text;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  t := coalesce(p_to, now());
  f := coalesce(p_from, (select least((select min(opened_at) from app_opens),
                                       (select min(created_at) from users where telegram_id is not null))));
  if f is null then f := t - interval '30 days'; end if;
  trunc := case when p_bucket = 'week' then 'week' else 'day' end;
  step  := case when p_bucket = 'week' then interval '1 week' else interval '1 day' end;
  return query
  with series as (
    select generate_series(date_trunc(trunc, f), date_trunc(trunc, t), step)::date b
  ),
  nu as (select date_trunc(trunc, created_at)::date b, count(*) c
         from users where telegram_id is not null and created_at >= f and created_at <= t group by 1),
  au as (select date_trunc(trunc, opened_at)::date b, count(distinct user_id) c
         from app_opens where opened_at >= f and opened_at <= t group by 1),
  op as (select date_trunc(trunc, opened_at)::date b, count(*) c
         from app_opens where opened_at >= f and opened_at <= t group by 1)
  select s.b, coalesce(nu.c,0), coalesce(au.c,0), coalesce(op.c,0)
  from series s
  left join nu on nu.b = s.b
  left join au on au.b = s.b
  left join op on op.b = s.b
  order by s.b;
end $$;

-- ─────────────────────── АУДИТОРИЯ: удержание ──────────────────────────────
-- Когорты по дню первого запуска (app_opens). D1 = вернулся на след. день;
-- D7/D30 = вернулся хотя бы раз в течение 7/30 дней. Только полностью прошедшие
-- окна (cohort_date <= today - N).
create or replace function public.admin_audience_retention()
returns jsonb language plpgsql security definer set search_path = public as $$
declare res jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  with firsts as (select user_id, min(opened_at)::date fd from app_opens group by user_id),
  days as (select distinct user_id, opened_at::date d from app_opens),
  q as (
    select f.user_id, f.fd,
      exists(select 1 from days d where d.user_id=f.user_id and d.d = f.fd + 1) ret1,
      exists(select 1 from days d where d.user_id=f.user_id and d.d > f.fd and d.d <= f.fd + 7)  ret7,
      exists(select 1 from days d where d.user_id=f.user_id and d.d > f.fd and d.d <= f.fd + 30) ret30
    from firsts f
  )
  select jsonb_build_object(
    'd1',  round(100.0 * count(*) filter (where fd <= current_date-1  and ret1)  / nullif(count(*) filter (where fd <= current_date-1),0), 1),
    'd7',  round(100.0 * count(*) filter (where fd <= current_date-7  and ret7)  / nullif(count(*) filter (where fd <= current_date-7),0), 1),
    'd30', round(100.0 * count(*) filter (where fd <= current_date-30 and ret30) / nullif(count(*) filter (where fd <= current_date-30),0), 1),
    'cohort_d1',  count(*) filter (where fd <= current_date-1),
    'cohort_d7',  count(*) filter (where fd <= current_date-7),
    'cohort_d30', count(*) filter (where fd <= current_date-30)
  ) into res from q;
  return res;
end $$;

-- ───────────────────────────── ИГРЫ: обзор ─────────────────────────────────
create or replace function public.admin_games_overview(
  p_from timestamptz default null, p_to timestamptz default null)
returns table(
  game_id text, title text, status text,
  impressions bigint, sessions_3s bigint, sessions_10s bigint,
  hook_rate numeric, avg_session_sec numeric, players bigint,
  likes bigint, comments bigint, shares bigint, saves bigint,
  retention_d1 numeric, retention_d7 numeric)
language plpgsql security definer set search_path = public as $$
-- RETURNS TABLE-колонки (game_id и пр.) становятся plpgsql-переменными и
-- конфликтуют с одноимёнными колонками таблиц в запросе — велим всегда брать колонку.
#variable_conflict use_column
declare f timestamptz := coalesce(p_from,'-infinity'); t timestamptz := coalesce(p_to,'infinity');
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query
  with stats as (
    select gs.game_id, gs.user_id, gs.active_ms, gs.loaded, gs.created_at
    from game_stats gs where gs.created_at >= f and gs.created_at < t
  ),
  agg as (
    select game_id,
      count(*) filter (where loaded) impressions,
      count(*) filter (where active_ms >= 3000)  s3,
      count(*) filter (where active_ms >= 10000) s10,
      avg(active_ms) filter (where active_ms >= 3000) avg_ms,
      count(distinct user_id) filter (where active_ms >= 3000) players
    from stats group by game_id
  ),
  cohort as (
    select distinct game_id, user_id, created_at::date d
    from stats where loaded and active_ms >= 3000 and user_id is not null
  ),
  alldays as (
    select distinct game_id, user_id, created_at::date d
    from game_stats where loaded and active_ms >= 3000 and user_id is not null
  ),
  ret as (
    select c.game_id,
      count(*) filter (where c.d <= current_date-1) d1_den,
      count(*) filter (where c.d <= current_date-1 and exists(
        select 1 from alldays a where a.game_id=c.game_id and a.user_id=c.user_id and a.d = c.d+1)) d1_num,
      count(*) filter (where c.d <= current_date-7) d7_den,
      count(*) filter (where c.d <= current_date-7 and exists(
        select 1 from alldays a where a.game_id=c.game_id and a.user_id=c.user_id and a.d > c.d and a.d <= c.d+7)) d7_num
    from cohort c group by c.game_id
  ),
  lk as (select game_id, count(*) c from likes    where created_at >= f and created_at < t group by game_id),
  cm as (select game_id, count(*) c from comments where created_at >= f and created_at < t group by game_id),
  sh as (select game_id, count(*) c from shares   where created_at >= f and created_at < t group by game_id),
  sv as (select game_id, count(*) c from saves    where created_at >= f and created_at < t group by game_id)
  select g.id, g.title, g.status,
    coalesce(agg.impressions,0), coalesce(agg.s3,0), coalesce(agg.s10,0),
    round(100.0 * coalesce(agg.s10,0) / nullif(agg.impressions,0), 1),
    round((coalesce(agg.avg_ms,0) / 1000.0)::numeric, 1),
    coalesce(agg.players,0),
    coalesce(lk.c,0), coalesce(cm.c,0), coalesce(sh.c,0), coalesce(sv.c,0),
    round(100.0 * ret.d1_num / nullif(ret.d1_den,0), 1),
    round(100.0 * ret.d7_num / nullif(ret.d7_den,0), 1)
  from games g
  left join agg on agg.game_id = g.id
  left join ret on ret.game_id = g.id
  left join lk  on lk.game_id  = g.id
  left join cm  on cm.game_id  = g.id
  left join sh  on sh.game_id  = g.id
  left join sv  on sv.game_id  = g.id
  where g.status <> 'deleted'
  order by coalesce(agg.impressions,0) desc, g.title;
end $$;

-- ───────────────────────── ИГРЫ: временной ряд ─────────────────────────────
create or replace function public.admin_games_timeseries(
  p_from timestamptz default null, p_to timestamptz default null,
  p_bucket text default 'day', p_game_id text default null)
returns table(bucket date, impressions bigint, sessions_3s bigint, sessions_10s bigint)
language plpgsql security definer set search_path = public as $$
declare f timestamptz; t timestamptz; step interval; trunc text;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  t := coalesce(p_to, now());
  f := coalesce(p_from, (select min(created_at) from game_stats));
  if f is null then f := t - interval '14 days'; end if;
  trunc := case when p_bucket = 'week' then 'week' else 'day' end;
  step  := case when p_bucket = 'week' then interval '1 week' else interval '1 day' end;
  return query
  with series as (select generate_series(date_trunc(trunc, f), date_trunc(trunc, t), step)::date b),
  s as (
    select date_trunc(trunc, created_at)::date b,
      count(*) filter (where loaded) imp,
      count(*) filter (where active_ms >= 3000)  s3,
      count(*) filter (where active_ms >= 10000) s10
    from game_stats
    where created_at >= f and created_at <= t and (p_game_id is null or game_id = p_game_id)
    group by 1
  )
  select se.b, coalesce(s.imp,0), coalesce(s.s3,0), coalesce(s.s10,0)
  from series se left join s on s.b = se.b order by se.b;
end $$;

-- ─────────────────────────────── GRANTS ────────────────────────────────────
-- Вызов только для authenticated; не-админ получит 'forbidden' внутри (guard).
revoke all on function public.admin_audience_overview(timestamptz,timestamptz)        from public;
revoke all on function public.admin_audience_timeseries(timestamptz,timestamptz,text) from public;
revoke all on function public.admin_audience_retention()                              from public;
revoke all on function public.admin_games_overview(timestamptz,timestamptz)           from public;
revoke all on function public.admin_games_timeseries(timestamptz,timestamptz,text,text) from public;
grant execute on function public.admin_audience_overview(timestamptz,timestamptz)        to authenticated;
grant execute on function public.admin_audience_timeseries(timestamptz,timestamptz,text) to authenticated;
grant execute on function public.admin_audience_retention()                              to authenticated;
grant execute on function public.admin_games_overview(timestamptz,timestamptz)           to authenticated;
grant execute on function public.admin_games_timeseries(timestamptz,timestamptz,text,text) to authenticated;
-- Анону execute не нужен (только залогиненный админ) — убираем поверхность атаки.
revoke execute on function public.admin_audience_overview(timestamptz,timestamptz)        from anon;
revoke execute on function public.admin_audience_timeseries(timestamptz,timestamptz,text) from anon;
revoke execute on function public.admin_audience_retention()                              from anon;
revoke execute on function public.admin_games_overview(timestamptz,timestamptz)           from anon;
revoke execute on function public.admin_games_timeseries(timestamptz,timestamptz,text,text) from anon;
