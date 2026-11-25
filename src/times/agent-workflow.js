// The Activity page receives aggregates only, never agent journal records or identifiers.
const panel = document.getElementById('agent-workflow');
const period = document.getElementById('agent-workflow-period');
const provider = document.getElementById('agent-workflow-provider');
const threshold = document.getElementById('agent-workflow-threshold');
const status = document.getElementById('agent-workflow-status');
const results = document.getElementById('agent-workflow-results');
let sequence = 0, pending = false;
const countFormat = new Intl.NumberFormat('en-US');
const percentFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const count = value => countFormat.format(value);
const percent = value => value === null ? '—' : percentFormat.format(value) + '%';
function time(ms) {
  if (ms === null) return '—';
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  return [hours && hours + 'h', minutes && minutes + 'm', remainder && remainder + 's']
    .filter(Boolean).join(' ') || '0s';
}
function send(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError || !response?.ok) return reject(new Error('Workflow unavailable'));
    resolve(response.data);
  }));
}
function set(field, value) {
  document.getElementById('agent-workflow-' + field).textContent = value;
}
function render(data) {
  const connected = Object.entries(data.providers).filter(([, state]) => state.connected);
  panel.hidden = connected.length === 0;
  if (panel.hidden) { results.hidden = true; return; }
  const selected = connected.filter(([name]) => provider.value === 'all' || provider.value === name);
  if (!selected.length) {
    status.textContent = 'This provider is not connected. Choose another provider or connect it in Settings.';
    results.hidden = true;
    return;
  }
  const summary = data.workflow;
  const warnings = [];
  if (selected.some(([, state]) => state.paused || state.permission !== 'granted' || !state.complete)) {
    warnings.push('Collection is paused, incomplete or needs access. Showing saved observations.');
  }
  if (!summary.totalTurns) warnings.push('No dated observations in this period. Try another period.');
  if (summary.unknownTurns) warnings.push(count(summary.unknownTurns) + ' turns have unknown or estimated duration.');
  if (summary.extendedTurns) warnings.push(count(summary.extendedTurns) + ' extended turns excluded (' + time(summary.extendedMs) + ' measured duration).');
  if (summary.undatedTurns) warnings.push(count(summary.undatedTurns) + ' undated turns ' + (period.value === 'all' ? 'included in this history.' : 'only available in All time.'));
  if (summary.unanchoredTurns) warnings.push(count(summary.unanchoredTurns) + ' included turns have a duration but no verified interval.');
  status.textContent = warnings.join(' ');
  results.hidden = false;
  set('time', time(summary.eligibleMs));
  set('turns', count(summary.eligibleTurns) + ' / ' + count(summary.totalTurns));
  set('median', time(summary.medianMs));
  set('share', percent(summary.shortSharePct));
  set('short', time(summary.shortMs) + ' · ' + count(summary.shortCount) + ' turns');
  set('long', time(summary.longMs) + ' · ' + count(summary.longCount) + ' turns');
  set('extended', count(summary.extendedTurns));
  const meter = document.getElementById('agent-workflow-share-meter');
  meter.hidden = summary.shortSharePct === null;
  meter.value = summary.shortSharePct ?? 0;
  const rows = document.querySelectorAll('#agent-workflow-buckets tr');
  const max = Math.max(1, ...summary.buckets.map(bucket => bucket.count));
  for (const [index, row] of rows.entries()) {
    const bucket = summary.buckets[index];
    row.querySelector('progress').max = max;
    row.querySelector('progress').value = bucket.count;
    row.querySelector('[data-count]').textContent = count(bucket.count);
    row.querySelector('[data-time]').textContent = time(bucket.ms);
  }
}
async function refresh(interactive = false) {
  if (pending && !interactive) return;
  const id = ++sequence;
  pending = true;
  if (interactive && !panel.hidden) {
    status.textContent = 'Loading workflow…';
    results.hidden = true;
  }
  try {
    const data = await send({ type: 'AGENT_WORKFLOW_SUMMARY',
      period: period.value, provider: provider.value, thresholdMinutes: Number(threshold.value) });
    if (id === sequence) render(data);
  } catch {
    if (id === sequence && !panel.hidden) {
      status.textContent = 'AI Workflow is temporarily unavailable. Try refreshing.';
      results.hidden = true;
    }
  } finally {
    if (id === sequence) pending = false;
  }
}
for (const control of [period, provider, threshold]) control.addEventListener('change', () => refresh(true));
document.getElementById('agent-workflow-refresh').addEventListener('click', () => refresh(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
refresh();
