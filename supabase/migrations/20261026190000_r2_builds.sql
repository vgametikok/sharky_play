-- Multi-file builds on R2 (worker sharky-games). Additive only. Applied 2026-10-26.
alter table public.games
  add column if not exists build_type text not null default 'html',
  add column if not exists build_size bigint,
  add column if not exists build_files integer;
alter table public.game_versions
  add column if not exists build_type text not null default 'html',
  add column if not exists build_size bigint,
  add column if not exists build_files integer;
comment on column public.games.build_type is 'html = single file (Storage/GitHub), r2 = multi-file build on sharky-games worker';
