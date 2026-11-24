import { groupTimeOffRecords, normalizeTimeOffDays } from '../domain/time-off.js';
import { annualTimeOffDays } from '../domain/time-off-year.js';

const $ = id => document.getElementById(id);
const DAY_MS = 86400000;
const state = { entries: [], repositories: [], currentUsers: {}, groups: [], teamEntries: [],
  year: Number(new Date().getFullYear()), selectedDate: '', loadedTeamYear: null,
  mineRequestId: 0, teamRequestId: 0, myLoadedDestinations: new Set(),
  teamLoading: false, group: null, formBusy: false, cancelGroup: null };
const form = $('time-off-form');
const dayState = new Map(), takenDates = new Set();
let calendarMonth = '', calendarAnchor = null;
const send = request => new Promise((resolve, reject) => chrome.runtime.sendMessage(request, response => {
  if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
  if (!response?.ok) return reject(new Error(response?.error?.message || 'Clockoli request failed.'));
  resolve(response.data);
}));
const localDate = date => {
  const d = new Date(date);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
};
const today = () => localDate(new Date());
const dateAt = date => new Date(date + 'T12:00:00Z');
const addDays = (date, count) => {
  const day = dateAt(date); day.setUTCDate(day.getUTCDate() + count);
  return day.toISOString().slice(0, 10);
};
const monday = date => addDays(date, -((dateAt(date).getUTCDay() + 6) % 7));
const dayLabel = date => dateAt(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short', timeZone: 'UTC' });
const dateLabel = date => dateAt(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const duration = seconds => {
  const mins = Math.round((Number(seconds) || 0) / 60);
  return (Math.floor(mins / 60) ? Math.floor(mins / 60) + 'h' : '')
    + (mins % 60 ? ' ' + mins % 60 + 'm' : !Math.floor(mins / 60) ? '0m' : '');
};
const sum = entries => entries.reduce((n, entry) => n + (Number(entry.durationSeconds) || 0), 0);
const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const notice = (text, error = false) => {
  $('time-off-status').textContent = error ? '' : text;
  $('time-off-error').textContent = error ? text : '';
  $('time-off-error').hidden = !error;
};
const setFormError = text => { $('time-off-form-error').textContent = text; $('time-off-form-error').hidden = !text; };
const repositoryOf = id => state.repositories.find(item => item.id === id);
const availableRepositories = () => state.repositories.filter(item => item.taskUrls.length);
const taskName = url => {
  const fromRecord = state.entries.find(entry => entry.taskUrl === url && entry.taskTitle);
  if (fromRecord) return fromRecord.taskTitle;
  try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).slice(-2).join('/')) || url; }
  catch { return url; }
};
const labelForRange = (start, end) => start === end ? dateLabel(start) : dateLabel(start) + ' – ' + dateLabel(end);

function renderRepositories() {
  const select = $('time-off-repository-filter'), previous = select.value;
  select.replaceChildren(new Option('All repositories', ''));
  for (const repo of state.repositories) select.append(new Option(repo.label, repo.id));
  select.value = state.repositories.some(repo => repo.id === previous) ? previous : '';
  $('new-time-off').disabled = !availableRepositories().length || !$('time-off-editor').hidden;
}
function currentGroups() {
  const selected = $('time-off-repository-filter').value;
  return state.groups.filter(group => !selected || group.destinationId === selected);
}
function groupStatus(group) {
  if (group.planned.length && group.taken.length) return 'Partly taken';
  return group.planned.length ? 'Planned' : 'Taken';
}
function cardFor(group) {
  const card = make('article', 'time-off-card');
  card.dataset.groupKey = group.key;
  const dates = group.planned.length ? group.planned : group.entries;
  const title = make('button', 'time-off-card-date', labelForRange(dates[0].entryDate, dates.at(-1).entryDate));
  title.type = 'button';
  title.addEventListener('click', () => selectDay(dates[0].entryDate));
  const copy = make('div', 'time-off-card-copy');
  copy.append(title, make('span', 'time-off-card-status', groupStatus(group)));
  const task = make('p', 'time-off-card-description', group.taskTitle || taskName(group.taskUrl));
  copy.append(task);
  if (group.description) copy.append(make('p', 'time-off-card-description', group.description));
  copy.append(make('p', 'time-off-card-meta',
    dates.length + (dates.length === 1 ? ' day · ' : ' days · ') + duration(sum(dates))
    + (group.entries.some(entry => entry._pending) ? ' · Sync pending' : '')));
  const actions = make('div', 'time-off-group-actions');
  const edit = make('button', 'time-off-secondary', group.planned.length
    ? (group.taken.length ? 'Edit remaining' : 'Edit') : 'Correct');
  edit.type = 'button';
  edit.addEventListener('click', () => openForm(group));
  const remove = make('button', 'time-off-danger', group.planned.length ? 'Delete planned' : 'Delete taken');
  remove.type = 'button';
  remove.addEventListener('click', () => openCancel(group));
  if (group.entries.some(entry => entry._pending)) {
    edit.disabled = remove.disabled = true;
    edit.title = remove.title = 'Sync the pending change before editing this time off.';
  }
  actions.append(edit, remove);
  card.append(copy, actions);
  return card;
}
function renderMy() {
  state.groups = groupTimeOffRecords(state.entries);
  const groups = currentGroups();
  for (const [id, future] of [['upcoming-time-off', true], ['past-time-off', false]]) {
    const parent = $(id); parent.replaceChildren();
    const matches = groups.filter(group => future ? group.planned.length > 0 : !group.planned.length);
    if (future) matches.sort((a, b) => a.planned[0].entryDate.localeCompare(b.planned[0].entryDate));
    if (!matches.length) parent.append(make('p', 'time-off-empty',
      future ? 'No upcoming time off.' : 'No past time off.'));
    for (const group of matches) parent.append(cardFor(group));
  }
}
function editing() { return !$('time-off-editor').hidden; }
function isOwnEntry(entry) {
  const login = state.currentUsers[entry.destinationId];
  return Boolean(login && typeof entry.user === 'string' &&
    entry.user.toLowerCase() === login.toLowerCase());
}
function effectiveTeamRecords() {
  const repository = $('time-off-repository-filter').value;
  let records = state.loadedTeamYear === state.year ? [...state.teamEntries] : [];
  records = records.filter(entry => !repository || entry.destinationId === repository);
  // My time off is projected through the pending local queue, unlike GitHub
  // reads of other teammates. Replace only destinations we successfully read.
  records = records.filter(entry =>
    !isOwnEntry(entry) || !state.myLoadedDestinations.has(entry.destinationId));
  records.push(...state.entries.filter(entry =>
    (!repository || entry.destinationId === repository) &&
    entry.entryDate?.slice(0, 4) === String(state.year)));
  if (editing()) {
    const previousIds = new Set(previousFor(state.group).map(entry => entry.id));
    records = records.filter(entry => !isOwnEntry(entry) || !previousIds.has(entry.id));
    const destinationId = $('edit-repository').value, user = state.currentUsers[destinationId];
    if ((!repository || destinationId === repository) && user) {
      records.push(...selectedDays().map(item => ({
        id: 'draft:' + item.date, destinationId, user, taskUrl: $('edit-task').value,
        entryDate: item.date, isTimeOff: true, _draft: true,
        startedAt: item.date + 'T09:00:00Z',
        endedAt: item.date + 'T23:59:59Z',
        durationSeconds: Number(item.hours) * 3600,
      })));
    }
  }
  return records;
}
function selectedDayDetails() {
  return annualTimeOffDays(effectiveTeamRecords(), state.year, state.currentUsers);
}
function avatar(login) {
  const node = make('span', 'time-off-avatar');
  node.append(make('span', 'time-off-avatar-fallback', login.slice(0, 1).toUpperCase()));
  if (/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(login)) {
    const img = document.createElement('img');
    img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
    img.src = 'https://github.com/' + encodeURIComponent(login) + '.png?size=64';
    img.addEventListener('error', () => img.remove(), { once: true });
    node.prepend(img);
  }
  return node;
}
function renderYear() {
  $('current-year-label').textContent = String(state.year);
  const grid = $('year-grid');
  grid.replaceChildren();
  const dayGroups = selectedDayDetails();
  const header = make('div', 'time-off-year-row time-off-year-days');
  header.setAttribute('role', 'row');
  const monthHeading = make('span', 'time-off-year-month');
  monthHeading.setAttribute('role', 'columnheader');
  monthHeading.textContent = 'Month';
  header.append(monthHeading);
  for (let day = 1; day <= 31; day++) {
    const cell = make('span', 'time-off-year-day-heading', String(day));
    cell.setAttribute('role', 'columnheader'); header.append(cell);
  }
  grid.append(header);
  const year = String(state.year).padStart(4, '0');
  for (let month = 1; month <= 12; month++) {
    const prefix = year + '-' + String(month).padStart(2, '0');
    const lastDay = new Date(Date.UTC(state.year, month, 0)).getUTCDate();
    const row = make('div', 'time-off-year-row');
    row.setAttribute('role', 'row');
    const monthLabel = make('span', 'time-off-year-month',
      dateAt(prefix + '-01').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }));
    monthLabel.setAttribute('role', 'rowheader'); row.append(monthLabel);
    for (let day = 1; day <= 31; day++) {
      if (day > lastDay) {
        const empty = make('span', 'time-off-year-outside');
        empty.setAttribute('aria-hidden', 'true'); row.append(empty); continue;
      }
      const date = prefix + '-' + String(day).padStart(2, '0');
      const group = dayGroups.get(date), count = group?.count ?? 0;
      const grade = count === 0 ? 0 : count === 1 ? 1 : count < 4 ? 2 : count < 7 ? 4 : 7;
      const classes = ['time-off-year-day', 'away-' + grade];
      if (date < today() && count) classes.push('past');
      if (group?.own) classes.push('mine');
      if (date === state.selectedDate) classes.push('selected');
      if (editing() && dayState.has(date)) classes.push('draft');
      const cell = make('button', classes.join(' '), count ? String(count) : '');
      cell.type = 'button'; cell.dataset.date = date;
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-pressed', String(editing() ? dayState.has(date) : date === state.selectedDate));
      cell.setAttribute('aria-label', dateLabel(date) + ': ' + count
        + (count === 1 ? ' person away' : ' people away')
        + (group?.own ? ', my time off' : '')
        + (editing() && dayState.has(date) ? ', selected for editing' : ''));
      cell.title = group?.people?.length
        ? group.people.map(person => person.user).join(', ') : 'No one away';
      cell.addEventListener('click', event => {
        if (editing()) {
          calendarMonth = date.slice(0, 7);
          chooseCalendarDate(date, event.shiftKey);
        } else selectDay(date);
      });
      row.append(cell);
    }
    grid.append(row);
  }
}
function renderInspector() {
  if (editing()) return;
  const date = state.selectedDate, group = selectedDayDetails().get(date);
  $('selected-day-label').textContent = dateLabel(date);
  $('selected-day-summary').textContent = state.teamLoading
    ? 'Loading team availability…'
    : !group?.count ? 'Nobody is away on this day.'
      : group.count + (group.count === 1 ? ' person away' : ' people away');
  const people = $('selected-day-people');
  people.replaceChildren();
  for (const person of group?.people ?? []) {
    const row = make('article', 'time-off-person-row');
    row.append(avatar(person.user));
    const copy = make('div', 'time-off-person-copy');
    const heading = make('div', 'time-off-person-heading');
    heading.append(make('strong', '', person.user));
    if (person.own) heading.append(make('span', 'time-off-person-own', 'You'));
    copy.append(heading);
    for (const entry of person.entries) {
      const label = entry._draft ? 'Preview' :
        Date.parse(entry.endedAt) > Date.now() ? 'Planned' : 'Taken';
      copy.append(make('p', 'time-off-person-entry',
        (entry.taskTitle || taskName(entry.taskUrl)) + ' · '
          + duration(entry.durationSeconds) + ' · ' + label));
      if (entry.description) copy.append(make('p', 'time-off-person-note', entry.description));
    }
    if (person.own && !person.entries.some(entry => entry._draft)) {
      const uniqueGroups = [...new Set(person.entries.map(entry =>
        state.groups.find(item => item.entries.some(rowEntry => rowEntry.id === entry.id))).filter(Boolean))];
      for (const ownGroup of uniqueGroups) {
        const edit = make('button', 'time-off-inline-edit', ownGroup.planned.length ? 'Edit my time off' : 'Correct my time off');
        edit.type = 'button';
        edit.disabled = ownGroup.entries.some(entry => entry._pending);
        edit.addEventListener('click', () => openForm(ownGroup));
        copy.append(edit);
      }
    }
    row.append(copy); people.append(row);
  }
}
function selectDay(date) {
  if (typeof date !== 'string') return;
  const year = Number(date.slice(0, 4));
  if (year !== state.year) {
    state.year = year; state.selectedDate = date;
    renderYear(); renderInspector(); void loadTeam(); return;
  }
  state.selectedDate = date;
  renderYear(); renderInspector();
}
function changeYear(year) {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return;
  const current = today();
  state.year = year;
  state.selectedDate = year === Number(current.slice(0, 4)) ? current : String(year).padStart(4, '0') + '-01-01';
  renderYear(); renderInspector(); void loadTeam();
}
function closeForm() {
  state.group = null;
  dayState.clear(); takenDates.clear(); calendarAnchor = null;
  $('time-off-editor').hidden = true;
  $('day-inspector').hidden = false;
  $('my-time-off-summary').hidden = false;
  renderRepositories();
  renderYear(); renderInspector();
}
async function loadMine({ quiet = false } = {}) {
  const request = ++state.mineRequestId;
  if (!quiet) notice('Loading your time off…');
  try {
    const result = await send({ type: 'LOAD_MY_TIME_OFF' });
    if (request !== state.mineRequestId) return;
    state.entries = result.entries || [];
    state.repositories = result.repositories || [];
    state.currentUsers = result.currentUsers || {};
    state.myLoadedDestinations = new Set((result.readStatus || [])
      .filter(item => item.status === 'ok').map(item => item.destinationId));
    // The setup response has no per-repository read status on empty installations.
    renderRepositories(); renderMy(); renderYear(); renderInspector();
    notice(result.partial ? 'Some time repositories could not be read. The calendar may be incomplete.'
      : !availableRepositories().length ? 'Configure a Time off task in Settings → Time repositories to get started.' : '');
  } catch (error) {
    if (request === state.mineRequestId) notice(error.message || 'Could not load your time off.', true);
  }
}
async function loadTeam() {
  const year = state.year, request = ++state.teamRequestId;
  state.teamLoading = true;
  state.loadedTeamYear = null; state.teamEntries = [];
  $('team-time-off-status').textContent = 'Loading team time off for ' + year + '…';
  renderYear(); renderInspector();
  try {
    const startDate = String(year).padStart(4, '0') + '-01-01';
    const endDate = String(year).padStart(4, '0') + '-12-31';
    const result = await send({ type: 'LOAD_TEAM_TIME_OFF', startDate, endDate });
    if (request !== state.teamRequestId) return;
    state.teamEntries = result.entries || [];
    state.loadedTeamYear = year;
    $('team-time-off-status').textContent = result.partial
      ? 'Some time repositories could not be read. The year may show fewer people away than expected.'
      : '';
  } catch (error) {
    if (request !== state.teamRequestId) return;
    $('team-time-off-status').textContent = error.message || 'Could not load team time off.';
  } finally {
    if (request === state.teamRequestId) {
      state.teamLoading = false;
      renderYear(); renderInspector();
    }
  }
}

function fillTaskOptions() {
  const destinationId = $('edit-repository').value;
  const repo = repositoryOf(destinationId);
  const select = $('edit-task'), previous = select.value;
  select.replaceChildren();
  for (const url of repo?.taskUrls || []) select.append(new Option(taskName(url), url));
  select.value = [...(repo?.taskUrls || [])].includes(previous) ? previous : repo?.taskUrls?.[0] || '';
  select.disabled = Boolean(state.group);
}
// The selected-day map is the source of truth across calendar months.
const selectedDays = () => [...dayState].sort(([a], [b]) => a.localeCompare(b))
  .map(([date, value]) => ({ date, ...value }));
const defaultHours = () => $('edit-hours').value.trim() === '' ? NaN : Number($('edit-hours').value);
const validHours = hours => Number.isFinite(hours) && hours >= 0 && hours <= 24
  && Number.isSafeInteger(hours * 3600);
const weekend = date => [0, 6].includes(dateAt(date).getUTCDay());
const monthDates = month => {
  const [year, number] = month.split('-').map(Number);
  const count = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => month + '-' + String(index + 1).padStart(2, '0'));
};
const shiftMonth = (month, amount) => {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1 + amount, 1, 12)).toISOString().slice(0, 7);
};
function setCalendarError(message = '') {
  $('day-preview-error').textContent = message;
  $('day-preview-error').hidden = !message;
}
function validateCalendarDays() {
  if (!dayState.size) return { days: [], error: '' };
  try {
    return { days: normalizeTimeOffDays(selectedDays().map(day => ({
      date: day.date, durationSeconds: day.hours * 3600,
    }))), error: '' };
  } catch (error) { return { days: [], error: error.message }; }
}
function updateCalendarSummary() {
  const selected = selectedDays(), validated = validateCalendarDays();
  const seconds = selected.reduce((total, day) =>
    total + (Number.isFinite(day.hours) ? day.hours * 3600 : 0), 0);
  $('day-preview-total').textContent = selected.length
    + (selected.length === 1 ? ' day · ' : ' days · ') + duration(seconds);
  $('time-off-selected-range').textContent = selected.length
    ? labelForRange(selected[0].date, selected.at(-1).date) : 'Select dates in the calendar';
  setCalendarError(validated.error);
  $('save-time-off').disabled = state.formBusy || !selected.length || Boolean(validated.error);
  $('calendar-clear-selection').disabled = !selected.length;
}
function addCalendarDates(dates) {
  const added = new Map(dayState);
  for (const date of dates) {
    if (takenDates.has(date) || added.has(date)) continue;
    added.set(date, { hours: defaultHours() });
  }
  const sorted = [...added.keys()].sort();
  if (sorted.length > 50) {
    setCalendarError('Choose no more than 50 time off days.');
    return false;
  }
  if (sorted.length > 1 && (dateAt(sorted.at(-1)) - dateAt(sorted[0])) / DAY_MS >= 500) {
    setCalendarError('Time off cannot span more than 500 days.');
    return false;
  }
  dayState.clear();
  for (const [key, value] of added) dayState.set(key, value);
  return true;
}
function datesInRange(first, last) {
  const start = first < last ? first : last, end = first < last ? last : first;
  const span = Math.round((dateAt(end) - dateAt(start)) / DAY_MS);
  if (span >= 500) { setCalendarError('Time off cannot span more than 500 days.'); return null; }
  return Array.from({ length: span + 1 }, (_, index) => addDays(start, index))
    .filter(date => !takenDates.has(date) && !weekend(date));
}
function chooseCalendarDate(date, useShift = false) {
  if (takenDates.has(date)) return;
  if (useShift && calendarAnchor) {
    const dates = datesInRange(calendarAnchor, date);
    if (!dates || !addCalendarDates(dates)) return;
  } else if (dayState.has(date)) {
    dayState.delete(date);
  } else if (!addCalendarDates([date])) return;
  calendarAnchor = date;
  renderCalendar(date);
}
function renderCalendar(focusDate = null) {
  const host = $('time-off-day-grid');
  host.replaceChildren();
  $('calendar-month-picker').value = calendarMonth;
  const dates = monthDates(calendarMonth);
  const firstWeekday = (dateAt(dates[0]).getUTCDay() + 6) % 7;
  for (let index = 0; index < firstWeekday; index++) {
    host.append(make('span', 'time-off-calendar-day-placeholder'));
  }
  for (const date of dates) {
    const selected = dayState.get(date), taken = takenDates.has(date);
    const styles = ['time-off-calendar-day', ...(weekend(date) ? ['weekend'] : []),
      ...(selected ? ['selected'] : []), ...(taken ? ['taken'] : []),
      ...(date === today() ? ['today'] : [])].join(' ');
    const cell = make('div', styles);
    const toggle = make('button', 'time-off-day-toggle', String(Number(date.slice(-2))));
    toggle.type = 'button'; toggle.dataset.date = date;
    toggle.setAttribute('aria-label', (selected ? 'Remove ' : taken ? 'Already taken ' : 'Select ') + dateLabel(date));
    toggle.setAttribute('aria-pressed', String(Boolean(selected)));
    toggle.disabled = taken;
    toggle.addEventListener('click', event => chooseCalendarDate(date, event.shiftKey));
    cell.append(toggle);
    if (selected) {
      const label = make('label', 'time-off-calendar-hours');
      const hours = document.createElement('input');
      hours.type = 'number'; hours.min = '0'; hours.max = '24'; hours.step = '0.25';
      hours.value = String(selected.hours);
      hours.setAttribute('aria-label', 'Hours on ' + dateLabel(date));
      hours.addEventListener('input', () => {
        selected.hours = hours.value.trim() === '' ? NaN : Number(hours.value);
        hours.setAttribute('aria-invalid', String(!validHours(selected.hours)));
        updateCalendarSummary();
      });
      label.append(hours, make('span', '', 'h'));
      cell.append(label);
    } else if (taken) {
      cell.append(make('span', 'time-off-calendar-taken', 'Taken'));
    }
    host.append(cell);
  }
  updateCalendarSummary();
  if (focusDate) host.querySelector('button[data-date="' + focusDate + '"]')?.focus();
}
function previousFor(group) {
  if (!group) return [];
  const affected = group.planned.length ? group.planned : group.entries;
  return affected.map(entry => ({
    id: entry.id, date: entry.entryDate, startedAt: entry.startedAt,
    endedAt: entry.endedAt, updatedAt: entry.updatedAt,
  }));
}
function openForm(group = null) {
  if (!availableRepositories().length) { notice('Configure your time off tasks in Settings first.', true); return; }
  state.group = group;
  dayState.clear(); takenDates.clear();
  calendarAnchor = null;
  setFormError('');
  $('time-off-dialog-title').textContent = group ? (group.planned.length ? 'Edit time off' : 'Correct past time off') : 'Add time off';
  $('save-time-off').textContent = group ? 'Save changes' : 'Add time off';
  const select = $('edit-repository'); select.replaceChildren();
  const repositories = availableRepositories();
  for (const repo of repositories) select.append(new Option(repo.label, repo.id));
  const preferred = group?.destinationId || $('time-off-repository-filter').value;
  select.value = repositories.some(repo => repo.id === preferred) ? preferred : repositories[0].id;
  select.disabled = Boolean(group);
  fillTaskOptions();
  if (group) $('edit-task').value = group.taskUrl;
  $('edit-description').value = group?.description || '';
  const old = group ? (group.planned.length ? group.planned : group.entries) : [];
  const first = old[0];
  $('edit-hours').value = String(first ? first.durationSeconds / 3600 : 8);
  for (const entry of old) {
    dayState.set(entry.entryDate, { hours: entry.durationSeconds / 3600 });
  }
  if (group?.planned.length && group.taken.length) {
    for (const entry of group.taken) takenDates.add(entry.entryDate);
  }
  calendarMonth = (first?.entryDate || today()).slice(0, 7);
  $('edit-taken-note').hidden = !takenDates.size;
  renderCalendar();
  $('time-off-dialog').showModal();
}
function plannedDaysToSave() {
  return normalizeTimeOffDays(selectedDays().map(day => ({
    date: day.date, durationSeconds: day.hours * 3600,
  })));
}
async function saveForm(event) {
  event.preventDefault();
  if (state.formBusy) return;
  let days;
  try { days = plannedDaysToSave(); } catch (error) { setFormError(error.message); return; }
  const taskUrl = $('edit-task').value;
  if (!taskUrl) { setFormError('Choose a time off task.'); return; }
  const previous = previousFor(state.group);
  state.formBusy = true; $('save-time-off').disabled = true; setFormError('');
  try {
    const result = await send({ type: 'SAVE_TIME_OFF', destinationId: $('edit-repository').value,
      taskUrl, taskTitle: taskName(taskUrl), description: $('edit-description').value.trim(),
      groupId: state.group?.groupId ?? null, timezone: state.group?.entries[0]?.timezone ?? null,
      previous, days });
    $('time-off-dialog').close();
    const prevIds = new Set(previous.map(row => row.id));
    state.entries = [...state.entries.filter(row => !prevIds.has(row.id)),
      ...(result.entries || []).map(entry => ({
        ...entry, isTimeOff: true, isPlannedTimeOff: Date.parse(entry.endedAt) > Date.now(),
        destinationId: result.destinationId, timeRepository: repositoryOf(result.destinationId)?.label || '',
        user: state.currentUsers[result.destinationId] || '',
      }))];
    renderMy();
    notice('Saved locally. Your team will see the change after GitHub synchronization.');
    void loadMine({ quiet: true });
    if (state.view === 'team') void loadTeam();
  } catch (error) { setFormError(error.message); }
  finally { state.formBusy = false; updateCalendarSummary(); }
}
function openCancel(group) {
  state.cancelGroup = group;
  const affected = group.planned.length ? group.planned : group.entries;
  $('time-off-cancel-message').textContent = 'Remove ' + affected.length
    + (affected.length === 1 ? ' day' : ' days') + ' (' + duration(sum(affected))
    + ') for ' + (group.taskTitle || taskName(group.taskUrl)) + '?'
    + (group.taken.length && group.planned.length ? ' Completed days will be preserved.' : '');
  $('time-off-cancel-error').hidden = true;
  $('time-off-cancel-dialog').showModal();
}
async function confirmCancel() {
  const group = state.cancelGroup;
  if (!group) return;
  const previous = previousFor(group), button = $('confirm-cancel-time-off');
  button.disabled = true; $('time-off-cancel-error').hidden = true;
  try {
    const result = await send({ type: 'SAVE_TIME_OFF', destinationId: group.destinationId,
      taskUrl: group.taskUrl, taskTitle: group.taskTitle, description: group.description,
      groupId: group.groupId ?? null, timezone: group.entries[0]?.timezone ?? null,
      previous, days: [] });
    $('time-off-cancel-dialog').close();
    const ids = new Set(previous.map(row => row.id));
    state.entries = state.entries.filter(row => !ids.has(row.id));
    renderMy();
    notice('Time off cancellation saved locally. Your team will see it after synchronization.');
    void loadMine({ quiet: true });
    if (state.view === 'team') void loadTeam();
    state.cancelGroup = null;
  } catch (error) {
    $('time-off-cancel-error').textContent = error.message || 'Could not cancel time off.';
    $('time-off-cancel-error').hidden = false;
  } finally { button.disabled = false; }
}

$('view-my').addEventListener('click', () => setView('my'));
$('view-team').addEventListener('click', () => setView('team'));
$('new-time-off').addEventListener('click', () => openForm());
$('refresh-time-off').addEventListener('click', () => { void loadMine(); if (state.view === 'team') void loadTeam(); });
$('time-off-repository-filter').addEventListener('change', () => {
  renderMy(); if (state.view === 'team') renderTeam();
});
$('previous-week').addEventListener('click', () => { state.week = addDays(state.week, -7); void loadTeam(); });
$('next-week').addEventListener('click', () => { state.week = addDays(state.week, 7); void loadTeam(); });
$('this-week').addEventListener('click', () => { state.week = monday(today()); void loadTeam(); });
$('close-time-off').addEventListener('click', () => $('time-off-dialog').close());
$('cancel-time-off-form').addEventListener('click', () => $('time-off-dialog').close());
$('edit-repository').addEventListener('change', fillTaskOptions);
$('calendar-previous-month').addEventListener('click', () => {
  calendarMonth = shiftMonth(calendarMonth, -1); renderCalendar();
});
$('calendar-next-month').addEventListener('click', () => {
  calendarMonth = shiftMonth(calendarMonth, 1); renderCalendar();
});
$('calendar-month-picker').addEventListener('change', () => {
  if (/^\d{4}-(?:0[1-9]|1[0-2])$/.test($('calendar-month-picker').value)) {
    calendarMonth = $('calendar-month-picker').value; renderCalendar();
  }
});
$('calendar-clear-selection').addEventListener('click', () => {
  dayState.clear(); calendarAnchor = null;
  renderCalendar();
});
$('edit-hours').addEventListener('input', updateCalendarSummary);
form.addEventListener('submit', saveForm);
$('keep-time-off').addEventListener('click', () => $('time-off-cancel-dialog').close());
$('confirm-cancel-time-off').addEventListener('click', confirmCancel);
state.week = monday(today());
void loadMine();
