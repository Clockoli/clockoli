import { chromium } from 'playwright';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const mode = process.argv.includes('--chromium') ? 'chromium' : 'chrome';
const extension = new URL('./', import.meta.url).pathname;
const scratch = join(homedir(), '.hermes/cache/scratch');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sample(root, depth = 0) {
  if (depth > 6) return null;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await sample(path, depth + 1);
      if (found) return found;
    } else if (entry.isFile() && entry.name.endsWith('.jsonl') && (await stat(path)).size > 0) {
      return path;
    }
  }
  return null;
}

const roots = {
  codex: join(homedir(), '.codex/sessions'),
  claude: join(homedir(), '.claude/projects'),
};
const samples = { codex: await sample(roots.codex), claude: await sample(roots.claude) };
if (!samples.codex || !samples.claude) throw new Error('Nonempty JSONL sample missing for an agent');
await mkdir(scratch, { recursive: true });
const profile = await mkdtemp(join(scratch, 'clockoli-file-url-live-'));
const options = { headless: false, ...(mode === 'chrome' ? {
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ignoreDefaultArgs: ['--disable-extensions'],
} : {
  channel: 'chromium',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
}) };
let context;
const workerOf = async (current, timeout = 20 * 60_000) => current.serviceWorkers().find(w => w.url().endsWith('/worker.js')) ||
  current.waitForEvent('serviceworker', { predicate: w => w.url().endsWith('/worker.js'), timeout });
async function statusOf(current) {
  const worker = await workerOf(current);
  return worker.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('clockoli-file-url-probe-v1', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('probe', 'readonly').objectStore('probe').get('status');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
}
async function awaitRun(current, after, timeout = 100_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const status = await statusOf(current);
      if (status?.runNumber > after) return status;
    } catch { /* The worker can be suspended between alarms. */ }
    await wait(1000);
  }
  throw new Error('Alarm/startup did not complete a scan');
}
function report(stage, status, version) {
  console.log(JSON.stringify({ stage, browser: mode, version, status }));
}
try {
  context = await chromium.launchPersistentContext(profile, options);
  const version = context.browser().version();
  if (mode === 'chrome') {
    const setup = await context.newPage();
    await setup.goto('chrome://extensions');
    const manager = setup.locator('extensions-manager');
    const developerMode = manager.locator('extensions-toolbar #devMode');
    if (!await developerMode.evaluate(toggle => toggle.checked)) await developerMode.click();
    await manager.locator('extensions-toolbar #loadUnpacked').click();
    await setup.bringToFront();
    console.log(JSON.stringify({ stage: 'CHOOSE_EXTENSION_DIRECTORY', browser: mode, version, extension }));
  }
  const worker = await workerOf(context);
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  if (mode === 'chrome') {
    const details = await context.newPage();
    await details.goto(`chrome://extensions/?id=${new URL(worker.url()).host}`);
    await details.bringToFront();
    console.log(JSON.stringify({ stage: 'ALLOW_FILE_URL_ACCESS_IN_EXTENSION_DETAILS', browser: mode, version }));
  }
  const deadline = Date.now() + 20 * 60_000;
  let enabled = false;
  while (Date.now() < deadline) {
    try {
      enabled = await (await workerOf(context)).evaluate(() => new Promise(resolve => chrome.extension.isAllowedFileSchemeAccess(resolve)));
    } catch { /* Wait for extension reload after the user enables access. */ }
    if (enabled) break;
    await wait(1000);
  }
  if (!enabled) throw new Error('File URL access was not enabled in time');
  const page = await context.newPage();
  await page.goto(`${origin}/probe.html`);
  for (const [provider, root] of Object.entries(roots)) {
    await page.locator(`#${provider}-root`).fill(pathToFileURL(root + '/').href);
    await page.locator(`#${provider}-sample`).fill(pathToFileURL(samples[provider]).href);
  }
  await page.locator('#save').click();
  if (!await page.locator('#status').innerText().then(text => text.includes('"saved": true'))) throw new Error('Local probe paths were not accepted');
  const initialRun = (await statusOf(context))?.runNumber || 0;
  await page.locator('#scan').click();
  const initial = await awaitRun(context, initialRun);
  report('PAGE_READ', initial, version);
  await page.close();
  if (context.pages().some(tab => tab.url().startsWith(origin))) throw new Error('Extension page remained open');
  const background = await awaitRun(context, initial.runNumber, 100_000);
  report('BACKGROUND_NO_PAGE', background, version);
  if (background.trigger !== 'alarm') throw new Error('Background scan did not come from an alarm');
  await context.close();
  context = await chromium.launchPersistentContext(profile, options);
  const restarted = await awaitRun(context, background.runNumber, 100_000);
  if (context.pages().some(tab => tab.url().startsWith(origin))) throw new Error('Extension page opened during restart scan');
  report('AFTER_BROWSER_RESTART_NO_PAGE', restarted, context.browser().version());
} catch (error) {
  console.log(JSON.stringify({ stage: 'FAILED', browser: mode, error: String(error.message).slice(0, 200) }));
  process.exitCode = 1;
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
