-- Sign-in via Telegram: the bot (service_role, owner chat only) asks for the linked account's
-- email so it can mint a one-time magic link with the Auth admin API. No email is sent, which
-- avoids the default SMTP limits entirely. Returns a row so n8n gets a plain {email} item.
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
