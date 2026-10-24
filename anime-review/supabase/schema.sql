-- 由本机 db:init 命令自动执行。保留已有身份、评价和片单，并升级本应用的结构与权限。
begin;

create table if not exists public.club_seasons (
  id text primary key,
  title text not null check (char_length(btrim(title)) between 1 and 80),
  current_phase text not null default 'final' check (current_phase in ('early', 'final')),
  is_open boolean not null default true
);
create table if not exists public.club_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.club_admins enable row level security;
drop policy if exists "admin can see own role" on public.club_admins;
create policy "admin can see own role" on public.club_admins for select to authenticated using (user_id = (select auth.uid()));
-- Role membership is managed by the local provisioning tool, never by a public browser user.
revoke all on public.club_admins from anon, authenticated;
grant select on public.club_admins to authenticated;

create or replace function public.club_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.club_admins where user_id = (select auth.uid()));
$$;
revoke all on function public.club_is_admin() from public;
grant execute on function public.club_is_admin() to anon, authenticated;

create table if not exists public.club_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  cn text not null check (cn = btrim(cn) and char_length(cn) between 1 and 40),
  qq text check (qq ~ '^[1-9][0-9]{4,19}$'),
  updated_at timestamptz not null default now()
);
-- Upgrade existing profiles without treating their old contact number as a QQ ID.
alter table public.club_profiles add column if not exists qq text check (qq ~ '^[1-9][0-9]{4,19}$');
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'club_profiles' and column_name = 'phone') then
    alter table public.club_profiles alter column phone drop not null;
  end if;
end;
$$;
-- Existing profiles may have no QQ yet; all new or updated profiles must supply one.
alter table public.club_profiles drop constraint if exists club_profiles_qq_required;
alter table public.club_profiles add constraint club_profiles_qq_required check (qq is not null) not valid;
create table if not exists public.club_anime (
  id text primary key,
  season_id text not null references public.club_seasons(id),
  title text not null check (title = btrim(title) and char_length(title) between 1 and 200),
  sort_order integer not null default 1000,
  is_approved boolean not null default false,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists club_anime_unique_title on public.club_anime(season_id, lower(btrim(title)));
create table if not exists public.club_reviews (
  user_id uuid not null references public.club_profiles(id) on delete cascade,
  anime_id text not null references public.club_anime(id) on delete cascade,
  phase text not null check (phase in ('early', 'final')),
  score numeric check (score between 0 and 5 and score = round(score, 1)),
  comment text not null default '' check (char_length(comment) <= 20000),
  updated_at timestamptz not null default now(),
  primary key (user_id, anime_id, phase)
);
create index if not exists club_reviews_anime_phase on public.club_reviews(anime_id, phase);
create or replace function public.club_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists club_profile_timestamp on public.club_profiles;
create trigger club_profile_timestamp before update on public.club_profiles for each row execute function public.club_touch_updated_at();
drop trigger if exists club_review_timestamp on public.club_reviews;
create trigger club_review_timestamp before update on public.club_reviews for each row execute function public.club_touch_updated_at();

create or replace function public.club_anime_is_open(anime text)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists(select 1 from public.club_anime a join public.club_seasons s on s.id = a.season_id
    where a.id = anime and s.is_open);
$$;
revoke all on function public.club_anime_is_open(text) from public;
grant execute on function public.club_anime_is_open(text) to authenticated;

alter table public.club_seasons enable row level security;
alter table public.club_profiles enable row level security;
alter table public.club_anime enable row level security;
alter table public.club_reviews enable row level security;

revoke all on public.club_seasons, public.club_profiles, public.club_anime, public.club_reviews from anon, authenticated;
grant select on public.club_seasons, public.club_anime to anon, authenticated;
grant update on public.club_seasons to authenticated;
grant select, insert, update on public.club_profiles to authenticated;
grant insert, update, delete on public.club_anime to authenticated;
grant select, insert, update, delete on public.club_reviews to authenticated;

drop policy if exists "season read" on public.club_seasons;
create policy "season read" on public.club_seasons for select to anon, authenticated using (true);
drop policy if exists "season admin update" on public.club_seasons;
create policy "season admin update" on public.club_seasons for update to authenticated using ((select public.club_is_admin())) with check ((select public.club_is_admin()));

drop policy if exists "profile read own or admin" on public.club_profiles;
create policy "profile read own or admin" on public.club_profiles for select to authenticated using (id = (select auth.uid()) or (select public.club_is_admin()));
drop policy if exists "profile insert own" on public.club_profiles;
create policy "profile insert own" on public.club_profiles for insert to authenticated with check (id = (select auth.uid()));
drop policy if exists "profile update own" on public.club_profiles;
create policy "profile update own" on public.club_profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists "anime read" on public.club_anime;
create policy "anime read" on public.club_anime for select to anon, authenticated using (is_approved or (select public.club_is_admin()));
drop policy if exists "anime suggest" on public.club_anime;
drop policy if exists "anime admin insert" on public.club_anime;
create policy "anime admin insert" on public.club_anime for insert to authenticated with check ((select public.club_is_admin()));
drop policy if exists "anime admin update" on public.club_anime;
create policy "anime admin update" on public.club_anime for update to authenticated using ((select public.club_is_admin())) with check ((select public.club_is_admin()));
drop policy if exists "anime admin delete" on public.club_anime;
create policy "anime admin delete" on public.club_anime for delete to authenticated using ((select public.club_is_admin()));

drop policy if exists "reviews read own or admin" on public.club_reviews;
create policy "reviews read own or admin" on public.club_reviews for select to authenticated using (user_id = (select auth.uid()) or (select public.club_is_admin()));
drop policy if exists "reviews insert own while open" on public.club_reviews;
create policy "reviews insert own while open" on public.club_reviews for insert to authenticated with check (user_id = (select auth.uid()) and public.club_anime_is_open(anime_id));
drop policy if exists "reviews update own while open" on public.club_reviews;
create policy "reviews update own while open" on public.club_reviews for update to authenticated using (user_id = (select auth.uid()) and public.club_anime_is_open(anime_id)) with check (user_id = (select auth.uid()) and public.club_anime_is_open(anime_id));
drop policy if exists "reviews delete own while open" on public.club_reviews;
create policy "reviews delete own while open" on public.club_reviews for delete to authenticated using (user_id = (select auth.uid()) and public.club_anime_is_open(anime_id));

-- Remove the legacy scheduled-closing field after replacing its dependent rules.
alter table public.club_seasons drop column if exists closes_at;

insert into public.club_seasons(id, title, current_phase) values ('2026-07', '2026 七月新番', 'final') on conflict (id) do nothing;
select pg_notify('pgrst', 'reload schema');
commit;
