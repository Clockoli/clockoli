import { test, expect, chromium } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);

async function settingsPage(initScript, check) {
  const scratch = join(homedir(), '.hermes/cache/scratch');
  await mkdir(scratch, { recursive: true });
  const profile = await mkdtemp(join(scratch, 'clockoli-agent-settings-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${root.pathname}`, `--load-extension=${root.pathname}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const errors = [];
    worker.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    if (initScript) await page.addInitScript(initScript);
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/options/options.html`);
    await check(page);
    expect(errors).toEqual([]);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
}

test('agent Settings remains available without GitHub and rejects a wrong folder without disclosing its name', async () => {
  await settingsPage(() => {
    window.showDirectoryPicker = async () => ({ kind: 'directory', name: 'private-project-name' });
  }, async page => {
    await expect(page.locator('#authorize')).toBeVisible();
    await expect(page.locator('#agent-codex-select')).toBeEnabled();
    await page.locator('#agent-codex-select').click();
    await expect(page.locator('#agent-codex-feedback')).toContainText('Select the sessions folder');
    expect(await page.locator('#agent-settings').innerText()).not.toContain('private-project-name');
    await page.evaluate(() => {
      window.showDirectoryPicker = async () => ({
        kind: 'directory', name: 'sessions',
        queryPermission: async () => 'prompt', requestPermission: async () => 'denied',
      });
    });
    await page.locator('#agent-codex-select').click();
    await expect(page.locator('#agent-codex-feedback')).toContainText('Read access was not granted');
    await expect(page.locator('#agent-codex-status')).toHaveText('Not connected');
    await expect(page.locator('#agent-claude-status')).toHaveText('Not connected');
  });
});

test('agent diagnostics whitelist counts and controls send provider-only messages', async () => {
  await settingsPage(() => {
    window.__agentRequests = [];
    let paused = false;
    let connected = true;
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (request, callback) => {
      if (!request?.type?.startsWith('AGENT_COLLECTOR_')) return original(request, callback);
      window.__agentRequests.push(request);
      if (request.type === 'AGENT_COLLECTOR_CONTROL') {
        if (request.action === 'pause') paused = true;
        if (request.action === 'resume') paused = false;
        if (request.action === 'forget') connected = false;
      }
      callback({ ok: true, data: { providers: {
        codex: { connected, permission: 'granted', paused, filesVisited: 3, filesAdvanced: 2,
          bytesRead: 512, backlog: 1, runNumber: 4, errorCode: '/private/sessions' },
        claude: { connected: false, permission: 'prompt', paused: false },
      } } });
    };
  }, async page => {
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getDirectoryHandle('sessions', { create: true });
      const { setAgentRoot } = await import('../storage/agent-activity-store.js');
      await setAgentRoot('codex', handle);
    });
    await page.reload();
    await expect(page.locator('#agent-codex-status')).toHaveText('Scanning');
    await expect(page.locator('#agent-codex-diagnostics')).toContainText('Backlog: yes');
    await expect(page.locator('#agent-codex-diagnostics')).toContainText('Error code: none');
    expect(await page.locator('#agent-settings').innerText()).not.toContain('/private/sessions');
    await page.locator('#agent-codex-pause').click();
    await expect(page.locator('#agent-codex-status')).toHaveText('Paused');
    await page.locator('#agent-codex-pause').click();
    await expect(page.locator('#agent-codex-status')).toHaveText('Scanning');
    await page.locator('#agent-codex-scan').click();
    await page.locator('#agent-codex-forget').click();
    await expect(page.locator('#agent-codex-status')).toHaveText('Not connected');
    expect(await page.evaluate(() => window.__agentRequests.filter(r => r.type === 'AGENT_COLLECTOR_CONTROL')))
      .toEqual(['pause', 'resume', 'scan', 'forget'].map(action => ({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'codex', action })));
  });
});

test('agent Settings disables folder controls where File System Access is unavailable', async () => {
  await settingsPage(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
  }, async page => {
    await expect(page.locator('#authorize')).toBeVisible();
    await expect(page.locator('#agent-support')).toBeVisible();
    for (const provider of ['codex', 'claude']) {
      await expect(page.locator(`#agent-${provider}-select`)).toBeDisabled();
      await expect(page.locator(`#agent-${provider}-forget`)).toBeDisabled();
      await expect(page.locator(`#agent-${provider}-status`)).toHaveText('Unavailable');
    }
  });
});
