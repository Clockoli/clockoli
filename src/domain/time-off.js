import { normalizeTaskUrl, taskUrlOf } from './values.js';

export const TIME_OFF_CONFIG_PATH = '.clockoli/time-off.json';
export const MAX_TIME_OFF_TASKS = 100;

export function normalizeTimeOffConfig(value = { version: 1, taskUrls: [] }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'taskUrls,version'
      || value.version !== 1 || !Array.isArray(value.taskUrls)
      || value.taskUrls.length > MAX_TIME_OFF_TASKS) {
    throw new Error('Invalid time off settings (maximum 100 task URLs).');
  }
  const taskUrls = value.taskUrls.map(url => {
    if (typeof url !== 'string' || url.length > 2048) throw new Error('Invalid time off task URL.');
    return normalizeTaskUrl(url);
  });
  if (new Set(taskUrls).size !== taskUrls.length) throw new Error('Duplicate time off task URL.');
  return { version: 1, taskUrls };
}

export function parseTimeOffConfig(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > 210_000) {
    throw new Error('Time off settings are too large.');
  }
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error('Time off settings are not valid JSON.'); }
  return normalizeTimeOffConfig(value);
}

export function serializeTimeOffConfig(taskUrls) {
  return JSON.stringify(normalizeTimeOffConfig({ version: 1, taskUrls }), null, 2) + '\n';
}

export function isTimeOffTask(taskUrl, config) {
  return Array.isArray(config?.taskUrls) && config.taskUrls.includes(normalizeTaskUrl(taskUrl));
}

// Reports and Activity classify stored work by both task URL and stable destination ID.
// The classification is deliberately retroactive; the persistent work schema is unchanged.
export function classifyTimeOffRecords(records, configsByDestination, now = new Date()) {
  const instant = now.getTime();
  return (records ?? []).map(record => {
    const config = configsByDestination?.[record.destinationId];
    const timeOff = Boolean(config?.taskUrls?.includes(taskUrlOf(record)));
    if (!timeOff) return record;
    return {
      ...record,
      isTimeOff: true,
      isPlannedTimeOff: new Date(record.endedAt).getTime() > instant,
      metadata: { ...(record.metadata ?? {}), billable: false },
    };
  });
}
