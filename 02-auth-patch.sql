-- =============================================================
--  Phase 2 patch — run after 01-schema.sql
--  Makes signup survive bad or duplicate usernames instead of
--  rolling back the whole auth.users insert.
-- =============================================================

-- Usernames should collide case-insensitively. "Prince" and "prince"
-- are the same person as far as anyone reading the UI is concerned.
create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));


-- -------------------------------------------------------------
--  Availability check, callable before the user is signed in.
--  security definer so anon can ask "is this taken?" without
--  being able to SELECT the profiles table and enumerate users.
--  Returns a bare boolean — no rows, nothing to scrape.
-- -------------------------------------------------------------
create or replace function public.username_available(candidate text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select candidate ~ '^[a-zA-Z0-9_]{3,20}$'
     and not exists (
       select 1 from public.profiles
       where lower(username) = lower(candidate)
     );
$$;

revoke all on function public.username_available(text) from public;
grant execute on function public.username_available(text) to anon, authenticated;


-- -------------------------------------------------------------
--  Hardened signup trigger.
--  Strips illegal characters, falls back to a generated name if
--  what's left is too short, and appends a numeric suffix on
--  collision. Signup never fails because of a username.
-- -------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested text;
  base      text;
  candidate text;
  suffix    integer := 0;
begin
  requested := coalesce(new.raw_user_meta_data ->> 'username', '');

  -- keep only characters the constraint allows
  base := regexp_replace(requested, '[^a-zA-Z0-9_]', '', 'g');

  if length(base) < 3 then
    base := 'user_' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;

  base      := left(base, 20);
  candidate := base;

  -- walk suffixes until we find a free one
  while exists (
    select 1 from public.profiles where lower(username) = lower(candidate)
  ) loop
    suffix    := suffix + 1;
    candidate := left(base, 19 - length(suffix::text)) || '_' || suffix::text;
  end loop;

  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    candidate,
    coalesce(nullif(trim(requested), ''), candidate)
  );

  return new;
end;
$$;
