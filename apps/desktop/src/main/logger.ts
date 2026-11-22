import log from 'electron-log/main';

/**
 * Local file logs (%APPDATA%/Desk Buddy/logs/main.log on Windows), rotated at 2 MB.
 * Policy: log ids, states and error codes only — never reminder text, tokens or emails.
 * The redaction below is a safety net for anything that slips through (e.g. library errors).
 */
const REDACTIONS: [RegExp, string][] = [
  [/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[jwt]'],
  [/\b(?:sb_(?:secret|publishable)_|sbp_)[\w-]{10,}/g, '[supabase-key]'],
  [
    /\b(Bearer|apikey|token|refresh_token|access_token|password)(["':=\s]+)[^\s"',}]+/gi,
    '$1$2[redacted]',
  ],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]'],
  [/([?&](?:token|apikey|access_token|key)=)[^&\s]+/gi, '$1[redacted]'],
];

export function redact(input: string): string {
  return REDACTIONS.reduce((s, [re, rep]) => s.replace(re, rep), input);
}

let initialised = false;

export function initLogger(): void {
  if (initialised) return;
  initialised = true;
  log.transports.file.level = process.env.DESK_BUDDY_DEBUG === '1' ? 'debug' : 'info';
  log.transports.file.maxSize = 2 * 1024 * 1024;
  log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : false;
  log.hooks.push((message) => ({
    ...message,
    data: message.data.map((d: unknown) =>
      typeof d === 'string'
        ? redact(d)
        : d instanceof Error
          ? redact(`${d.name}: ${d.message}\n${d.stack ?? ''}`)
          : redact(safeJson(d)),
    ),
  }));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserialisable]';
  }
}

export const logger = log.scope('main');
export const scoped = (name: string) => log.scope(name);
