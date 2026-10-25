-- 由本机 db:init 命令自动执行。保留已有身份、评价和片单，并升级本应用的结构与权限。
begin;

-- 一个番季 = 年份 + 季度起始月份（1、4、7、10）。id 统一为 YYYY-MM。
-- is_current 只能有一个为 true，普通社员只能读取当期番季。
create table if not exists public.club_seasons (
  id text primary key,
  year integer not null,
  month integer not null,
  title text not null check (char_length(btrim(title)) between 1 and 80),
  current_phase text not null default 'final' check (current_phase in ('early', 'final')),
  is_open boolean not null default true,
  is_current boolean not null default false
);
alter table public.club_seasons add column if not exists year integer;
alter table public.club_seasons add column if not exists month integer;
alter table public.club_seasons add column if not exists is_current boolean not null default false;

-- 旧库只有 2026-07 这类 id，先用 id 回填年份和季度，再收紧约束。
update public.club_seasons
set year = case when id ~ '^[0-9]{4}-[0-9]{1,2}$' then split_part(id, '-', 1)::integer else 2026 end
where year is null;
update public.club_seasons
set month = case when id ~ '^[0-9]{4}-[0-9]{1,2}$' then split_part(id, '-', 2)::integer else 7 end
where month is null;
alter table public.club_seasons alter column year set not null;
alter table public.club_seasons alter column month set not null;

alter table public.club_seasons drop constraint if exists club_seasons_year_check;
alter table public.club_seasons add constraint club_seasons_year_check check (year between 2000 and 2100);
alter table public.club_seasons drop constraint if exists club_seasons_month_check;
alter table public.club_seasons add constraint club_seasons_month_check check (month in (1, 4, 7, 10));
create unique index if not exists club_seasons_year_month on public.club_seasons(year, month);

-- 旧库如果意外存在多个当期，保留 id 最大的一个，避免唯一索引创建失败。
with ranked as (
  select id, row_number() over (order by id desc) as position
  from public.club_seasons where is_current
)
update public.club_seasons s set is_current = false
from ranked r where s.id = r.id and r.position > 1;
create unique index if not exists club_seasons_one_current on public.club_seasons(is_current) where is_current;

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
  id uuid primary key,
  cn text not null check (cn = btrim(cn) and char_length(cn) between 1 and 40),
  qq text not null check (qq ~ '^[1-9][0-9]{4,19}$'),
  updated_at timestamptz not null default now()
);
-- 旧版 profile.id 直接引用 auth.users；现在 id 是稳定的社团成员 id，浏览器会话单独映射。
alter table public.club_profiles drop constraint if exists club_profiles_id_fkey;
-- Upgrade existing profiles without treating their old contact number as a QQ ID.
alter table public.club_profiles add column if not exists qq text check (qq ~ '^[1-9][0-9]{4,19}$');
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'club_profiles' and column_name = 'phone') then
    alter table public.club_profiles alter column phone drop not null;
  end if;
end;
$$;
alter table public.club_profiles alter column qq set not null;
alter table public.club_profiles drop constraint if exists club_profiles_qq_required;

-- 一个 QQ 只能对应一个成员；有重复时先报错，避免 db:init 静默合并数据。
do $$
begin
  if exists (select 1 from public.club_profiles where qq is not null group by qq having count(*) > 1) then
    raise exception 'club_profiles 存在重复 QQ，请先合并重复账号，再运行 db:init。';
  end if;
end;
$$;
create unique index if not exists club_profiles_unique_qq on public.club_profiles(qq);

-- user_id 是当前浏览器的 auth 会话，profile_id 是稳定成员；同一成员可以映射多个浏览器。
create table if not exists public.club_profile_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  profile_id uuid not null references public.club_profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists club_profile_sessions_profile on public.club_profile_sessions(profile_id);
insert into public.club_profile_sessions (user_id, profile_id)
select p.id, p.id from public.club_profiles p
join auth.users u on u.id = p.id
on conflict (user_id) do nothing;

create or replace function public.club_current_profile()
returns uuid language sql stable security definer set search_path = '' as $$
  select profile_id from public.club_profile_sessions where user_id = (select auth.uid());
$$;
revoke all on function public.club_current_profile() from public;
grant execute on function public.club_current_profile() to authenticated;

-- CN + QQ 登录/登记：QQ 唯一，CN 必须匹配；新浏览器会映射到已有成员。
create or replace function public.club_login(p_cn text, p_qq text)
returns public.club_profiles
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_cn text := btrim(coalesce(p_cn, ''));
  v_qq text := btrim(coalesce(p_qq, ''));
  v_profile public.club_profiles;
  v_current uuid;
begin
  if v_uid is null then
    raise exception '登录状态已失效，请刷新页面后重试。' using errcode = '42501';
  end if;
  if v_cn = '' or char_length(v_cn) > 40 then
    raise exception 'CN 请输入 1～40 个字。' using errcode = '22023';
  end if;
  if v_qq !~ '^[1-9][0-9]{4,19}$' then
    raise exception 'QQ 号请填写 5～20 位数字，首位不能为 0。' using errcode = '22023';
  end if;

  select public.club_current_profile() into v_current;

  select * into v_profile from public.club_profiles where qq = v_qq;
  if found then
    if v_current = v_profile.id then
      update public.club_profiles set cn = v_cn where id = v_profile.id returning * into v_profile;
      return v_profile;
    end if;
    if v_profile.cn <> v_cn then
      raise exception 'CN 和 QQ 不匹配，请检查后重试，或联系管理员。' using errcode = '22023';
    end if;
    if v_current is not null then
      raise exception '当前浏览器已绑定另一个账号，请清空本站数据后再登录。' using errcode = '22023';
    end if;
    insert into public.club_profile_sessions (user_id, profile_id) values (v_uid, v_profile.id);
    return v_profile;
  end if;

  if v_current is not null then
    update public.club_profiles set cn = v_cn, qq = v_qq where id = v_current returning * into v_profile;
    return v_profile;
  end if;

  -- 兼容历史 profile.id = auth.uid 但没有映射记录的情况。
  select * into v_profile from public.club_profiles where id = v_uid;
  if found then
    update public.club_profiles set cn = v_cn, qq = v_qq where id = v_uid returning * into v_profile;
    insert into public.club_profile_sessions (user_id, profile_id) values (v_uid, v_profile.id);
    return v_profile;
  end if;

  insert into public.club_profiles (id, cn, qq) values (v_uid, v_cn, v_qq) returning * into v_profile;
  insert into public.club_profile_sessions (user_id, profile_id) values (v_uid, v_profile.id);
  return v_profile;
end;
$$;
revoke all on function public.club_login(text, text) from public, anon;
grant execute on function public.club_login(text, text) to authenticated;

create table if not exists public.club_anime (
  id text primary key,
  season_id text not null references public.club_seasons(id),
  title text not null check (title = btrim(title) and char_length(title) between 1 and 200),
  cover_url text,
  sort_order integer not null default 1000,
  is_approved boolean not null default false,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.club_anime add column if not exists cover_url text;
alter table public.club_anime drop constraint if exists club_anime_cover_url_check;
alter table public.club_anime add constraint club_anime_cover_url_check check (cover_url is null or cover_url ~* '^https?://');
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

-- 只有“当期且开放”的番剧可以写入评价。旧番季保留评价，但不能继续新增。
create or replace function public.club_anime_is_open(anime text)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists(
    select 1
    from public.club_anime a
    join public.club_seasons s on s.id = a.season_id
    where a.id = anime and a.is_approved and s.is_open and s.is_current
  );
$$;
revoke all on function public.club_anime_is_open(text) from public;
grant execute on function public.club_anime_is_open(text) to authenticated;

-- 社员展开番剧时读取当期公开评价。只返回 CN，不暴露 QQ 或其他用户的身份信息。
create or replace function public.club_anime_reviews(p_anime text)
returns table (phase text, score numeric, comment text, updated_at timestamptz, cn text, is_mine boolean)
language sql stable security definer set search_path = '' as $$
  select r.phase, r.score, r.comment, r.updated_at, p.cn, r.user_id = (select public.club_current_profile())
  from public.club_reviews r
  join public.club_profiles p on p.id = r.user_id
  join public.club_anime a on a.id = r.anime_id
  join public.club_seasons s on s.id = a.season_id
  where r.anime_id = p_anime
    and a.is_approved
    and s.is_current
    and (r.score is not null or btrim(r.comment) <> '')
  order by r.phase, p.cn;
$$;
revoke all on function public.club_anime_reviews(text) from public, anon;
grant execute on function public.club_anime_reviews(text) to authenticated;

alter table public.club_seasons enable row level security;
alter table public.club_profiles enable row level security;
alter table public.club_profile_sessions enable row level security;
alter table public.club_anime enable row level security;
alter table public.club_reviews enable row level security;

revoke all on public.club_seasons, public.club_profiles, public.club_profile_sessions, public.club_anime, public.club_reviews from anon, authenticated;
grant select on public.club_seasons, public.club_anime to anon, authenticated;
grant update on public.club_seasons to authenticated;
grant select on public.club_profiles to authenticated;
grant insert, update, delete on public.club_anime to authenticated;
grant select, insert, update, delete on public.club_reviews to authenticated;

-- 普通社员只能看到当期番季；管理员可以读取全部番季和全部片单。
drop policy if exists "season read" on public.club_seasons;
create policy "season read" on public.club_seasons for select to anon, authenticated
  using (is_current or (select public.club_is_admin()));
drop policy if exists "season admin update" on public.club_seasons;
create policy "season admin update" on public.club_seasons for update to authenticated
  using ((select public.club_is_admin())) with check ((select public.club_is_admin()));

-- profile 只允许读取当前会话映射到的成员；写入统一走 club_login。
drop policy if exists "profile read own or admin" on public.club_profiles;
create policy "profile read own or admin" on public.club_profiles for select to authenticated using (id = (select public.club_current_profile()) or (select public.club_is_admin()));
drop policy if exists "profile insert own" on public.club_profiles;
drop policy if exists "profile update own" on public.club_profiles;

drop policy if exists "anime read" on public.club_anime;
create policy "anime read" on public.club_anime for select to anon, authenticated using (
  (select public.club_is_admin())
  or (
    is_approved
    and exists (
      select 1 from public.club_seasons s
      where s.id = club_anime.season_id and s.is_current
    )
  )
);
drop policy if exists "anime suggest" on public.club_anime;
drop policy if exists "anime admin insert" on public.club_anime;
create policy "anime admin insert" on public.club_anime for insert to authenticated with check ((select public.club_is_admin()));
drop policy if exists "anime admin update" on public.club_anime;
create policy "anime admin update" on public.club_anime for update to authenticated using ((select public.club_is_admin())) with check ((select public.club_is_admin()));
drop policy if exists "anime admin delete" on public.club_anime;
create policy "anime admin delete" on public.club_anime for delete to authenticated using ((select public.club_is_admin()));

-- 评价归属稳定成员 profile id；同一成员换浏览器后仍能读写自己的评价。
drop policy if exists "reviews read own or admin" on public.club_reviews;
create policy "reviews read own or admin" on public.club_reviews for select to authenticated using (user_id = (select public.club_current_profile()) or (select public.club_is_admin()));
drop policy if exists "reviews insert own while open" on public.club_reviews;
create policy "reviews insert own while open" on public.club_reviews for insert to authenticated with check (user_id = (select public.club_current_profile()) and public.club_anime_is_open(anime_id));
drop policy if exists "reviews update own while open" on public.club_reviews;
create policy "reviews update own while open" on public.club_reviews for update to authenticated using (user_id = (select public.club_current_profile()) and public.club_anime_is_open(anime_id)) with check (user_id = (select public.club_current_profile()) and public.club_anime_is_open(anime_id));
drop policy if exists "reviews delete own while open" on public.club_reviews;
create policy "reviews delete own while open" on public.club_reviews for delete to authenticated using (user_id = (select public.club_current_profile()) and public.club_anime_is_open(anime_id));

-- 新建番季和切换当期由管理员调用，客户端不需要直接写 club_seasons。
create or replace function public.club_create_season(p_year integer, p_month integer)
returns public.club_seasons
language plpgsql security definer set search_path = '' as $$
declare
  v_id text;
  v_title text;
  v_month_label text;
  v_row public.club_seasons;
begin
  if not public.club_is_admin() then
    raise exception '只有管理员可以创建番季。' using errcode = '42501';
  end if;
  if p_year is null or p_year < 2000 or p_year > 2100 then
    raise exception '年份需在 2000～2100 之间。' using errcode = '22023';
  end if;
  if p_month is null or p_month not in (1, 4, 7, 10) then
    raise exception '季度月份只能是 1、4、7、10。' using errcode = '22023';
  end if;
  select * into v_row from public.club_seasons where year = p_year and month = p_month;
  if found then return v_row; end if;
  v_id := p_year::text || '-' || lpad(p_month::text, 2, '0');
  v_month_label := case p_month when 1 then '一月' when 4 then '四月' when 7 then '七月' when 10 then '十月' end;
  v_title := p_year::text || ' ' || v_month_label || '新番';
  insert into public.club_seasons (id, year, month, title, current_phase, is_open, is_current)
  values (v_id, p_year, p_month, v_title, 'early', true, false)
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.club_create_season(integer, integer) from public;
grant execute on function public.club_create_season(integer, integer) to authenticated;

create or replace function public.club_set_current_season(p_season text)
returns public.club_seasons
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.club_seasons;
begin
  if not public.club_is_admin() then
    raise exception '只有管理员可以切换当期番季。' using errcode = '42501';
  end if;
  select * into v_row from public.club_seasons where id = p_season;
  if not found then
    raise exception '找不到这个番季，请刷新后重试。' using errcode = 'P0002';
  end if;
  update public.club_seasons set is_current = false where is_current;
  update public.club_seasons set is_current = true where id = p_season returning * into v_row;
  return v_row;
end;
$$;
revoke all on function public.club_set_current_season(text) from public;
grant execute on function public.club_set_current_season(text) to authenticated;

-- Remove the legacy scheduled-closing field after replacing its dependent rules.
alter table public.club_seasons drop column if exists closes_at;

insert into public.club_seasons(id, year, month, title, current_phase, is_open, is_current)
values ('2026-07', 2026, 7, '2026 七月新番', 'final', true, false)
on conflict (id) do update set year = excluded.year, month = excluded.month;

-- 首次升级时把 2026-07 设为当期；已有当期则保持不变。
update public.club_seasons set is_current = true
where id = '2026-07' and not exists (select 1 from public.club_seasons where is_current);

select pg_notify('pgrst', 'reload schema');
commit;
