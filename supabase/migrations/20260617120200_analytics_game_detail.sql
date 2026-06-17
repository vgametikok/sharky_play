-- ============================================================================
--  SHARKY — Аналитика, часть 3: детальная статистика по одной игре (drill-in)
-- ----------------------------------------------------------------------------
--  Питает отдельную страницу игры в админ-дашборде. Возвращает jsonb:
--    game      — карточка игры
--    totals    — показы/сессии>3с/>10с/hook/ср.время/медиана/игроки + соц + удержание D1/D7/D30
--    histogram — распределение длительности «вида» (dwell) по корзинам
--    platforms — топ платформ игроков этой игры
--  Временной ряд берётся отдельным вызовом admin_games_timeseries(..., p_game_id).
--  SECURITY DEFINER + is_admin() (паттерн как у остальных admin_* RPC).
-- ============================================================================

create or replace function public.admin_game_detail(
  p_game_id text, p_from timestamptz default null, p_to timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  f timestamptz := coalesce(p_from, '-infinity');
  t timestamptz := coalesce(p_to,   'infinity');
  res jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  with stats as (
    select gs.user_id, gs.active_ms, gs.loaded, gs.created_at
    from game_stats gs
    where gs.game_id = p_game_id and gs.created_at >= f and gs.created_at < t
  ),
  cohort as (
    select distinct user_id, created_at::date d from stats
    where loaded and active_ms >= 3000 and user_id is not null
  ),
  alldays as (   -- сторона «возврата» считается по всей истории (не ограничена окном)
    select distinct user_id, created_at::date d from game_stats
    where game_id = p_game_id and loaded and active_ms >= 3000 and user_id is not null
  ),
  ret as (
    select
      count(*) filter (where c.d <= current_date-1)  d1_den,
      count(*) filter (where c.d <= current_date-1  and exists(select 1 from alldays a where a.user_id=c.user_id and a.d = c.d+1)) d1_num,
      count(*) filter (where c.d <= current_date-7)  d7_den,
      count(*) filter (where c.d <= current_date-7  and exists(select 1 from alldays a where a.user_id=c.user_id and a.d > c.d and a.d <= c.d+7))  d7_num,
      count(*) filter (where c.d <= current_date-30) d30_den,
      count(*) filter (where c.d <= current_date-30 and exists(select 1 from alldays a where a.user_id=c.user_id and a.d > c.d and a.d <= c.d+30)) d30_num
    from cohort c
  )
  select jsonb_build_object(
    'game', (select jsonb_build_object('id',g.id,'title',g.title,'status',g.status,
               'emoji',g.emoji,'bg',g.bg,'author_id',g.author_id,'genre',g.genre,
               'setting',g.setting,'difficulty',g.difficulty,'created_at',g.created_at)
             from games g where g.id = p_game_id),
    'totals', jsonb_build_object(
      'impressions',        (select count(*) from stats where loaded),
      'sessions_3s',        (select count(*) from stats where active_ms >= 3000),
      'sessions_10s',       (select count(*) from stats where active_ms >= 10000),
      'hook_rate',          (select round(100.0 * count(*) filter(where active_ms>=10000) / nullif(count(*) filter(where loaded),0), 1) from stats),
      'avg_session_sec',    (select round((avg(active_ms) filter(where active_ms>=3000) / 1000.0)::numeric, 1) from stats),
      'median_session_sec', (select round((percentile_cont(0.5) within group (order by active_ms) / 1000.0)::numeric, 1) from stats where active_ms>=3000),
      'players',            (select count(distinct user_id) filter(where active_ms>=3000) from stats),
      'likes',    (select count(*) from likes    where game_id=p_game_id and created_at>=f and created_at<t),
      'comments', (select count(*) from comments where game_id=p_game_id and created_at>=f and created_at<t),
      'shares',   (select count(*) from shares   where game_id=p_game_id and created_at>=f and created_at<t),
      'saves',    (select count(*) from saves    where game_id=p_game_id and created_at>=f and created_at<t),
      'retention_d1',  (select round(100.0*d1_num /nullif(d1_den,0), 1) from ret),
      'retention_d7',  (select round(100.0*d7_num /nullif(d7_den,0), 1) from ret),
      'retention_d30', (select round(100.0*d30_num/nullif(d30_den,0),1) from ret),
      'cohort_d1',  (select d1_den  from ret),
      'cohort_d7',  (select d7_den  from ret),
      'cohort_d30', (select d30_den from ret)
    ),
    'histogram', jsonb_build_array(
      jsonb_build_object('key','<3с',    'n',(select count(*) from stats where loaded and active_ms<3000)),
      jsonb_build_object('key','3–10с',  'n',(select count(*) from stats where active_ms>=3000  and active_ms<10000)),
      jsonb_build_object('key','10–30с', 'n',(select count(*) from stats where active_ms>=10000 and active_ms<30000)),
      jsonb_build_object('key','30–60с', 'n',(select count(*) from stats where active_ms>=30000 and active_ms<60000)),
      jsonb_build_object('key','>60с',   'n',(select count(*) from stats where active_ms>=60000))
    ),
    'platforms', (select coalesce(jsonb_agg(jsonb_build_object('key',p,'users',u) order by u desc),'[]'::jsonb)
                  from (select coalesce(us.platform,'—') p, count(distinct s.user_id) u
                        from stats s join users us on us.id = s.user_id
                        where s.active_ms>=3000 group by 1 order by u desc limit 8) pp)
  ) into res;
  return res;
end $$;

revoke all    on function public.admin_game_detail(text,timestamptz,timestamptz) from public;
grant execute on function public.admin_game_detail(text,timestamptz,timestamptz) to authenticated;
revoke execute on function public.admin_game_detail(text,timestamptz,timestamptz) from anon;
