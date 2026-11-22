# Desk Buddy runbook

Production: Supabase project `desk-buddy` (`tmtwdxlmrkjihyoyywuj`, eu-central-1), n8n Cloud
folder **Desk Buddy / Production**, releases in `<owner>/desk-buddy-releases`.

## 1. Rotate keys

| Key                                | Where it lives                                                 | How to rotate                                                                                                                                                                                                         |
| ---------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase service_role / secret key | n8n credential `Desk Buddy Supabase (prod, service role)` only | Supabase → Project Settings → API Keys: create a new **secret** key (or roll the legacy JWT secret if using legacy keys). Paste it into the n8n credential, run the Scheduler manually once, then revoke the old key. |
| Supabase publishable key           | Desktop builds (public)                                        | Create a new publishable key, update GitHub variable `SUPABASE_PUBLISHABLE_KEY`, ship a release, wait for clients to update, then disable the old key.                                                                |
| Telegram bot token                 | n8n credentials `Desk Buddy Telegram (prod/staging)`           | @BotFather → `/revoke` → choose the bot → paste the new token into the n8n credential → deactivate and re-activate the Agent workflow (re-registers the webhook with a new secret).                                   |
| Gemini API key                     | n8n credential `Desk Buddy Gemini`                             | Google AI Studio → create key → update credential → delete the old key.                                                                                                                                               |
| Release token                      | GitHub secret `RELEASES_TOKEN`                                 | Create a new fine-grained PAT (contents:write on `desk-buddy-releases` only, ≤ 90 days), update the secret, delete the old PAT.                                                                                       |
| Azure signing secret               | GitHub environment `production` secrets                        | Azure → App registration → Certificates & secrets → new secret → update `AZURE_CLIENT_SECRET` → delete old.                                                                                                           |

After any rotation: send a Telegram reminder and confirm it reaches the desktop.

## 2. Revoke a device (lost / sold laptop)

From any other signed-in client (dashboard, or SQL as below). Revocation takes effect on the next
request: RLS rejects the session and its refresh token is deleted.

```sql
-- list devices
select id, name, kind, created_at, last_seen_at, revoked_at from public.devices order by last_seen_at desc;
```

```sql
-- revoke one device (also kills its Auth session)
with d as (
  update public.devices set revoked_at = now() where id = '<device-id>' returning session_id
)
delete from auth.sessions where id in (select session_id from d);
```

The app notices within 30 s, wipes its encrypted local cache and shows the sign-in window.
Emergency (all devices): `update public.devices set revoked_at = now() where revoked_at is null;`
then `delete from auth.sessions;`.

## 3. Backups and restore

- **Free plan (current):** Supabase takes daily logical backups but they are only restorable on
  paid plans, and **there is no point-in-time recovery (PITR)**. Mitigation: a weekly export.
  ```bash
  npx supabase db dump --db-url "$PROD_DB_URL" --data-only -s public -f backup-$(date +%F).sql
  ```
  Store the file encrypted (e.g. in a password manager attachment). `PROD_DB_URL` is the
  connection string from Project Settings → Database (never commit it).
- **Pro plan:** daily backups (7 days) restorable from Dashboard → Database → Backups; PITR is an
  add-on (Database → Backups → Point in time) with restore to any second in the retention window.
- **Restore from a dump** (into a fresh project or after confirming data loss):
  1. Apply all migrations in `supabase/migrations` in order.
  2. `psql "$DB_URL" -f backup-YYYY-MM-DD.sql`
  3. Re-insert the Telegram link if needed:
     `insert into private.telegram_links (chat_id, user_id) values (<chat-id>, '<user-uuid>');`
  4. Run the Supabase advisors and `npm run test:db` against a local copy first.

## 4. Roll back a desktop release

electron-updater never downgrades automatically (`allowDowngrade: false`).

1. In `desk-buddy-releases`, mark the bad release as **draft** (clients stop seeing it).
2. Fix forward: bump the version (e.g. 0.3.1 → 0.3.2) with the fix or a revert on `main`, tag it,
   and let the Release workflow publish it. Clients update to the new version.
3. If a client must go back immediately: download the previous `DeskBuddy-Setup-x.y.z.exe` from
   the releases repo and install it over the current one (user data is kept).

## 5. Roll back the database

Migrations are forward-only. Write a new migration that reverses the change, test it locally with
`npm run db:reset && npm run test:db`, then apply it to production. For data loss see §3.

## 6. Roll back an n8n workflow

n8n → workflow → **Version history** → restore the previous version → re-publish. The source of
truth is `n8n/*.workflow.ts`; revert the file in git as well.

## 7. Monitoring

- **n8n:** failures in any Desk Buddy workflow trigger _Desk Buddy · Error alerts (prod)_, which
  messages the owner on Telegram with the workflow, node, error and execution link.
- **Supabase:** Dashboard → Logs (API, Postgres, Auth, Realtime) and Advisors (run after each
  migration).
- **Desktop:** `%APPDATA%\Desk Buddy\logs\main.log` (tray → Open logs folder). Logs contain ids and
  states only; reminder text, tokens and emails are never logged (and are redacted if a library
  error tries to).
- **Vercel** (dashboard, if deployed): Project → Logs / Observability.

## 8. Incident checklist

1. Contain: revoke affected devices (§2), rotate the exposed key (§1), deactivate the n8n Agent
   workflow if the bot is being abused.
2. Assess: Supabase Auth logs and API logs for unexpected sessions or service-role traffic.
3. Recover: restore data (§3) if needed.
4. Record what happened and what changed.
