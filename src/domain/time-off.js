import { normalizeTaskUrl, taskUrlOf } from './values.js';
import { normalizeTimezone } from './records.js';

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
  if (typeof taskUrl !== 'string' || !/^https?:\/\//i.test(taskUrl)) return false;
  return Array.isArray(config?.taskUrls) && config.taskUrls.includes(normalizeTaskUrl(taskUrl));
}

// Reports and Activity classify stored work by both task URL and stable destination ID.
// The classification is deliberately retroactive; the persistent work schema is unchanged.
export function classifyTimeOffRecords(records, configsByDestination, now = new Date()) {
  const instant = now.getTime();
  return (records ?? []).map(record => {
    const config = configsByDestination?.[record.destinationId];
    const timeOff = Boolean(config?.taskUrls?.length && config.taskUrls.includes(taskUrlOf(record)));
    if (!timeOff) return record;
    return {
      ...record,
      isTimeOff: true,
      isPlannedTimeOff: new Date(record.endedAt).getTime() > instant,
      metadata: { ...(record.metadata ?? {}), billable: false },
    };
  });
}


const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const GROUP_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function timeOffGroupId(record) {
  const value = record?.metadata?.clockoli?.timeOffGroupId;
  return typeof value === 'string' && GROUP_RE.test(value) ? value : null;
}

export function normalizeTimeOffDays(days, { allowEmpty = false } = {}) {
  if (!Array.isArray(days) || days.length > 50 || (!allowEmpty && !days.length)) {
    throw new Error('Choose between 1 and 50 time off days.');
  }
  const selected = days.map(item => {
    const date = item?.date, startTime = item?.startTime, seconds = item?.durationSeconds;
    if (typeof date !== 'string' || !DATE_RE.test(date)
        || !Number.isFinite(Date.parse(date + 'T00:00:00Z'))
        || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date
        || (startTime !== undefined && (typeof startTime !== 'string' || !TIME_RE.test(startTime)))
        || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 86400) {
      throw new Error('Invalid time off day, start time, or duration.');
    }
    // Explicit starts from older queued operations remain fixed. New PTO
    // chooses its start automatically from available intervals on the day.
    if (startTime !== undefined) {
      const minute = Number(startTime.slice(0, 2)) * 60 + Number(startTime.slice(3));
      if (minute * 60 + seconds > 86400) {
        throw new Error('Time off must end on the selected day.');
      }
    }
    return { date, ...(startTime === undefined ? {} : { startTime }), durationSeconds: seconds };
  });
  for (let i = 1; i < selected.length; i++) {
    if (selected[i].date <= selected[i - 1].date) throw new Error('Time off days must be unique and in date order.');
  }
  if (selected.length && (Date.parse(selected.at(-1).date + 'T00:00:00Z')
      - Date.parse(selected[0].date + 'T00:00:00Z')) / DAY_MS >= 500) {
    throw new Error('Time off cannot span more than 500 days.');
  }
  return selected;
}

// Convert wall-clock PTO time in its stored IANA zone, not the current device zone.
function zonedParts(instant, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(instant)
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { date: `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`, second: parts.second };
}
function zonedFormatter(timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: normalizeTimezone(timezone), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
}
export function timeOffWallClock(startedAt, timezone) {
  return zonedParts(new Date(startedAt), zonedFormatter(timezone)).time;
}
export function timeOffStartInstant(date, startTime, timezone) {
  if (!DATE_RE.test(date) || !TIME_RE.test(startTime)) throw new Error('Invalid time off start.');
  const target = Date.parse(`${date}T${startTime}:00.000Z`);
  if (!Number.isFinite(target)) throw new Error('Invalid time off start.');
  const formatter = zonedFormatter(timezone);
  // Sample both sides of a DST transition. Reject nonexistent local times and
  // consistently choose the earlier instant when the local hour occurs twice.
  const offsets = new Set([-36, -12, 0, 12, 36].map(hours => {
    const probe = target + hours * 3_600_000;
    const wall = zonedParts(new Date(probe), formatter);
    return Date.parse(`${wall.date}T${wall.time}:${wall.second}.000Z`) - probe;
  }));
  const instants = [...offsets].map(offset => target - offset).filter(instant => {
    const wall = zonedParts(new Date(instant), formatter);
    return wall.date === date && wall.time === startTime;
  });
  if (!instants.length) throw new Error('This start time does not exist in the selected time zone.');
  return new Date(Math.min(...instants));
}

// Some zones (for example America/Havana) move their clocks forward at local
// midnight. Find the first valid minute, rather than assuming 00:00 exists.
// Limit the recovery search to six hours; a skipped civil date is invalid PTO.
function timeOffDayStart(date, timezone) {
  for (let minute = 0; minute < 360; minute++) {
    const time = String(Math.floor(minute / 60)).padStart(2, '0') + ':'
      + String(minute % 60).padStart(2, '0');
    try { return timeOffStartInstant(date, time, timezone).getTime(); }
    catch (error) {
      if (error?.message !== 'This start time does not exist in the selected time zone.') throw error;
    }
  }
  throw new Error('This local date does not exist in the selected time zone.');
}

// Prefer the normal 09:00 workday start; if occupied, use the first
// contiguous slot after it. Never silently place a normal PTO day overnight.
export function findTimeOffStart(date, durationSeconds, timezone, occupied = []) {
  const day = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== date) {
    throw new Error('Invalid time off date.');
  }
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0 || durationSeconds > 86400) {
    throw new Error('Time off duration must be between 1 second and 24 hours.');
  }
  day.setUTCDate(day.getUTCDate() + 1);
  const end = timeOffDayStart(day.toISOString().slice(0, 10), timezone);
  const midnight = timeOffDayStart(date, timezone);
  const normalStart = timeOffStartInstant(date, '09:00', timezone).getTime();
  const durationMs = durationSeconds * 1000;
  const earliest = durationMs <= end - normalStart ? normalStart : midnight;
  const intervals = occupied.map(entry => ({
    start: new Date(entry.startedAt).getTime(), end: new Date(entry.endedAt).getTime(),
  })).filter(item => Number.isFinite(item.start) && item.end > earliest && item.start < end)
    .sort((a, b) => a.start - b.start);
  let cursor = earliest;
  for (const interval of intervals) {
    if (cursor + durationMs <= interval.start) break;
    cursor = Math.max(cursor, interval.end);
    if (cursor + durationMs > end) break;
  }
  if (cursor + durationMs > end) {
    throw new Error(`No free ${durationSeconds / 3600}-hour interval on ${date}. Change the hours or edit existing time.`);
  }
  return new Date(cursor);
}

export function normalizeTimeOffChange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid time off change.');
  const { taskUrl, taskTitle = '', description = '', groupId = null, previous = [], days,
    timezone = null, singleDayDeletion = false, bulkDayDeletion = false } = value;
  const url = normalizeTaskUrl(taskUrl);
  if (typeof taskTitle !== 'string' || taskTitle.length > 500
      || typeof description !== 'string' || description.length > 2000
      || (groupId !== null && (typeof groupId !== 'string' || !GROUP_RE.test(groupId)))
      || typeof singleDayDeletion !== 'boolean' || typeof bulkDayDeletion !== 'boolean') {
    throw new Error('Invalid time off task or group.');
  }
  if (!Array.isArray(previous) || previous.length > (bulkDayDeletion ? 200 : 50)
      || previous.some(item => !item || typeof item.id !== 'string' || !GROUP_RE.test(item.id)
        || typeof item.date !== 'string' || !DATE_RE.test(item.date)
        || typeof item.startedAt !== 'string' || !Number.isFinite(Date.parse(item.startedAt))
        || typeof item.endedAt !== 'string' || !Number.isFinite(Date.parse(item.endedAt))
        || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt)))) {
    throw new Error('Invalid previous time off entries.');
  }
  if (new Set(previous.map(item => item.id)).size !== previous.length) throw new Error('Duplicate previous time off entry.');
  const normalizedDays = normalizeTimeOffDays(days, { allowEmpty: previous.length > 0 });
  if (singleDayDeletion && (previous.length !== 1 || normalizedDays.length !== 0)) {
    throw new Error('Deleting one time off day requires exactly one original entry and no new entries.');
  }
  if (bulkDayDeletion && (singleDayDeletion || previous.length < 1 || normalizedDays.length > 0
      || previous.some(item => typeof item.taskUrl !== 'string'
        || (item.groupId !== null && item.groupId !== undefined
          && (typeof item.groupId !== 'string' || !GROUP_RE.test(item.groupId)))))) {
    throw new Error('Bulk time off deletion needs original records with their task URLs and group IDs.');
  }
  return { taskUrl: url, taskTitle, description, groupId, singleDayDeletion, bulkDayDeletion,
    timezone: timezone === null ? null : normalizeTimezone(timezone),
    previous: previous.map(item => ({
      id: item.id, date: item.date, startedAt: item.startedAt,
      endedAt: item.endedAt, updatedAt: item.updatedAt,
      ...(bulkDayDeletion ? { taskUrl: normalizeTaskUrl(item.taskUrl),
        groupId: item.groupId ?? null } : {}),
    })), days: normalizedDays };
}

// Grouped PTO is one UI item even though GitHub persists one normal time entry per day.
// Legacy PTO without a group ID is deliberately left as separate one-day items.
export function groupTimeOffRecords(records, now = Date.now()) {
  const byKey = new Map();
  const instant = new Date(now).getTime();
  for (const entry of records ?? []) {
    if (entry?.isTimeOff !== true || !entry.id) continue;
    const groupId = timeOffGroupId(entry);
    const key = JSON.stringify([entry.destinationId, entry.user, groupId ?? 'legacy:' + entry.id]);
    if (!byKey.has(key)) byKey.set(key, {
      key, groupId, destinationId: entry.destinationId, repository: entry.timeRepository || '',
      user: entry.user, taskUrl: entry.taskUrl, taskTitle: entry.taskTitle || '',
      description: entry.description || '', entries: [],
    });
    byKey.get(key).entries.push(entry);
  }
  return [...byKey.values()].map(group => {
    group.entries.sort((a, b) => a.entryDate.localeCompare(b.entryDate) || a.startedAt.localeCompare(b.startedAt));
    group.startDate = group.entries[0].entryDate;
    group.endDate = group.entries.at(-1).entryDate;
    group.planned = group.entries.filter(item => new Date(item.endedAt).getTime() > instant);
    group.taken = group.entries.filter(item => new Date(item.endedAt).getTime() <= instant);
    group.totalSeconds = group.entries.reduce((sum, item) => sum + (Number(item.durationSeconds) || 0), 0);
    return group;
  }).sort((a, b) => b.startDate.localeCompare(a.startDate) || a.user.localeCompare(b.user));
}
