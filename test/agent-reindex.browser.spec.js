import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const repository = new URL('../', import.meta.url).pathname;
const scratch = join(homedir(), '.hermes/cache/scratch');
async function open(profile, extension, errors) {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  worker.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/src/options/options.html`);
  return { context, page, origin };
}

async function observation(page, scan = false) {
  return page.evaluate(async shouldScan => {
    const store = await import(chrome.runtime.getURL('src/storage/agent-activity-store.js'));
    const response = shouldScan
      ? await chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_CONTROL', provider: 'claude', action: 'scan' })
      : await chrome.runtime.sendMessage({ type: 'AGENT_COLLECTOR_STATUS' });
    if (!response?.ok) throw new Error(`Collector request failed: ${response?.error?.code || 'unknown'}`);
    const state = await store.getAgentState('claude');
    const projections = await Promise.all([1, 2].map(version => store.getAgentProjection('claude', version)));
    const files = await Promise.all([1, 2].map(version => store.listAgentFiles('claude', version)));
    const compact = projection => projection && ({ revision: projection.revision,
      keys: projection.turns.map(turn => turn.key),
      measured: projection.turns.filter(turn => turn.providerDurationMs !== null).length,
      durations: projection.turns.map(turn => turn.providerDurationMs).filter(ms => ms !== null).sort(),
      sourceFiles: [...new Set(projection.turns.map(turn => turn.sourceFileKey))].length });
    return { health: response.data.providers.claude, coverage: response.data.coverage.claude,
      state, projections: projections.map(compact),
      files: files.map(rows => rows.map(row => ({ key: row.fileKey, offset: row.cursor.offset,
        size: row.cursor.size, revision: row.revision, sourceMissing: row.sourceMissing, evidenceGeneration: row.evidenceGeneration }))) };
  }, scan);
}

function assertActive(snapshot, generation, keys) {
  expect(snapshot.state.activeGeneration).toBe(generation);
  expect(snapshot.health.activeGeneration).toBe(generation);
  expect(snapshot.coverage.scan.parserGeneration).toBe(generation);
  expect(snapshot.coverage.turns).toMatchObject({ discovered: 3, measured: 2, unknown: 1 });
  expect(snapshot.coverage.time.agentMs).toBe(4000);
  expect(snapshot.projections[generation - 1].keys).toEqual(keys);
  expect(new Set(keys).size).toBe(3);
  expect(snapshot.projections[generation - 1].measured).toBe(2);
  expect(snapshot.projections[generation - 1].durations).toEqual([1000, 3000]);
  expect(snapshot.projections[generation - 1].sourceFiles).toBe(2);
}

test('FULL Claude parser reindex stages across a >16 MiB journal, survives two browser restarts, then prunes v1', async () => {
  test.setTimeout(180_000);
  await mkdir(scratch, { recursive: true });
  const temporary = await mkdtemp(join(scratch, 'clockoli-agent-reindex-'));
  const profile = join(temporary, 'profile');
  const extension = join(temporary, 'unpacked');
  const errors = [];
  let browser;
  try {
    execFileSync('python3', ['scripts/build-release.py', '--unpacked', extension], { cwd: repository });
    browser = await open(profile, extension, errors);
    const fixture = await browser.page.evaluate(async () => {
      const store = await import(chrome.runtime.getURL('src/storage/agent-activity-store.js'));
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('synthetic-claude', { create: true });
      const row = (type, uuid, parentUuid, extra = {}) => JSON.stringify({
        type, uuid, parentUuid, sessionId: 'synthetic-family',
        timestamp: '2026-01-01T00:00:01.000Z', ...extra,
      }) + '\n';
      const user = uuid => row('user', uuid, null, { message: { content: [{ type: 'text', text: '' }] } });
      // Only synthetic metadata/markers: no prompts, paths, user records, or real journals.
      const padding = JSON.stringify({ type: 'synthetic_padding', marker: 'x'.repeat(64 * 1024) }) + '\n';
      const longFile = await folder.getFileHandle('family-a.jsonl', { create: true });
      const writer = await longFile.createWritable();
      await writer.write(user('synthetic-first'));
      for (let index = 0; index < 270; index++) await writer.write(padding);
      await writer.write(user('synthetic-second'));
      await writer.close();
      const linkedFile = await folder.getFileHandle('family-b.jsonl', { create: true });
      const linkedWriter = await linkedFile.createWritable();
      await linkedWriter.write(row('assistant', 'synthetic-assistant', 'synthetic-first')
        + row('system', 'synthetic-duration', 'synthetic-assistant', {
          subtype: 'turn_duration', durationMs: 3000,
        }));
      await linkedWriter.close();
      const archive = await folder.getFileHandle('archivable.jsonl', { create: true });
      const archiveWriter = await archive.createWritable();
      await archiveWriter.write(row('system', 'archived-duration', 'missing-assistant', {
        subtype: 'turn_duration', durationMs: 1000, sessionId: 'archived-session',
      }));
      await archiveWriter.close();
      await store.setAgentRoot('claude', folder);
      return { bytes: (await longFile.getFile()).size, linkedBytes: (await linkedFile.getFile()).size };
    });
    expect(fixture.bytes).toBeGreaterThan(16 * 1024 * 1024);
    expect(fixture.linkedBytes).toBeGreaterThan(0);

    let v1;
    for (let attempt = 0; attempt < 6; attempt++) {
      v1 = await observation(browser.page, true);
      expect(v1.health.errorCode).toBeNull();
      if (v1.health.complete) break;
    }
    expect(v1.health.complete).toBe(true);
    expect(v1.files[0]).toHaveLength(3);
    expect(v1.files[0].every(file => file.offset === file.size)).toBe(true);
    const keys = v1.projections[0].keys;
    assertActive(v1, 1, keys);
    expect(v1.projections[1]).toBeNull();
    expect(v1.coverage.scan.unknownEvents).toBe(270);
    await browser.page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('synthetic-claude');
      await folder.removeEntry('archivable.jsonl');
    });
    v1 = await observation(browser.page, true);
    assertActive(v1, 1, keys);
    expect(v1.coverage.scan.archivedFiles).toBe(1);
    expect(v1.coverage.scan.archivedOlderParserFiles).toBe(0);

    await browser.context.close();
    browser = undefined;
    const collectorPath = join(extension, 'src/agents/collector.js');
    const source = await readFile(collectorPath, 'utf8');
    expect(source).toContain('export const AGENT_PARSER_VERSION = 1;');
    await writeFile(collectorPath, source.replace('export const AGENT_PARSER_VERSION = 1;',
      'export const AGENT_PARSER_VERSION = 2;'));
    browser = await open(profile, extension, errors);
    // Chromium may restore the old loaded worker after a profile restart. Explicitly
    // reload this isolated installation so its worker reads the modified copy.
    await browser.page.evaluate(() => chrome.runtime.reload()).catch(error => {
      // reload() destroys its own caller before Playwright receives the return value.
      if (!/Target page, context or browser has been closed|Execution context was destroyed/.test(error.message)) throw error;
    });
    await browser.context.close();
    browser = await open(profile, extension, errors);
    const copiedVersion = await browser.page.evaluate(async () =>
      (await import(chrome.runtime.getURL('src/agents/collector.js'))).AGENT_PARSER_VERSION);
    expect(copiedVersion).toBe(2);
    const staged = await observation(browser.page, true);
    expect(staged.health.errorCode).toBeNull();
    expect(staged.state.desiredGeneration).toBe(2);
    expect(staged.health.parserGeneration).toBe(1); // Exposed coverage remains the active v1 generation.
    expect(staged.health.backlog).toBe(true);
    expect(staged.health.complete).toBe(false);
    expect(staged.files[1].length).toBeGreaterThan(0);
    expect(staged.files[1].some(file => file.offset < file.size)).toBe(true);
    expect(staged.projections[1]).not.toBeNull();
    assertActive(staged, 1, keys);
    expect(staged.projections[0].revision).toBe(v1.projections[0].revision);

    await browser.context.close();
    browser = await open(profile, extension, errors);
    const resumed = await observation(browser.page);
    expect(resumed.state.desiredGeneration).toBe(2);
    expect(resumed.files[1]).toEqual(staged.files[1]);
    assertActive(resumed, 1, keys);
    expect(resumed.coverage.scan.unknownEvents).toBe(270);

    let v2;
    for (let attempt = 0; attempt < 6; attempt++) {
      v2 = await observation(browser.page, true);
      expect(v2.health.errorCode).toBeNull();
      if (v2.state.activeGeneration === 2) break;
      assertActive(v2, 1, keys);
    }
    expect(v2.health.complete).toBe(false); // Missing source cannot be revalidated by v2.
    expect(v2.health.backlog).toBe(false);
    expect(v2.coverage.scan.archivedFiles).toBe(1);
    expect(v2.coverage.scan.archivedOlderParserFiles).toBe(1);
    expect(v2.state.desiredGeneration).toBe(2);
    assertActive(v2, 2, keys);
    expect(v2.files[1]).toHaveLength(3);
    expect(v2.files[1].find(file => file.sourceMissing).evidenceGeneration).toBe(1);
    expect(v2.files[1].every(file => file.offset === file.size)).toBe(true);
    expect(v2.files[0]).toEqual([]);
    expect(v2.projections[0]).toBeNull();
    expect(v2.coverage.scan.unknownEvents).toBe(270);

    const repeat = await observation(browser.page, true);
    assertActive(repeat, 2, keys);
    expect(repeat.projections[1]).toEqual(v2.projections[1]);
    expect(repeat.files[1]).toEqual(v2.files[1]);
    expect(repeat.files[0]).toEqual([]);
    expect(repeat.projections[0]).toBeNull();
    expect(repeat.coverage.scan.unknownEvents).toBe(270);
    await browser.page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('synthetic-claude');
      const file = await folder.getFileHandle('archivable.jsonl', { create: true });
      const writer = await file.createWritable();
      await writer.write(JSON.stringify({ type: 'system', uuid: 'archived-duration',
        parentUuid: 'missing-assistant', sessionId: 'archived-session',
        timestamp: '2026-01-01T00:00:01.000Z', subtype: 'turn_duration', durationMs: 1000 }) + '\n');
      await writer.close();
    });
    const restored = await observation(browser.page, true);
    assertActive(restored, 2, keys);
    expect(restored.health.complete).toBe(true);
    expect(restored.coverage.scan.archivedFiles).toBe(0);
    expect(restored.coverage.scan.archivedOlderParserFiles).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser?.context.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
