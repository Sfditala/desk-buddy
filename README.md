# Desk Buddy

A desktop pet that walks along the bottom of your screen and reminds you of what you planned.
You create reminders by chatting (Arabic or English) with an AI agent on Telegram; they are stored
in Supabase and reach the desktop in real time.

```
Telegram ──► n8n agent (Gemini, 5 tools) ──► Supabase (Postgres + RLS + Realtime)
                                                 │  Realtime (≈0.3 s) + 30 s polling fallback
n8n scheduler (every minute, backup ping) ◄──────┤
                                                 ▼
                                   Desk Buddy (Electron, Windows)
                                   character stops, hops, speech bubble: Done / Snooze 10 min
```

## Repository layout

| Path                            | What                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `apps/desktop`                  | Electron + TypeScript + Vite app (main / sandboxed preload / renderer)                  |
| `packages/core`                 | Shared, tested domain logic: reminder schema, due/dedupe planning, snooze, repeat rules |
| `supabase/migrations`           | Versioned SQL migrations (schema, RLS, RPCs)                                            |
| `supabase/tests`                | DB integration tests: RLS matrix, scheduler, SQL↔TS parity, Realtime                    |
| `n8n/`                          | Workflow SDK sources for the n8n Cloud workflows (no secrets)                           |
| `assets/source`, `tools/assets` | Original character art and the script that slices it into sprites                       |
| `docs/`                         | Security checklist, signing/release guide                                               |
| `RUNBOOK.md`                    | Operations: rotate keys, revoke a device, restore a backup, roll back a release         |

## Prerequisites

- Node.js 22 (`.nvmrc`), npm 10
- Docker (for the local Supabase staging stack)
- Python 3 + `numpy pillow scipy` only if you change the character art

## Setup

```bash
npm ci
```

```bash
npm run db:start
```

```bash
cp apps/desktop/.env.example apps/desktop/.env.development
```

Fill `apps/desktop/.env.development` with the **local** values printed by `npx supabase status`
(`API_URL` and `PUBLISHABLE_KEY`). Both are public by design; the app refuses to start with a
secret/service-role key.

## Environment variables

| Variable                                                                                      | Where                                              | Secret?        | Purpose                                                          |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------- | ---------------------------------------------------------------- |
| `MAIN_VITE_SUPABASE_URL`                                                                      | desktop build (`.env.*`, CI `vars.SUPABASE_URL`)   | no             | Supabase project URL                                             |
| `MAIN_VITE_SUPABASE_PUBLISHABLE_KEY`                                                          | desktop build (CI `vars.SUPABASE_PUBLISHABLE_KEY`) | no (RLS-bound) | Supabase publishable key                                         |
| `RELEASES_OWNER`                                                                              | electron-builder                                   | no             | GitHub owner of the public `desk-buddy-releases` repo            |
| `RELEASES_TOKEN`                                                                              | GitHub secret                                      | **yes**        | Fine-grained PAT, `contents:write` on `desk-buddy-releases` only |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`                                 | GitHub secret (environment `production`)           | **yes**        | Azure Trusted Signing service principal                          |
| `WIN_PUBLISHER_NAME`, `AZURE_SIGNING_ENDPOINT`, `AZURE_CERT_PROFILE`, `AZURE_SIGNING_ACCOUNT` | GitHub variables                                   | no             | Signing account coordinates                                      |

The Supabase **service_role** key exists only in n8n's credential store
(`Desk Buddy Supabase (prod, service role)`). It is never in this repo, the desktop app or CI.

## Run

```bash
npm run dev
```

Dev mode shows a hardcoded test reminder after a few seconds. The tray menu has **Show test
reminder**, Pause, Mute, Character (Me / Robo), Launch at login, Sign in/out and updates.

## Test

```bash
npm run lint && npm run typecheck && npm test
```

```bash
npm run test:db
```

```bash
cd apps/desktop && npm run build && xvfb-run -a node e2e/smoke.mjs
```

The full end-to-end flow (email-code sign-in → bot RPC → Realtime → alert → Done/Snooze → device
revocation) runs against the local stack; see the header of `apps/desktop/e2e/sync.mjs`.

## Build the Windows installer

```bash
cd apps/desktop && npm run dist:win
```

Unsigned locally (`apps/desktop/release/<version>/DeskBuddy-Setup-<version>.exe`). Signed releases
are built by GitHub Actions on a `vX.Y.Z` tag; see [docs/SIGNING.md](docs/SIGNING.md).

## Database migrations

Create a migration in `supabase/migrations/`, run `npm run db:reset` and `npm run test:db`
locally, then apply it to production (after review) and run the Supabase advisors. Production was
migrated with the same files, in order.

## Character art

Single images are animated procedurally (bob, squash & stretch, flip, blink). To use frame
animation, put a horizontal sprite sheet in `apps/desktop/src/renderer/characters/<id>/` and set
`"frames"` / `"fps"` for that state in `manifest.json`. Re-slice the source art with
`npm run assets`.
