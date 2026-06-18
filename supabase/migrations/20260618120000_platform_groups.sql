-- ============================================================================
--  SHARKY — Аналитика: группировка платформ в человекочитаемые бакеты
-- ----------------------------------------------------------------------------
--  Telegram отдаёт только сырой tg.platform (android/android_x/ios/macos/
--  tdesktop/weba/webk/web/unigram/…). Раньше дашборд показывал эти сырые
--  значения как есть. Теперь сворачиваем их в осмысленные группы:
--
--    📱 TMA Android  ← android, android_x
--    🍎 TMA iOS      ← ios
--    🌐 Telegram Web ← weba, webk, web
--    🖥 Desktop      ← tdesktop, macos, unigram
--    🤖 Android (app)← app_android   ← БУДУЩЕЕ: отдельное нативное Android-прилож.
--    📲 iOS (app)    ← app_ios       ← БУДУЩЕЕ: отдельное нативное iOS-прилож.
--    ❓ other        ← всё прочее / null
--
--  ВАЖНО: нативные приложения (появятся позже) должны слать platform='app_android'
--  / 'app_ios', а НЕ 'android'/'ios' — иначе сольются с TMA. Сейчас этих значений
--  в данных нет, поэтому бакеты пустые (placeholder'ы в UI).
--
--  Группируем на ЧТЕНИИ (внутри RPC), а не на записи: tg-auth/фронт продолжают
--  писать сырой tg.platform, вся история перегруппируется автоматически.
--  Группировка ОБЯЗАНА быть в SQL: count(distinct user_id) по сырым значениям,
--  просуммированный в JS, задвоил бы юзеров, попавших и на weba, и на webk.
-- ============================================================================

-- ─────────────────────── helper: сырой platform → бакет ────────────────────
create or replace function public.platform_group(p text)
returns text language sql immutable as $$
  select case
    when p in ('android','android_x')               then 'tma_android'
    when p = 'ios'                                   then 'tma_ios'
    when p in ('weba','webk','web')                  then 'tg_web'
    when p in ('tdesktop','macos','unigram')         then 'desktop'
    when p in ('app_android','android_app','native_android') then 'android_app'
    when p in ('app_ios','ios_app','native_ios')             then 'ios_app'
    else 'other'
  end
$$;
comment on function public.platform_group(text) is
  'Сворачивает сырой Telegram tg.platform в бакет для аналитики. Чистая функция, без доступа к данным.';

-- ────────────── АУДИТОРИЯ: обзор (только platforms-подзапрос меняется) ──────
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
    'platforms', (select coalesce(jsonb_agg(jsonb_build_object('key', g, 'users', u) order by u desc), '[]'::jsonb)
                  from (select public.platform_group(platform) g, count(distinct user_id) u from app_opens
                        where opened_at >= f and opened_at < t group by public.platform_group(platform)) p),
    'languages', (select coalesce(jsonb_agg(jsonb_build_object('key', coalesce(language_code,'—'), 'users', u) order by u desc), '[]'::jsonb)
                  from (select language_code, count(distinct user_id) u from app_opens
                        where opened_at >= f and opened_at < t group by language_code order by u desc limit 8) l),
    'referrals', (select coalesce(jsonb_agg(jsonb_build_object('key', coalesce(nullif(referral,''),'direct'), 'users', u) order by u desc), '[]'::jsonb)
                  from (select referral, count(distinct user_id) u from app_opens
                        where opened_at >= f and opened_at < t group by referral order by u desc limit 8) r)
  ) into res;
  return res;
end $$;

-- ───────── ИГРА: детальная статистика (только platforms-подзапрос меняется) ──
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
    'platforms', (select coalesce(jsonb_agg(jsonb_build_object('key',g,'users',u) order by u desc),'[]'::jsonb)
                  from (select public.platform_group(us.platform) g, count(distinct s.user_id) u
                        from stats s join users us on us.id = s.user_id
                        where s.active_ms>=3000 group by public.platform_group(us.platform)) pp)
  ) into res;
  return res;
end $$;

-- Гранты сохраняются при create or replace (сигнатуры не менялись), но повторим
-- явно для надёжности — паттерн как у остальных admin_* RPC.
revoke all    on function public.admin_audience_overview(timestamptz,timestamptz) from public;
grant execute on function public.admin_audience_overview(timestamptz,timestamptz) to authenticated;
revoke execute on function public.admin_audience_overview(timestamptz,timestamptz) from anon;
revoke all    on function public.admin_game_detail(text,timestamptz,timestamptz) from public;
grant execute on function public.admin_game_detail(text,timestamptz,timestamptz) to authenticated;
revoke execute on function public.admin_game_detail(text,timestamptz,timestamptz) from anon;
