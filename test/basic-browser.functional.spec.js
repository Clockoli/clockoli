import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);

test('a clean Chromium profile opens the extension Settings and Activity pages', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'clockoli-public-smoke-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${root.pathname}`, `--load-extension=${root.pathname}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const errors = [];
    worker.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    worker.on('close', () => errors.push('Service worker closed during smoke test'));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const origin = `chrome-extension://${new URL(worker.url()).host}`;
    await page.goto(`${origin}/src/options/options.html`);
    await expect(page.locator('#authorize')).toBeVisible();
    await page.goto(`${origin}/src/times/times.html`);
    await expect(page.locator('body')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('Settings Clear cache deletes real IndexedDB caches but preserves browser preferences', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'clockoli-clear-cache-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${root.pathname}`, `--load-extension=${root.pathname}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = `chrome-extension://${new URL(worker.url()).host}/src/options/options.html`;
    await page.goto(url);
    await expect(page.locator('#authorize')).toBeVisible();
    await page.locator('#open-full-restore').click();
    await expect(page.locator('#clear-cache')).toBeVisible();
    await page.evaluate(async () => {
      const { IndexedDbBackend } = await import(chrome.runtime.getURL('src/storage/chrome-store.js'));
      const backend = new IndexedDbBackend();
      await backend.setMany({
        reportCache: { version: 2, entries: { old: { blobs: { sha: 'cached history' } } } },
        taskSearchCache: { revision: 3, indexTasks: ['old'] },
        pageSnapshots: { tasks: { view: { configured: true } } },
        taskMetadataCache: { version: 2, entries: { old: { title: 'old' } } },
        exchangeRateCache: { version: 2, entries: { old: 1 } },
        'test-durable-preference': { value: 'keep' },
      });
      localStorage.setItem('clockoli-test-preference', 'keep');
    });
    await page.locator('#clear-cache').click();
    await expect(page.locator('#clear-cache-feedback')).toContainText('Cache cleared');
    await expect(page.locator('#clear-cache')).toBeEnabled();
    expect(page.url()).toBe(url);
    const saved = await page.evaluate(async () => {
      const { IndexedDbBackend } = await import(chrome.runtime.getURL('src/storage/chrome-store.js'));
      return {
        entries: await new IndexedDbBackend().getMany([
          'reportCache', 'pageSnapshots', 'taskMetadataCache', 'exchangeRateCache',
          'taskSearchCache', 'test-durable-preference',
        ]),
        preference: localStorage.getItem('clockoli-test-preference'),
      };
    });
    expect(saved).toEqual({ entries: {
      taskSearchCache: { revision: 4, dirty: false },
      'test-durable-preference': { value: 'keep' },
    }, preference: 'keep' });
    expect(errors).toEqual([]);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
