import { workflow, trigger, node, sticky, newCredential, expr } from '@n8n/workflow-sdk';

const everyMinute = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: {
    name: 'Every Minute',
    parameters: {
      rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] },
      misfirePolicy: 'coalesce',
    },
  },
});

const fireDue = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fire Due Reminders',
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
    parameters: {
      method: 'POST',
      url: 'https://tmtwdxlmrkjihyoyywuj.supabase.co/rest/v1/rpc/fire_due_reminders',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'supabaseApi',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: '{}',
      options: { timeout: 10000 },
    },
    credentials: { supabaseApi: newCredential('Desk Buddy Supabase (prod, service role)') },
    output: [
      {
        id: '0a1b2c3d-0000-4000-8000-000000000001',
        title: 'اتصل بأحمد',
        notes: null,
        due_at: '2026-11-22T07:00:00+00:00',
        chat_id: 123456789,
        kind: 'due',
      },
    ],
  },
});

const onlyFired = node({
  type: 'n8n-nodes-base.filter',
  version: 2.4,
  config: {
    name: 'Only Fired Reminders',
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            leftValue: expr('{{ $json.id }}'),
            rightValue: '',
            operator: { type: 'string', operation: 'exists' },
          },
          {
            leftValue: expr('{{ $json.chat_id }}'),
            rightValue: '',
            operator: { type: 'number', operation: 'exists' },
          },
        ],
      },
      looseTypeValidation: true,
    },
    output: [
      {
        id: '0a1b2c3d-0000-4000-8000-000000000001',
        title: 'اتصل بأحمد',
        notes: null,
        due_at: '2026-11-22T07:00:00+00:00',
        chat_id: 123456789,
        kind: 'due',
      },
    ],
  },
});

const notifyPhone = node({
  type: 'n8n-nodes-base.telegram',
  version: 1.2,
  config: {
    name: 'Send Backup Reminder to Phone',
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
    onError: 'continueRegularOutput',
    parameters: {
      resource: 'message',
      operation: 'sendMessage',
      chatId: expr('{{ $json.chat_id }}'),
      text: expr(
        '⏰ {{ $json.title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") }}{{ $json.notes ? "\n\n" + $json.notes.slice(0, 500).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : "" }}{{ $json.kind === "snooze" ? "\n(snoozed reminder)" : "" }}',
      ),
      additionalFields: {
        appendAttribution: false,
        disable_web_page_preview: true,
        parse_mode: 'HTML',
      },
    },
    credentials: { telegramApi: newCredential('Desk Buddy Telegram (prod)') },
    output: [{ ok: true, result: { message_id: 2 } }],
  },
});

const dailyCleanup = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: {
    name: 'Daily 03:17 Cleanup',
    parameters: {
      rule: {
        interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 3, triggerAtMinute: 17 }],
      },
    },
  },
});

const purge = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Purge Deleted Reminders',
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
    parameters: {
      method: 'POST',
      url: 'https://tmtwdxlmrkjihyoyywuj.supabase.co/rest/v1/rpc/purge_deleted_reminders',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'supabaseApi',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: '{}',
      options: { timeout: 30000 },
    },
    credentials: { supabaseApi: newCredential('Desk Buddy Supabase (prod, service role)') },
    output: [{ data: 0 }],
  },
});

const note = sticky(
  '## Scheduler\n**Every minute:** `fire_due_reminders()` atomically marks due/snoozed reminders as fired and rolls unacknowledged repeats forward (SKIP LOCKED, so overlapping runs never double-fire). The desktop app fires on its own timer; the Telegram message is a backup for when the computer is off.\n**Daily:** hard-deletes reminders soft-deleted more than 30 days ago.',
  [everyMinute, fireDue, onlyFired, notifyPhone],
  { color: 5 },
);

export default workflow('desk-buddy-scheduler-prod', 'Desk Buddy · Scheduler (prod)', {
  settings: {
    errorWorkflow: 'lePTsXqTDh5xnVF0',
    timezone: 'Asia/Hebron',
    executionTimeout: 120,
    saveDataSuccessExecution: 'none',
    saveDataErrorExecution: 'all',
    saveManualExecutions: true,
    callerPolicy: 'workflowsFromSameOwner',
  },
})
  .add(everyMinute)
  .to(fireDue)
  .to(onlyFired)
  .to(notifyPhone)
  .add(dailyCleanup)
  .to(purge)
  .add(note);
