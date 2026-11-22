-- Production first received a scalar-returning bot_login_email; recreate it returning a row so the
-- n8n HTTP node gets a plain {email} item. Idempotent for fresh databases.
drop function if exists public.bot_login_email(bigint);

create function public.bot_login_email(p_chat_id bigint)
returns table (email text)
language sql
stable
security definer
set search_path = ''
as $$
  select u.email::text
  from auth.users u
  where u.id = private.user_for_chat(p_chat_id)
$$;

revoke execute on function public.bot_login_email(bigint) from public, anon, authenticated;
grant execute on function public.bot_login_email(bigint) to service_role;
