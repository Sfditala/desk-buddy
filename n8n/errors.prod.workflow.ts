import { workflow, trigger, node, sticky, newCredential, expr } from '@n8n/workflow-sdk';

const onError = trigger({
  type: 'n8n-nodes-base.errorTrigger',
  version: 1,
  config: {
    name: 'On Workflow Error',
    output: [{ execution: { id: '231', url: 'https://example.app.n8n.cloud/workflow/1/executions/231', error: { message: 'Request failed with status code 503', stack: '' }, lastNodeExecuted: 'Fire Due Reminders', mode: 'trigger' }, workflow: { id: '1', name: 'Desk Buddy · Scheduler (prod)' } }]
  }
});

const alertOwner = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Alert Owner on Telegram',
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: '1823421355',
      text: expr('⚠️ Desk Buddy workflow failed\n\nWorkflow: {{ $json.workflow?.name ?? "unknown" }}\nNode: {{ $json.execution?.lastNodeExecuted ?? $json.trigger?.error?.node?.name ?? "n/a" }}\nError: {{ String($json.execution?.error?.message ?? $json.trigger?.error?.message ?? "unknown").slice(0, 300).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") }}\nMode: {{ $json.execution?.mode ?? "n/a" }}\nExecution: {{ $json.execution?.url ?? "n/a" }}'),
      additionalFields: { appendAttribution: false, disable_web_page_preview: true, parse_mode: 'HTML' }
    },
    credentials: { telegramApi: newCredential('Desk Buddy Telegram (prod)') },
    output: [{ ok: true, result: { message_id: 1 } }]
  }
});

const note = sticky('## Error alerts\nSet this workflow as the **Error Workflow** of every Desk Buddy workflow (Settings → Error workflow).\nIt sends the workflow name, failing node, a truncated error message and the execution link. It never includes credentials or reminder contents.', [onError, alertOwner], { color: 3 });

export default workflow('desk-buddy-errors-prod', 'Desk Buddy · Error alerts (prod)')
  .add(onError)
  .to(alertOwner)
  .add(note);
