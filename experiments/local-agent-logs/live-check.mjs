import { chromium } from 'playwright';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const browser = process.argv.includes('--chromium') ? 'chromium' : 'chrome';
const persistent = process.argv.includes('--persistent');
const extension = new URL('./', import.meta.url).pathname;
const scratch = join(homedir(), '.hermes/cache/scratch');
await mkdir(scratch, { recursive: true });
const profile = await mkdtemp(join(scratch, 'clockoli-agent-live-'));
const options = {
  headless: false,
  ...(browser === 'chrome' ? {
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ignoreDefaultArgs: ['--disable-extensions'],
  } : {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  }),
};
let context;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const workerOf = async (current, timeout = 300_000) => current.serviceWorkers().find(w => w.url().endsWith('/worker.js')) ||
  current.waitForEvent('serviceworker', { predicate: w => w.url().endsWith('/worker.js'), timeout });
const statusOf = async current => {
  const worker = await workerOf(current);
  return worker.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('clockoli-local-log-probe-v1', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('status', 'readonly').objectStore('status').get('latest');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
};
async function awaitRun(current, after, timeout = 100_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const status = await statusOf(current);
      if (status?.runNumber > after) return status;
    } catch { /* Worker may be suspended; the next alarm restarts it. */ }
    await wait(1000);
  }
  throw new Error('No background scan completed within the deadline');
}
function summary(status) {
  return status && { runNumber: status.runNumber, trigger: status.trigger, startedAt: status.startedAt,
    providers: Object.fromEntries(Object.entries(status.providers).map(([name, value]) => [name, {
      permission: value.permission, filesVisited: value.filesVisited, filesAdvanced: value.filesAdvanced,
      newLines: value.newLines, bytesRead: value.bytesRead, errorCount: value.errorCount,
      errorCode: value.errorCode, backlog: !!value.backlog,
    }])) };
}
function report(stage, status) { console.log(JSON.stringify({ stage, browser, version: context.browser().version(), status: summary(status) })); }
try {
  context = await chromium.launchPersistentContext(profile, options);
  if (browser === 'chrome') {
    const setup = await context.newPage();
    await setup.goto('chrome://extensions');
    const manager = setup.locator('extensions-manager');
    const developerMode = manager.locator('extensions-toolbar #devMode');
    if (!await developerMode.evaluate(toggle => toggle.checked)) await developerMode.click();
    await manager.locator('extensions-toolbar #loadUnpacked').click();
    await setup.bringToFront();
    console.log(JSON.stringify({ stage: 'CHOOSE_EXTENSION_DIRECTORY', extension }));
  }
  let worker = await workerOf(context, 20 * 60_000);
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const page = await context.newPage();
  await page.goto(`${origin}/probe.html`);
  console.log(JSON.stringify({ stage: 'CHOOSE_DIRECTORIES', browser, origin,
    pickerAvailable: await page.evaluate(() => typeof showDirectoryPicker === 'function') }));
  const deadline = Date.now() + 20 * 60_000;
  let chosen = false;
  while (Date.now() < deadline) {
    chosen = await page.evaluate(async () => {
      const { read } = await import(chrome.runtime.getURL('database.js'));
      for (const name of ['codex', 'claude']) {
        const handle = await read('handles', name);
        if (!handle || await handle.queryPermission({ mode: 'read' }) !== 'granted') return false;
      }
      return true;
    });
    if (chosen) break;
    await wait(1000);
  }
  if (!chosen) throw new Error('Directories were not selected in time');
  const beforeChosen = await statusOf(context);
  await page.locator('#scan').click();
  const initial = await awaitRun(context, beforeChosen?.runNumber || 0, 90_000);
  if (initial.providers.codex.permission !== 'granted' || initial.providers.claude.permission !== 'granted') {
    throw new Error('Worker did not receive read permission');
  }
  report('PAGE_READ', initial);
  await page.close();
  if (context.pages().some(tab => tab.url().startsWith(origin))) throw new Error('Extension page remained open');
  const alarm = await awaitRun(context, initial.runNumber, 100_000);
  report('BACKGROUND_NO_PAGE', alarm);
  if (alarm.trigger !== 'alarm') throw new Error('Background run did not come from an alarm');
  let beforeRestart = alarm;
  if (persistent) {
    const restore = await context.newPage();
    await restore.goto(`${origin}/probe.html`);
    for (const provider of ['codex', 'claude']) {
      const permission = await restore.evaluate(async name => {
        const { read } = await import(chrome.runtime.getURL('database.js'));
        return (await read('handles', name)).queryPermission({ mode: 'read' });
      }, provider);
      console.log(JSON.stringify({ stage: 'RESTORED_HANDLE_PERMISSION', browser, provider, permission }));
      if (permission !== 'granted') {
        await restore.locator(`[data-provider="${provider}"] .allow`).click();
        console.log(JSON.stringify({ stage: 'CHOOSE_ALLOW_ON_EVERY_VISIT_IF_OFFERED', browser, provider }));
        const approvalDeadline = Date.now() + 20 * 60_000;
        let granted = false;
        while (Date.now() < approvalDeadline) {
          granted = await restore.evaluate(async name => {
            const { read } = await import(chrome.runtime.getURL('database.js'));
            return await (await read('handles', name)).queryPermission({ mode: 'read' }) === 'granted';
          }, provider);
          if (granted) break;
          await wait(1000);
        }
        if (!granted) throw new Error(`No restored read permission for ${provider}`);
      }
    }
    const beforeClose = (await statusOf(context))?.runNumber || alarm.runNumber;
    await restore.close();
    if (context.pages().some(tab => tab.url().startsWith(origin))) throw new Error('Extension page remained open after permission request');
    beforeRestart = await awaitRun(context, beforeClose, 100_000);
    report('BACKGROUND_AFTER_RESTORED_REQUEST_PERMISSION', beforeRestart);
    if (beforeRestart.trigger !== 'alarm') throw new Error('Post-permission scan did not come from an alarm');
  }
  await context.close();
  context = await chromium.launchPersistentContext(profile, options);
  worker = await workerOf(context);
  const restarted = await awaitRun(context, beforeRestart.runNumber, 100_000);
  report('AFTER_FULL_BROWSER_RESTART_NO_PAGE', restarted);
  if (context.pages().some(tab => tab.url().startsWith(origin))) throw new Error('Extension page opened during restart scan');
  if (Object.values(restarted.providers).some(item => item.permission !== 'granted')) {
    console.log(JSON.stringify({ stage: 'REAUTHORIZATION_REQUIRED', browser }));
  }
} catch (error) {
  console.log(JSON.stringify({ stage: 'FAILED', browser, error: String(error.message).slice(0, 200) }));
  process.exitCode = 1;
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
