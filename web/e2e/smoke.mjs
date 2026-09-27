// The browser smoke test: the real server on the two synthetic cities the server tests build, a headless Chrome driven over the DevTools protocol, and the path a viewer takes through the wall, failing on any uncaught error in the page.
//
// It needs the server compiled (`make test` does that) and the wall built (`make build`), and a Chrome or Chromium on the path or in CHROME. The synthetic cities' pictures live on the reserved .example domain, so nothing here ever contacts an agency, and the scratch root has no .env, so no key is ever read.
//
//   make smoke

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.SMOKE_PORT ?? 8597);
const DEBUG_PORT = Number(process.env.SMOKE_DEBUG_PORT ?? 9337);
const BASE = `http://127.0.0.1:${PORT}`;
const STEP_TIMEOUT_MS = 15_000;

const serverEntry = join(REPO, 'server/dist/server/src/index.js');
const wall = join(REPO, 'web/dist/index.html');
for (const [path, how] of [[serverEntry, 'make test'], [wall, 'make build']]) {
  if (!existsSync(path)) fail(`${path} is missing; run \`${how}\` first`);
}

const { testRoot, FIXTURE_CAMERAS } = await import(join(REPO, 'server/dist/server/src/testroot.js'));
const root = testRoot();
// The synthetic root carries the cities; the country map also wants the published camera index and the state outlines, both plain files in the repository, and the wall wants its built page.
for (const name of ['national_index.json', 'us_states.json']) copyFileSync(join(REPO, 'data', name), join(root, 'data', name));
mkdirSync(join(root, 'web'), { recursive: true });
symlinkSync(join(REPO, 'web/dist'), join(root, 'web/dist'), 'dir');

let serverLog = '';
// Anything unexpected ends the run as a failure with the server's log, rather than a bare stack trace that leaves the reason unrecorded.
process.on('unhandledRejection', (error) => fail(`unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`));
process.on('uncaughtException', (error) => fail(`unexpected error: ${error.stack ?? error.message}`));

const children = [];
const cleanups = [];
process.on('exit', () => {
  for (const child of children) child.kill();
  // A last resort for a run that ended early: a scratch folder left in /tmp is not worth failing over.
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // Ignored on purpose.
    }
  }
});

/** Stops Chrome and the server and waits for them to exit before their scratch folders are removed. Removing Chrome's profile while it is still shutting down fails with ENOTEMPTY or EACCES, which is what made the odd run fail after every step had passed. */
async function shutdown() {
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolveExit) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
          const timer = setTimeout(resolveExit, 5000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolveExit();
          });
          child.kill();
        }),
    ),
  );
  children.length = 0;
}

const server = spawn(process.execPath, [serverEntry, '--root', root, '--port', String(PORT)], {
  env: { ...process.env, JEV_API: '', RT511_DETECTOR_URL: 'http://127.0.0.1:9' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(server);
server.stdout.on('data', (chunk) => (serverLog += chunk));
server.stderr.on('data', (chunk) => (serverLog += chunk));
await until(async () => (await fetch(`${BASE}/api/regions`).catch(() => null))?.ok, 'the server to answer', 30_000);

const profile = mkdtempSync(join(tmpdir(), 'rt511-smoke-chrome-'));
cleanups.push(() => rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const chrome = spawn(findChrome(), ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--window-size=1400,900', '--no-first-run', '--no-default-browser-check', '--disable-gpu', ...(process.env.CI ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
children.push(chrome);

const page = await connect();
const errors = [];
page.on('Runtime.exceptionThrown', ({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
page.on('Runtime.consoleAPICalled', ({ type, args }) => {
  if (type === 'error') errors.push(args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
});
await page.send('Page.enable');
await page.send('Runtime.enable');

await step('the front page shows the name and its way in', async () => {
  await open('/');
  await expect("document.querySelector('.landing-title')?.textContent === 'rt511' && !!document.querySelector('.landing-sky')");
});

await step('Open the map goes to the country map', async () => {
  await evaluate("document.querySelector('.landing-cta').click()");
  await expect("document.body.dataset.view === 'national' && document.querySelectorAll('.national-row').length >= 2");
});

await step('a city opens on its map', async () => {
  await open('/#region=des-moines-ia&view=map');
  await expect("document.body.dataset.view === 'map' && !!document.querySelector('.pane-map canvas')");
});

await step('the wall shows every camera in the city', async () => {
  await evaluate("[...document.querySelectorAll('.view-option')].find((b) => b.textContent === 'Wall').click()");
  await expect(`document.body.dataset.view === 'wall' && document.querySelectorAll('.tile').length === ${FIXTURE_CAMERAS}`);
});

await step('a tile opens its camera', async () => {
  await evaluate("document.querySelector('.tile').click()");
  await expect("!!document.querySelector('.hero:not([hidden]) .hero-mode')?.textContent");
});

await step('Which? opens over the wall and closes with Escape', async () => {
  await evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Which?').click()");
  await expect("!!document.querySelector('.duel .duel-panel')");
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await expect("!document.querySelector('.duel')");
});

await step('the diary opens and says how to use it', async () => {
  await evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Diary')).click()");
  await expect("!!document.querySelector('.diary .diary-hint')");
});

if (errors.length > 0) fail(`the page reported ${errors.length} error(s):\n  ${errors.join('\n  ')}`);
console.log('smoke: every step passed with no page errors');
await shutdown();
process.exit(0);

// ---------------------------------------------------------------------------

async function step(name, body) {
  try {
    await body();
    console.log(`  ok  ${name}`);
  } catch (error) {
    fail(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Navigates through about:blank, because the wall reads its address only when it boots and a change of fragment alone would not reboot it. */
async function open(path) {
  await page.send('Page.navigate', { url: 'about:blank' });
  await page.send('Page.navigate', { url: `${BASE}${path}` });
}

async function evaluate(expression) {
  const { result, exceptionDetails } = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result?.value;
}

async function expect(expression) {
  await until(async () => (await evaluate(expression).catch(() => false)) === true, expression, STEP_TIMEOUT_MS);
}

async function until(check, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function findChrome() {
  const candidates = [process.env.CHROME, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean);
  for (const name of candidates) {
    if (spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0) return name;
  }
  fail(`no Chrome or Chromium found; install one or set CHROME (tried ${candidates.join(', ')})`);
}

/** The first page target's DevTools socket, with a tiny request and event layer over it. */
async function connect() {
  let target = null;
  await until(
    async () => {
      const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`).then((res) => res.json()).catch(() => []);
      target = list.find((item) => item.type === 'page') ?? null;
      return target !== null;
    },
    'Chrome to start',
    20_000,
  );
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolveReply, rejectReply } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rejectReply(new Error(message.error.message));
      else resolveReply(message.result ?? {});
    } else if (message.method) {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params);
    }
  });
  return {
    send: (method, params = {}) =>
      new Promise((resolveReply, rejectReply) => {
        const n = ++id;
        pending.set(n, { resolveReply, rejectReply });
        socket.send(JSON.stringify({ id: n, method, params }));
      }),
    on: (method, listener) => listeners.set(method, [...(listeners.get(method) ?? []), listener]),
  };
}

function fail(message) {
  console.error(`smoke failed: ${message}`);
  if (serverLog) console.error(`--- server log ---\n${serverLog.slice(-3000)}`);
  process.exit(1);
}
