-- Advisor fixes (security):
-- 0028 anon could EXECUTE SECURITY DEFINER functions: hosted Supabase grants EXECUTE on new
--      public functions to anon/authenticated by default, which `alter default privileges` in the
--      first migration does not override. Revoke explicitly, everywhere.
-- 0029 authenticated-callable SECURITY DEFINER in the exposed schema: the privileged bodies move
--      to the non-exposed `private` schema; `public` keeps thin SECURITY INVOKER wrappers.
-- 0008 telegram_links had RLS with no policy (intentionally service-only): make it explicit.

-- 1. Device functions: definer bodies in private, invoker wrappers in public.
alter function public.register_device(text, text) set schema private;
alter function public.revoke_device(uuid) set schema private;
drop function public.touch_device(); -- unused: register_device already bumps last_seen_at

create function public.register_device(p_name text, p_kind text default 'desktop')
returns public.devices
language sql
security invoker
set search_path = ''
as $$
  select * from private.register_device(p_name, p_kind)
$$;

create function public.revoke_device(p_device_id uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.revoke_device(p_device_id)
$$;

-- 2. Lock down EXECUTE: nothing for public/anon; only what each role needs.
revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

grant execute on function public.register_device(text, text) to authenticated;
grant execute on function public.revoke_device(uuid) to authenticated;
grant execute on function public.ack_reminder(uuid, text, timestamptz, integer) to authenticated;
grant execute on function public.next_occurrence(text, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.is_valid_repeat_rule(text) to authenticated;

grant execute on function private.register_device(text, text) to authenticated;
grant execute on function private.revoke_device(uuid) to authenticated;
grant execute on function private.current_session_id() to authenticated;
grant execute on function private.session_is_active() to authenticated;
grant execute on function private.due_at(public.reminders) to authenticated;
grant execute on function private.apply_ack(uuid, uuid, text, timestamptz, integer) to authenticated;
grant execute on function private.parse_repeat_rule(text) to authenticated;
grant execute on function private.reminders_before_write() to authenticated;

grant execute on all functions in schema public to service_role;
grant execute on all functions in schema private to service_role;

-- Future functions: no implicit EXECUTE for anyone but the owner and service_role.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema private revoke execute on functions from public, anon, authenticated;

-- 3. Explicit deny for clients on the Telegram allowlist (service_role bypasses RLS).
create policy telegram_links_no_client_access on private.telegram_links
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);
