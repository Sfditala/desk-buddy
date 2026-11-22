# n8n workflows (source of truth)

Workflow SDK sources for the n8n Cloud workflows. They contain **no secrets**: every credential is a
named reference (`newCredential('…')`) that resolves to n8n's encrypted credential store.

| File | n8n workflow | Purpose |
| --- | --- | --- |
| `agent.prod.workflow.ts` | Desk Buddy · Telegram Agent (prod) | Telegram → Gemini agent with 5 reminder tools |
| `scheduler.prod.workflow.ts` | Desk Buddy · Scheduler (prod) | Every minute `fire_due_reminders()`, daily purge |
| `errors.prod.workflow.ts` | Desk Buddy · Error alerts (prod) | Error workflow → Telegram alert to the owner |

Required credentials (create in n8n → Credentials, names must match):

| Name | Type |
| --- | --- |
| `Desk Buddy Telegram (prod)` | Telegram API |
| `Desk Buddy Telegram (staging)` | Telegram API |
| `Desk Buddy Gemini` | Google Gemini (PaLM) API |
| `Desk Buddy Supabase (prod, service role)` | Supabase API (service_role key — only ever stored here) |

To change a workflow: edit the source here, validate and apply it with the n8n MCP tools
(`validate_workflow` → `update_workflow`), then commit. Keep the canvas groups when editing.
