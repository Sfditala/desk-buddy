-- The Telegram agent should never do time-zone math. bot_list_reminders now returns a compact
-- shape with the due time already formatted in Asia/Hebron (and only the fields the agent needs,
-- which also keeps tokens down).
drop function public.bot_list_reminders(bigint, timestamptz, timestamptz, boolean, integer);

create function public.bot_list_reminders(
  p_chat_id bigint,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_include_done boolean default false,
  p_limit integer default 20
)
returns table (
  id uuid,
  title text,
  notes text,
  due_local text,
  status public.reminder_status,
  repeat_rule text
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id,
         r.title,
         r.notes,
         to_char(private.due_at(r) at time zone 'Asia/Hebron', 'Dy YYYY-MM-DD HH24:MI'),
         r.status,
         r.repeat_rule
  from public.reminders r
  where r.user_id = private.user_for_chat(p_chat_id)
    and r.deleted_at is null
    and (p_include_done or r.status <> 'done')
    and (p_from is null or private.due_at(r) >= p_from)
    and (p_to is null or private.due_at(r) <= p_to)
  order by private.due_at(r)
  limit least(greatest(coalesce(p_limit, 20), 1), 50)
$$;

revoke execute on function public.bot_list_reminders(bigint, timestamptz, timestamptz, boolean, integer) from public, anon, authenticated;
grant execute on function public.bot_list_reminders(bigint, timestamptz, timestamptz, boolean, integer) to service_role;
