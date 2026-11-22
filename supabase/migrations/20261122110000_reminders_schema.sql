-- Desk Buddy: core schema.
-- Conventions: every function sets search_path = '' and fully qualifies names; RLS is enabled on
-- every table with explicit policies (default deny); privileges are revoked before being granted.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- New functions in public must not be executable by anon/authenticated unless granted explicitly.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;

create type public.reminder_status as enum ('pending', 'fired', 'done', 'snoozed');

-- ---------------------------------------------------------------------------------------------
-- Repeat rules: a constrained RRULE subset, mirrored 1:1 by packages/core/src/repeat.ts and
-- checked against the same fixtures (packages/core/test/repeat-cases.json).
-- ---------------------------------------------------------------------------------------------
create type private.repeat_rule as (
  freq text,
  step integer,
  by_day integer[], -- 0 = Monday .. 6 = Sunday
  until timestamptz
);

create function private.parse_repeat_rule(p_rule text)
returns private.repeat_rule
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_raw text := upper(regexp_replace(btrim(p_rule), '^RRULE:', '', 'i'));
  v_part text;
  v_key text;
  v_val text;
  v_seen text[] := '{}';
  v_out private.repeat_rule := row(null, 1, null, null);
  v_day text;
  v_days text[] := array['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  v_idx integer;
begin
  if v_raw is null or v_raw = '' or length(v_raw) > 200 then
    raise exception 'invalid repeat rule: empty or too long' using errcode = '22023';
  end if;
  foreach v_part in array string_to_array(v_raw, ';') loop
    if v_part !~ '^[A-Z]+=[^=]+$' then
      raise exception 'invalid repeat rule: malformed part' using errcode = '22023';
    end if;
    v_key := split_part(v_part, '=', 1);
    v_val := split_part(v_part, '=', 2);
    if v_key = any (v_seen) then
      raise exception 'invalid repeat rule: duplicate %', v_key using errcode = '22023';
    end if;
    v_seen := v_seen || v_key;
    case v_key
      when 'FREQ' then
        if v_val not in ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY') then
          raise exception 'invalid repeat rule: FREQ' using errcode = '22023';
        end if;
        v_out.freq := v_val;
      when 'INTERVAL' then
        if v_val !~ '^\d{1,3}$' or v_val::integer not between 1 and 366 then
          raise exception 'invalid repeat rule: INTERVAL' using errcode = '22023';
        end if;
        v_out.step := v_val::integer;
      when 'BYDAY' then
        v_out.by_day := '{}';
        foreach v_day in array string_to_array(v_val, ',') loop
          v_idx := array_position(v_days, v_day);
          if v_idx is null or (v_idx - 1) = any (v_out.by_day) then
            raise exception 'invalid repeat rule: BYDAY' using errcode = '22023';
          end if;
          v_out.by_day := v_out.by_day || (v_idx - 1);
        end loop;
        v_out.by_day := array(select unnest(v_out.by_day) order by 1);
      when 'UNTIL' then
        if v_val !~ '^\d{8}T\d{6}Z$' then
          raise exception 'invalid repeat rule: UNTIL' using errcode = '22023';
        end if;
        begin
          v_out.until := to_timestamp(v_val, 'YYYYMMDD"T"HH24MISS"Z"')::timestamp at time zone 'UTC';
          if to_char(v_out.until at time zone 'UTC', 'YYYYMMDD"T"HH24MISS"Z"') <> v_val then
            raise exception 'bad date';
          end if;
        exception when others then
          raise exception 'invalid repeat rule: UNTIL date' using errcode = '22023';
        end;
      else
        raise exception 'invalid repeat rule: unsupported %', v_key using errcode = '22023';
    end case;
  end loop;
  if v_out.freq is null then
    raise exception 'invalid repeat rule: FREQ required' using errcode = '22023';
  end if;
  if v_out.by_day is not null and v_out.freq <> 'WEEKLY' then
    raise exception 'invalid repeat rule: BYDAY needs WEEKLY' using errcode = '22023';
  end if;
  return v_out;
end;
$$;

create function public.is_valid_repeat_rule(p_rule text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  perform private.parse_repeat_rule(p_rule);
  return true;
exception when sqlstate '22023' then
  return false;
end;
$$;

/**
 * First occurrence strictly after p_after, or null when the series has ended. Computed from the
 * series anchor in local wall-clock time (DST-safe, month-end clamping without drift); missed
 * occurrences are skipped.
 */
create function public.next_occurrence(
  p_rule text,
  p_anchor timestamptz,
  p_after timestamptz,
  p_tz text default 'Asia/Hebron'
)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  r private.repeat_rule := private.parse_repeat_rule(p_rule);
  v_start timestamp := p_anchor at time zone p_tz;
  v_after_local timestamp := p_after at time zone p_tz;
  v_unit interval;
  v_k bigint;
  v_cand timestamptz;
  v_week_start timestamp;
  v_w bigint;
  v_day integer;
  v_local timestamp;
  v_guard integer := 0;
begin
  if r.freq = 'WEEKLY' then
    v_week_start := date_trunc('week', v_start);
    v_w := greatest(0, floor(extract(epoch from (v_after_local - v_week_start)) / 604800)::bigint);
    v_w := greatest(0, (v_w / r.step) - 1) * r.step;
    loop
      foreach v_day in array coalesce(r.by_day, array[(extract(isodow from v_start)::integer - 1)]) loop
        v_local := v_week_start + make_interval(weeks => v_w::integer, days => v_day) + v_start::time;
        continue when v_local < v_start;
        v_cand := v_local at time zone p_tz;
        if v_cand > p_after then
          return case when r.until is not null and v_cand > r.until then null else v_cand end;
        end if;
      end loop;
      v_w := v_w + r.step;
      v_guard := v_guard + 1;
      if v_guard > 10000 then raise exception 'next occurrence not found'; end if;
    end loop;
  end if;

  if p_anchor > p_after then
    return case when r.until is not null and p_anchor > r.until then null else p_anchor end;
  end if;
  v_unit := case r.freq when 'DAILY' then interval '1 day' when 'MONTHLY' then interval '1 month' else interval '1 year' end;
  v_k := case r.freq
    when 'DAILY' then floor(extract(epoch from (v_after_local - v_start)) / 86400)::bigint
    when 'MONTHLY' then (extract(year from v_after_local) - extract(year from v_start))::bigint * 12
      + (extract(month from v_after_local) - extract(month from v_start))::bigint
    else (extract(year from v_after_local) - extract(year from v_start))::bigint
  end;
  v_k := greatest(0, v_k / r.step - 1);
  loop
    v_cand := (v_start + v_unit * (v_k * r.step)) at time zone p_tz;
    if v_cand > p_after then
      return case when r.until is not null and v_cand > r.until then null else v_cand end;
    end if;
    v_k := v_k + 1;
    v_guard := v_guard + 1;
    if v_guard > 10000 then raise exception 'next occurrence not found'; end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 500),
  notes text check (notes is null or char_length(notes) <= 4000),
  remind_at timestamptz not null,
  status public.reminder_status not null default 'pending',
  repeat_rule text check (repeat_rule is null or public.is_valid_repeat_rule(repeat_rule)),
  repeat_anchor timestamptz,
  snooze_until timestamptz,
  fired_at timestamptz,
  acknowledged_at timestamptz,
  deleted_at timestamptz,
  source text not null default 'telegram' check (source in ('telegram', 'desktop', 'dashboard', 'api')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reminders_snooze_consistent check ((status = 'snoozed') = (snooze_until is not null))
);

comment on table public.reminders is 'One row per reminder series. Soft-deleted via deleted_at so Realtime (RLS-filtered UPDATE) can tell devices to retract.';

-- Due scans (scheduler) and per-user listing.
create index reminders_pending_due_idx on public.reminders (remind_at) where status = 'pending' and deleted_at is null;
create index reminders_snoozed_due_idx on public.reminders (snooze_until) where status = 'snoozed' and deleted_at is null;
create index reminders_fired_repeat_idx on public.reminders (remind_at) where status = 'fired' and repeat_rule is not null and deleted_at is null;
create index reminders_user_status_remind_at_idx on public.reminders (user_id, status, remind_at);
create index reminders_deleted_at_idx on public.reminders (deleted_at) where deleted_at is not null;

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id uuid not null unique,
  name text not null check (char_length(name) between 1 and 80),
  kind text not null check (kind in ('desktop', 'web')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
comment on table public.devices is 'Each signed-in install is bound to its own Auth session. Revoking a device kills that session immediately (RLS checks it on every request).';
create index devices_user_id_idx on public.devices (user_id);

-- Telegram chats allowed to act on behalf of a user (also the DB-side allowlist for the bot).
create table private.telegram_links (
  chat_id bigint primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index telegram_links_user_id_idx on private.telegram_links (user_id);

-- ---------------------------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------------------------
create function private.reminders_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.title := btrim(new.title);
  if new.repeat_rule is null then
    new.repeat_anchor := null;
  elsif new.repeat_anchor is null
     or (tg_op = 'UPDATE' and old.repeat_rule is distinct from new.repeat_rule) then
    new.repeat_anchor := new.remind_at;
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    if (select count(*) from public.reminders
        where user_id = new.user_id and status <> 'done' and deleted_at is null) >= 1000 then
      raise exception 'too many open reminders' using errcode = '54000';
    end if;
  end if;
  return new;
end;
$$;

create trigger reminders_before_write
before insert or update on public.reminders
for each row execute function private.reminders_before_write();

-- ---------------------------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------------------------
alter publication supabase_realtime add table public.reminders;
