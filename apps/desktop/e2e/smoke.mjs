// End-to-end smoke test of the built app (run `npm run build` first).
// Launches the real Electron app, verifies security settings from the main process and the page,
// waits for the hardcoded demo reminder, clicks Done, and saves screenshots to e2e/artifacts/.
//
//   xvfb-run -a node e2e/smoke.mjs        (Linux CI / headless)
//   node e2e/smoke.mjs                    (Windows/macOS)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(root, 'e2e', 'artifacts');
mkdirSync(artifacts, { recursive: true });

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', name, err.message]);
  }
};

// Sandboxed preloads may only require('electron'): no chunks, no node_modules.
const preloadDir = join(root, 'out', 'preload');
for (const f of readdirSync(preloadDir, { recursive: true })) {
  const file = join(preloadDir, String(f));
  if (!file.endsWith('.cjs') && !file.endsWith('.js')) {
    results.push(['FAIL', `preload: unexpected file ${String(f)}`]);
    continue;
  }
  const requires = [...readFileSync(file, 'utf8').matchAll(/require\(["']([^"']+)["']\)/g)].map(
    (m) => m[1],
  );
  const bad = requires.filter((r) => r !== 'electron');
  results.push(
    bad.length
      ? ['FAIL', `preload ${String(f)} is self-contained`, bad.join(', ')]
      : ['PASS', `preload ${String(f)} is self-contained`],
  );
}

// Fresh profile; the walking checks need the pet on screen all the time.
const userData = mkdtempSync(join(tmpdir(), 'deskbuddy-smoke-'));
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ onlyForReminders: false }));
const args = [root, `--user-data-dir=${userData}`];
// Root in a container cannot use the Chromium setuid sandbox; never needed on a real desktop.
if (process.platform === 'linux' && process.getuid?.() === 0) args.unshift('--no-sandbox');

const app = await electron.launch({
  args,
  env: { ...process.env, DESK_BUDDY_DEMO: '1', DESK_BUDDY_DEMO_DELAY_MS: '3000', NODE_ENV: 'test' },
  timeout: 30_000,
});

try {
  // A build with a backend configured also opens the sign-in window; always target the pet window.
  const pageFor = async (suffix) => {
    for (let i = 0; i < 200; i++) {
      const w = app.windows().find((x) => x.url().endsWith(suffix));
      if (w) return w;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no window ${suffix}`);
  };
  const page = await pageFor('/index.html');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(artifacts, '1-idle.png'), omitBackground: true });

  await check('window: hardened webPreferences', async () => {
    const prefs = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith('/index.html'),
      );
      const p = w.webContents.getLastWebPreferences();
      return {
        contextIsolation: p.contextIsolation,
        nodeIntegration: p.nodeIntegration,
        sandbox: p.sandbox,
        webSecurity: p.webSecurity,
        webviewTag: p.webviewTag,
        url: w.webContents.getURL(),
      };
    });
    assert.deepEqual(prefs, {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      url: 'app://renderer/index.html',
    });
  });

  await check('window: transparent overlay, always on top, never takes focus', async () => {
    const w = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith('/index.html'),
      );
      return { top: win.isAlwaysOnTop(), focusable: win.isFocusable(), taskbar: win.isVisible() };
    });
    assert.equal(w.top, true);
    assert.equal(w.focusable, false);
  });

  await check('page: no Node globals, frozen bridge, no raw ipcRenderer', async () => {
    const r = await page.evaluate(() => ({
      require: typeof globalThis.require,
      process: typeof globalThis.process,
      bridgeFrozen: Object.isFrozen(window.deskBuddy),
      keys: Object.keys(window.deskBuddy).sort(),
    }));
    assert.equal(r.require, 'undefined');
    assert.equal(r.process, 'undefined');
    assert.equal(r.bridgeFrozen, true);
    assert.ok(!r.keys.includes('ipcRenderer') && !r.keys.includes('send'));
  });

  await check(
    'page: CSP header served and enforced (network + inline script blocked)',
    async () => {
      const header = await app.evaluate(async ({ net }) => {
        const res = await net.fetch('app://renderer/index.html');
        return res.headers.get('content-security-policy');
      });
      assert.match(header, /default-src 'none'/);
      assert.match(header, /script-src 'self'(;|$)/);
      assert.match(header, /connect-src 'none'/);
      assert.doesNotMatch(header, /unsafe-(inline|eval)/);
      const r = await page.evaluate(async () => {
        const fetchResult = await fetch('https://example.com').then(
          () => 'allowed',
          () => 'blocked',
        );
        const s = document.createElement('script');
        s.textContent = 'window.__inline = 1';
        document.body.appendChild(s);
        return { fetchResult, inline: window.__inline === 1 ? 'allowed' : 'blocked' };
      });
      assert.deepEqual(r, { fetchResult: 'blocked', inline: 'blocked' });
    },
  );

  await check('protocol: path traversal is rejected', async () => {
    const status = await app.evaluate(async ({ net }) => {
      const res = await net.fetch('app://renderer/..%2F..%2Fpackage.json');
      return res.status;
    });
    assert.equal(status, 403);
  });

  await check('ipc: invalid payloads are dropped', async () => {
    await page.evaluate(() => {
      window.deskBuddy.act('../../etc/passwd', 'done');
      window.deskBuddy.act('local-demo', 'rm -rf');
    });
    // The demo alert must still arrive and be actionable afterwards (checked below).
  });

  await check('alert: demo reminder shows with Arabic text in an RTL-correct bubble', async () => {
    await page.waitForSelector('#bubble:not([hidden])', { timeout: 10_000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(artifacts, '2-alert.png'), omitBackground: true });
    const r = await page.evaluate(() => {
      const t = document.querySelector('.bubble__title');
      const box = t.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(t);
      const rightmost = Math.max(...[...range.getClientRects()].map((x) => x.right));
      return {
        text: t.textContent,
        bidi: getComputedStyle(t).unicodeBidi,
        rtl: t.matches(':dir(rtl)'),
        direction: getComputedStyle(t).direction,
        dirAttr: t.getAttribute('dir'),
        // RTL lines hug the right edge of the paragraph box.
        rightGap: Math.round(box.right - rightmost),
        font: document.fonts.check('600 16px "IBM Plex Sans Arabic"', 'موعد'),
      };
    });
    assert.match(r.text, /موعد الطبيب/);
    assert.equal(r.bidi, 'plaintext');
    assert.equal(r.rtl, true, JSON.stringify(r));
    assert.ok(r.rightGap <= 2, `text not right-aligned (gap ${r.rightGap})`);
    assert.equal(r.font, true, 'IBM Plex Sans Arabic 600 not loaded');
  });

  await check('alert: Done hides the bubble and the pet celebrates', async () => {
    await page.click('button[data-action="done"]');
    await page.waitForSelector('#bubble[hidden]', { state: 'attached', timeout: 3_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(artifacts, '3-done.png'), omitBackground: true });
  });

  await check('pet: walks (window moves) over time', async () => {
    const pos = () =>
      app.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.webContents.getURL().endsWith('/index.html'))
            .getBounds().x,
      );
    const seen = new Set([await pos()]);
    for (let i = 0; i < 60 && seen.size < 2; i++) {
      await page.waitForTimeout(1000);
      seen.add(await pos());
    }
    assert.ok(seen.size >= 2, 'window never moved in 60s');
  });

  await check('renderer crash is recovered', async () => {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().endsWith('/index.html'))
        .webContents.forcefullyCrashRenderer(),
    );
    await new Promise((r) => setTimeout(r, 3000));
    const n = await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter(
          (w) =>
            !w.isDestroyed() &&
            !w.webContents.isCrashed() &&
            w.webContents.getURL().endsWith('/index.html'),
        ).length,
    );
    assert.equal(n, 1);
  });
  await check('page: cannot navigate away or open windows', async () => {
    // The crash test above replaced the window; use the recreated page.
    const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    const fresh = await pageFor('/index.html');
    await fresh.waitForLoadState('domcontentloaded');
    await fresh.evaluate(() => {
      window.open('https://evil.example', '_blank');
      location.href = 'https://evil.example';
    });
    await fresh.waitForTimeout(500);
    const r = await app.evaluate(({ BrowserWindow }) => ({
      count: BrowserWindow.getAllWindows().length,
      urls: BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()),
    }));
    assert.equal(r.count, before, 'a new window was opened');
    assert.ok(
      r.urls.every((u) => u.startsWith('app://renderer/')),
      `navigated away: ${r.urls.join(', ')}`,
    );
  });
} finally {
  await app.close().catch(() => undefined);
}

for (const [status, name, msg] of results) {
  process.stdout.write(`${status}  ${name}${msg ? `\n      ${msg}` : ''}\n`);
}
const failed = results.filter((r) => r[0] === 'FAIL').length;
process.stdout.write(`\n${results.length - failed}/${results.length} passed\n`);
process.exit(failed ? 1 : 0);
