-- Desk Buddy: RLS, device sessions and RPCs.
--
-- Roles:
--   anon           nothing at all.
--   authenticated  own rows only, and only from a registered, non-revoked device session.
--   service_role   (n8n only) bot_* and scheduler functions. Bypasses RLS, so those functions
--                  re-check ownership through private.telegram_links themselves.

-- ---------------------------------------------------------------------------------------------
-- Session gate
-- ---------------------------------------------------------------------------------------------
create function private.current_session_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif((select auth.jwt()) ->> 'session_id', '')::uuid
$$;

/** True when the caller's Auth session belongs to an active (non-revoked) device. */
create function private.session_is_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.devices d
    where d.session_id = private.current_session_id()
      and d.user_id = (select auth.uid())
      and d.revoked_at is null
  )
$$;

grant usage on schema private to authenticated;
grant execute on function private.current_session_id() to authenticated;
grant execute on function private.session_is_active() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Table privileges + RLS (default deny: no policy = no access)
-- ---------------------------------------------------------------------------------------------
alter table public.reminders enable row level security;
alter table public.reminders force row level security;
alter table public.devices enable row level security;
alter table public.devices force row level security;
alter table private.telegram_links enable row level security;
alter table private.telegram_links force row level security;

revoke all on public.reminders, public.devices from anon, authenticated;
revoke all on private.telegram_links from anon, authenticated;
grant select, insert, update on public.reminders to authenticated;
grant select on public.devices to authenticated;

create policy reminders_select_own on public.reminders
  for select to authenticated
  using (user_id = (select auth.uid()) and (select private.session_is_active()));

create policy reminders_insert_own on public.reminders
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (select private.session_is_active())
    and source in ('desktop', 'dashboard')
    and deleted_at is null
  );

create policy reminders_update_own on public.reminders
  for update to authenticated
  using (user_id = (select auth.uid()) and (select private.session_is_active()))
  with check (user_id = (select auth.uid()) and (select private.session_is_active()));

-- No DELETE policy: clients soft-delete (deleted_at); hard deletes are a service-side purge.

create policy devices_select_own on public.devices
  for select to authenticated
  using (user_id = (select auth.uid()) and (select private.session_is_active()));

-- telegram_links: no policies, service_role only.

-- ---------------------------------------------------------------------------------------------
-- Device RPCs (authenticated)
-- ---------------------------------------------------------------------------------------------
/**
 * Bind the caller's current Auth session to a device. Idempotent for the same session. A revoked
 * session can never re-register; signing in again creates a new session (and needs the OTP).
 */
create function public.register_device(p_name text, p_kind text default 'desktop')
returns public.devices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_sid uuid := private.current_session_id();
  v_row public.devices;
begin
  if v_uid is null or v_sid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.sessions s where s.id = v_sid and s.user_id = v_uid) then
    raise exception 'session not found' using errcode = '42501';
  end if;
  if p_kind not in ('desktop', 'web') or char_length(btrim(coalesce(p_name, ''))) not between 1 and 80 then
    raise exception 'invalid device' using errcode = '22023';
  end if;

  select * into v_row from public.devices where session_id = v_sid;
  if found then
    if v_row.revoked_at is not null or v_row.user_id <> v_uid then
      raise exception 'device revoked' using errcode = '42501';
    end if;
    update public.devices set last_seen_at = now() where id = v_row.id returning * into v_row;
    return v_row;
  end if;

  if (select count(*) from public.devices where user_id = v_uid and revoked_at is null) >= 20 then
    raise exception 'too many devices' using errcode = '54000';
  end if;
  insert into public.devices (user_id, session_id, name, kind)
  values (v_uid, v_sid, btrim(p_name), p_kind)
  returning * into v_row;
  return v_row;
end;
$$;

/** Revoke a device: blocks it in RLS immediately and deletes its Auth session (refresh token). */
create function public.revoke_device(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sid uuid;
begin
  if not private.session_is_active() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  update public.devices
     set revoked_at = coalesce(revoked_at, now())
   where id = p_device_id and user_id = (select auth.uid())
  returning session_id into v_sid;
  if v_sid is null then
    raise exception 'device not found' using errcode = 'P0002';
  end if;
  delete from auth.sessions where id = v_sid;
end;
$$;

/** Heartbeat so the dashboard can show when each device was last online. */
create function public.touch_device()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.devices set last_seen_at = now()
   where session_id = private.current_session_id()
     and user_id = (select auth.uid())
     and revoked_at is null
$$;

-- ---------------------------------------------------------------------------------------------
-- Reminder RPCs shared by bot and clients
-- ---------------------------------------------------------------------------------------------
create function private.due_at(r public.reminders)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case when r.status = 'snoozed' then r.snooze_until else r.remind_at end
$$;

/**
 * Done / Snooze. p_occurrence is the due time the client was showing: if the row has moved on
 * (another device or Telegram already handled it) the call is a no-op, which makes offline
 * retries idempotent.
 */
create function private.apply_ack(
  p_user uuid,
  p_id uuid,
  p_action text,
  p_occurrence timestamptz,
  p_minutes integer
)
returns public.reminders
language plpgsql
set search_path = ''
as $$
declare
  r public.reminders;
  v_next timestamptz;
begin
  if p_action not in ('done', 'snooze') then
    raise exception 'invalid action' using errcode = '22023';
  end if;
  if p_minutes is null or p_minutes not between 1 and 1440 then
    raise exception 'invalid snooze minutes' using errcode = '22023';
  end if;
  select * into r from public.reminders
   where id = p_id and user_id = p_user and deleted_at is null
   for update;
  if not found then
    raise exception 'reminder not found' using errcode = 'P0002';
  end if;
  if r.status = 'done' or (p_occurrence is not null and private.due_at(r) <> p_occurrence) then
    return r;
  end if;

  if p_action = 'snooze' then
    update public.reminders
       set status = 'snoozed', snooze_until = now() + make_interval(mins => p_minutes)
     where id = r.id returning * into r;
    return r;
  end if;

  if r.repeat_rule is not null then
    v_next := public.next_occurrence(r.repeat_rule, coalesce(r.repeat_anchor, r.remind_at), greatest(now(), r.remind_at));
  end if;
  if v_next is not null then
    update public.reminders
       set status = 'pending', remind_at = v_next, snooze_until = null, fired_at = null, acknowledged_at = now()
     where id = r.id returning * into r;
  else
    update public.reminders
       set status = 'done', snooze_until = null, acknowledged_at = now()
     where id = r.id returning * into r;
  end if;
  return r;
end;
$$;

/** Client (desktop/dashboard) Done/Snooze. Runs as the caller, so RLS applies. */
create function public.ack_reminder(
  p_id uuid,
  p_action text,
  p_occurrence timestamptz default null,
  p_minutes integer default 10
)
returns public.reminders
language plpgsql
set search_path = ''
as $$
begin
  if not private.session_is_active() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  return private.apply_ack((select auth.uid()), p_id, p_action, p_occurrence, p_minutes);
end;
$$;

grant execute on function private.due_at(public.reminders) to authenticated;
grant execute on function private.apply_ack(uuid, uuid, text, timestamptz, integer) to authenticated;
grant execute on function public.register_device(text, text) to authenticated;
grant execute on function public.revoke_device(uuid) to authenticated;
grant execute on function public.touch_device() to authenticated;
grant execute on function public.ack_reminder(uuid, text, timestamptz, integer) to authenticated;
grant execute on function public.next_occurrence(text, timestamptz, timestamptz, text) to authenticated, service_role;
grant execute on function public.is_valid_repeat_rule(text) to authenticated, service_role;
-- The CHECK constraint and trigger need these under whichever role writes.
grant execute on function private.parse_repeat_rule(text) to authenticated, service_role;
grant execute on function private.reminders_before_write() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Bot RPCs (service_role only; called by n8n tools). Every call is scoped by Telegram chat id.
-- ---------------------------------------------------------------------------------------------
create function private.user_for_chat(p_chat_id bigint)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  select user_id into v_uid from private.telegram_links where chat_id = p_chat_id;
  if v_uid is null then
    raise exception 'chat not allowed' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

create function private.check_remind_at(p_at timestamptz)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_at is null or p_at < now() - interval '2 minutes' or p_at > now() + interval '5 years' then
    raise exception 'remind_at must be in the future (and within 5 years)' using errcode = '22023';
  end if;
end;
$$;

create function public.bot_create_reminder(
  p_chat_id bigint,
  p_title text,
  p_remind_at timestamptz,
  p_notes text default null,
  p_repeat_rule text default null
)
returns public.reminders
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.reminders;
begin
  perform private.check_remind_at(p_remind_at);
  insert into public.reminders (user_id, title, notes, remind_at, repeat_rule, source)
  values (private.user_for_chat(p_chat_id), p_title, nullif(btrim(p_notes), ''), p_remind_at,
          nullif(btrim(p_repeat_rule), ''), 'telegram')
  returning * into r;
  return r;
end;
$$;

create function public.bot_list_reminders(
  p_chat_id bigint,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_include_done boolean default false,
  p_limit integer default 20
)
returns setof public.reminders
language sql
stable
security definer
set search_path = ''
as $$
  select *
  from public.reminders r
  where r.user_id = private.user_for_chat(p_chat_id)
    and r.deleted_at is null
    and (p_include_done or r.status <> 'done')
    and (p_from is null or private.due_at(r) >= p_from)
    and (p_to is null or private.due_at(r) <= p_to)
  order by private.due_at(r)
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
$$;

create function public.bot_update_reminder(
  p_chat_id bigint,
  p_id uuid,
  p_title text default null,
  p_notes text default null,
  p_remind_at timestamptz default null,
  p_repeat_rule text default null,
  p_clear_repeat boolean default false
)
returns public.reminders
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.reminders;
begin
  if p_remind_at is not null then
    perform private.check_remind_at(p_remind_at);
  end if;
  update public.reminders
     set title = coalesce(p_title, title),
         notes = case when p_notes is null then notes else nullif(btrim(p_notes), '') end,
         remind_at = coalesce(p_remind_at, remind_at),
         -- A new time restarts the reminder (and its repeat series).
         status = case when p_remind_at is not null then 'pending'::public.reminder_status else status end,
         snooze_until = case when p_remind_at is not null then null else snooze_until end,
         fired_at = case when p_remind_at is not null then null else fired_at end,
         repeat_anchor = case when p_remind_at is not null then p_remind_at else repeat_anchor end,
         repeat_rule = case when p_clear_repeat then null else coalesce(nullif(btrim(p_repeat_rule), ''), repeat_rule) end
   where id = p_id and user_id = private.user_for_chat(p_chat_id) and deleted_at is null
  returning * into r;
  if not found then
    raise exception 'reminder not found' using errcode = 'P0002';
  end if;
  return r;
end;
$$;

create function public.bot_delete_reminder(p_chat_id bigint, p_id uuid)
returns public.reminders
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.reminders;
begin
  update public.reminders set deleted_at = now()
   where id = p_id and user_id = private.user_for_chat(p_chat_id) and deleted_at is null
  returning * into r;
  if not found then
    raise exception 'reminder not found' using errcode = 'P0002';
  end if;
  return r;
end;
$$;

create function public.bot_snooze_reminder(p_chat_id bigint, p_id uuid, p_minutes integer default 10)
returns public.reminders
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.reminders;
begin
  update public.reminders
     set status = 'snoozed', snooze_until = now() + make_interval(mins => p_minutes)
   where id = p_id and user_id = private.user_for_chat(p_chat_id) and deleted_at is null
     and status <> 'done' and p_minutes between 1 and 1440
  returning * into r;
  if not found then
    raise exception 'reminder not found, already done, or invalid minutes' using errcode = 'P0002';
  end if;
  return r;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Scheduler (service_role; n8n Workflow B every minute)
-- ---------------------------------------------------------------------------------------------
/**
 * Atomically: snoozed + due -> fired; pending + due -> fired; and for repeating reminders that
 * were never acknowledged, roll forward to the latest occurrence <= now (missed ones are skipped)
 * and fire again. Returns what fired, with the owner's Telegram chat for a backup notification.
 * FOR UPDATE SKIP LOCKED makes concurrent runs safe (no double fire).
 */
create function public.fire_due_reminders()
returns table (id uuid, title text, notes text, due_at timestamptz, chat_id bigint, kind text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  r public.reminders;
  v_next timestamptz;
  v_latest timestamptz;
  v_guard integer;
begin
  for r in
    select * from public.reminders x
     where x.deleted_at is null
       and ((x.status = 'pending' and x.remind_at <= now())
         or (x.status = 'snoozed' and x.snooze_until <= now())
         or (x.status = 'fired' and x.repeat_rule is not null and x.remind_at <= now()))
     order by private.due_at(x)
     for update skip locked
     limit 500
  loop
    if r.status = 'fired' then
      v_latest := null;
      v_next := public.next_occurrence(r.repeat_rule, coalesce(r.repeat_anchor, r.remind_at), r.remind_at);
      v_guard := 0;
      while v_next is not null and v_next <= now() and v_guard < 1000 loop
        v_latest := v_next;
        v_next := public.next_occurrence(r.repeat_rule, coalesce(r.repeat_anchor, r.remind_at), v_next);
        v_guard := v_guard + 1;
      end loop;
      continue when v_latest is null;
      update public.reminders set remind_at = v_latest, fired_at = now() where reminders.id = r.id returning * into r;
      kind := 'repeat';
    else
      kind := case r.status when 'snoozed' then 'snooze' else 'due' end;
      update public.reminders
         set status = 'fired', fired_at = now(), snooze_until = null
       where reminders.id = r.id
      returning * into r;
    end if;
    id := r.id;
    title := r.title;
    notes := r.notes;
    due_at := r.remind_at;
    select t.chat_id into chat_id from private.telegram_links t where t.user_id = r.user_id order by t.created_at limit 1;
    return next;
  end loop;
end;
$$;

/** Hard-delete soft-deleted rows after 30 days (service_role; scheduled daily). */
create function public.purge_deleted_reminders()
returns integer
language sql
security definer
set search_path = ''
as $$
  with d as (delete from public.reminders where deleted_at < now() - interval '30 days' returning 1)
  select count(*)::integer from d
$$;

revoke execute on function public.bot_create_reminder(bigint, text, timestamptz, text, text) from public, anon, authenticated;
revoke execute on function public.bot_list_reminders(bigint, timestamptz, timestamptz, boolean, integer) from public, anon, authenticated;
revoke execute on function public.bot_update_reminder(bigint, uuid, text, text, timestamptz, text, boolean) from public, anon, authenticated;
revoke execute on function public.bot_delete_reminder(bigint, uuid) from public, anon, authenticated;
revoke execute on function public.bot_snooze_reminder(bigint, uuid, integer) from public, anon, authenticated;
revoke execute on function public.fire_due_reminders() from public, anon, authenticated;
revoke execute on function public.purge_deleted_reminders() from public, anon, authenticated;

grant execute on function public.bot_create_reminder(bigint, text, timestamptz, text, text) to service_role;
grant execute on function public.bot_list_reminders(bigint, timestamptz, timestamptz, boolean, integer) to service_role;
grant execute on function public.bot_update_reminder(bigint, uuid, text, text, timestamptz, text, boolean) to service_role;
grant execute on function public.bot_delete_reminder(bigint, uuid) to service_role;
grant execute on function public.bot_snooze_reminder(bigint, uuid, integer) to service_role;
grant execute on function public.fire_due_reminders() to service_role;
grant execute on function public.purge_deleted_reminders() to service_role;
grant usage on schema private to service_role;
grant select on private.telegram_links to service_role;
grant execute on all functions in schema private to service_role;
