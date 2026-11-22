import { app, net, protocol, session, shell, type WebContents } from 'electron';
import { extname, join, normalize, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scoped } from './logger';

const log = scoped('security');

export const APP_SCHEME = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://renderer`;

/** Renderer never talks to the network: Supabase lives in the main process. */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "media-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Only these hosts may be opened in the user's browser (e.g. from a future "Open dashboard"). */
const EXTERNAL_ALLOWLIST = new Set(['github.com', 't.me']);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
};

/** Must run before `app.ready`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } },
  ]);
}

/**
 * Serve the built renderer from `app://renderer/…` instead of `file://`, so the page has a real
 * origin for CSP 'self' and cannot read arbitrary files. Path traversal is rejected.
 */
export function serveRenderer(rendererDir: string): void {
  const root = normalize(rendererDir);
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'renderer' || request.method !== 'GET') {
      return new Response('forbidden', { status: 403 });
    }
    const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = normalize(join(root, pathname));
    const rel = relative(root, file);
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
      log.warn('blocked path traversal', { pathname: url.pathname });
      return new Response('forbidden', { status: 403 });
    }
    const type = MIME[extname(file).toLowerCase()];
    if (!type) return new Response('not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    if (!res.ok) return new Response('not found', { status: 404 });
    return new Response(res.body, {
      status: 200,
      headers: {
        'content-type': type,
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'cross-origin-opener-policy': 'same-origin',
      },
    });
  });
}

export function openExternalSafely(rawUrl: string): void {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'https:' && EXTERNAL_ALLOWLIST.has(url.hostname)) {
      void shell.openExternal(url.toString());
      return;
    }
  } catch {
    /* fallthrough */
  }
  log.warn('blocked external url', { host: safeHost(rawUrl) });
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return 'invalid';
  }
}

function isTrustedUrl(raw: string, devServer: string | undefined): boolean {
  if (raw.startsWith(`${APP_ORIGIN}/`)) return true;
  return !!devServer && !app.isPackaged && raw.startsWith(devServer);
}

function lockDownContents(contents: WebContents, devServer: string | undefined): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url, devServer)) {
      event.preventDefault();
      log.warn('blocked navigation', { host: safeHost(url) });
    }
  });
  contents.on('will-redirect', (event, url) => {
    if (!isTrustedUrl(url, devServer)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}

/** Process-wide hardening. Call once, after `app.ready`. */
export function hardenApp(devServer: string | undefined): void {
  const ses = session.defaultSession;
  // No camera, mic, notifications, geolocation, clipboard, etc.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // Block every page-initiated request that is not our own scheme (or the Vite dev server in
  // development). Main-process requests (electron-updater) have no webContents and pass through.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const ok =
      details.webContentsId === undefined ||
      isTrustedUrl(details.url, devServer) ||
      details.url.startsWith('devtools://') ||
      (!!devServer && !app.isPackaged && details.url.startsWith(devServer.replace('http', 'ws')));
    if (!ok) log.warn('blocked request', { host: safeHost(details.url) });
    callback({ cancel: !ok });
  });
  app.on('web-contents-created', (_e, contents) => {
    lockDownContents(contents, devServer);
  });
}
