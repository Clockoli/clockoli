import { groupTimeOffRecords, normalizeTimeOffDays } from '../domain/time-off.js';

const $ = id => document.getElementById(id);
const DAY_MS = 86400000;
const state = { entries: [], repositories: [], currentUsers: {}, groups: [], teamEntries: [],
  view: 'my', week: '', loading: false, group: null, formBusy: false, cancelGroup: null };
const form = $('time-off-form');
const dayState = new Map(), excluded = new Set();
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
const unique = array => [...new Set(array)];
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
  $('new-time-off').disabled = !availableRepositories().length;
}
function currentGroups() {
  const selected = $('time-off-repository-filter').value;
  return state.groups.filter(group => !selected || group.destinationId === selected);
}
function groupStatus(group) {
  if (group.planned.length && group.taken.length) return 'Partially taken';
  return group.planned.length ? 'Planned' : 'Taken';
}
function cardFor(group, future) {
  const card = make('article', 'time-off-card');
  card.dataset.groupKey = group.key;
  const body = make('div', 'time-off-card-copy');
  const dates = future && group.taken.length ? group.planned : group.entries;
  body.append(make('div', 'time-off-card-title', labelForRange(dates[0].entryDate, dates.at(-1).entryDate)));
  body.append(make('div', 'time-off-card-description', group.taskTitle || taskName(group.taskUrl)));
  if (group.description) body.append(make('p', 'time-off-card-description', group.description));
  const details = make('div', 'time-off-card-meta');
  const hours = duration(sum(dates));
  details.append(make('span', '', dates.length + (dates.length === 1 ? ' day · ' : ' days · ') + hours));
  details.append(make('span', '', repositoryOf(group.destinationId)?.label || group.repository));
  if (group.entries.some(entry => entry._pending)) details.append(make('span', '', 'Sync pending'));
  body.append(details);
  const status = make('span', 'time-off-card-status', groupStatus(group));
  const actions = make('div', 'time-off-group-actions');
  const edit = make('button', '', future && group.taken.length ? 'Edit remaining' : future ? 'Edit' : 'Correct');
  edit.type = 'button'; edit.addEventListener('click', () => openForm(group));
  const cancel = make('button', 'time-off-danger', group.taken.length && future ? 'Cancel remaining' : 'Cancel');
  cancel.type = 'button'; cancel.addEventListener('click', () => openCancel(group));
  if (group.entries.some(entry => entry._pending)) {
    edit.disabled = true; cancel.disabled = true;
    edit.title = cancel.title = 'Sync the previous change before editing this time off.';
  }
  actions.append(edit, cancel);
  card.append(body, status, actions);
  return card;
}
function renderMy() {
  const groups = groupTimeOffRecords(state.entries);
  state.groups = groups;
  for (const [id, future] of [['upcoming-time-off', true], ['past-time-off', false]]) {
    const parent = $(id); parent.replaceChildren();
    const matches = currentGroups().filter(group => future ? group.planned.length > 0 : !group.planned.length);
    if (!matches.length) parent.append(make('div', 'time-off-empty',
      future ? 'No upcoming time off. Use Add time off to plan an absence.' : 'No past time off in the loaded period.'));
    for (const group of matches) parent.append(cardFor(group, future));
  }
}
function renderTeam() {
  const start = state.week, end = addDays(start, 6);
  $('current-week-label').textContent = labelForRange(start, end);
  const table = $('team-time-off-table');
  table.replaceChildren();
  const headings = make('thead'), heading = make('tr');
  for (const value of ['Person', ...Array.from({ length: 7 }, (_, offset) => dayLabel(addDays(start, offset)))]) {
    const th = make('th', '', value); th.scope = 'col'; heading.append(th);
  }
  headings.append(heading); table.append(headings);
  const all = state.teamEntries.filter(entry => !$('time-off-repository-filter').value
    || entry.destinationId === $('time-off-repository-filter').value);
  const people = new Map();
  for (const entry of all) {
    const key = entry.destinationId + ':' + entry.user;
    if (!people.has(key)) people.set(key, { user: entry.user, destinationId: entry.destinationId, entries: [] });
    people.get(key).entries.push(entry);
  }
  const tbody = make('tbody');
  for (const person of [...people.values()].sort((a, b) => a.user.localeCompare(b.user))) {
    const row = make('tr'), name = make('th', '', person.user); name.scope = 'row';
    const repo = repositoryOf(person.destinationId)?.label;
    if (repo && !($('time-off-repository-filter').value)) name.title = repo;
    row.append(name);
    for (let i = 0; i < 7; i++) {
      const day = addDays(start, i), td = make('td');
      const entries = person.entries.filter(entry => entry.entryDate === day);
      if (entries.length) {
        const own = person.user === state.currentUsers[person.destinationId];
        const cell = make('button', 'time-off-calendar-slot' + (entries.some(entry => entry.isPlannedTimeOff) ? ' planned' : '') + (own ? ' own' : ''),
          duration(sum(entries)));
        cell.type = 'button';
        cell.title = entries.map(entry => [entry.taskTitle || taskName(entry.taskUrl), entry.description].filter(Boolean).join(' · ')).join('\n');
        cell.setAttribute('aria-label', person.user + ': ' + duration(sum(entries)) + ' time off on ' + day);
        cell.addEventListener('click', () => showTeamDetail(person, entries));
        td.append(cell);
      }
      row.append(td);
    }
    tbody.append(row);
  }
  if (!people.size) {
    const row = make('tr'), empty = make('td', '', 'No time off scheduled this week');
    empty.colSpan = 8; row.append(empty); tbody.append(row);
  }
  table.append(tbody);
}
function showTeamDetail(person, entries) {
  const dialog = make('dialog', 'time-off-detail');
  const title = make('h2', '', person.user + ' · ' + dateLabel(entries[0].entryDate));
  const info = make('p', '', entries.map(item =>
    (item.taskTitle || taskName(item.taskUrl)) + ' · ' + duration(item.durationSeconds)
    + (item.description ? ' · ' + item.description : '')).join('\n'));
  info.style.whiteSpace = 'pre-wrap';
  const close = make('button', 'time-off-secondary', 'Close'); close.type = 'button';
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  dialog.append(title, info);
  if (person.user === state.currentUsers[person.destinationId]) {
    const group = state.groups.find(item => item.entries.some(row => row.id === entries[0].id));
    if (group) {
      const edit = make('button', 'time-off-primary', 'Edit my time off');
      edit.type = 'button'; edit.addEventListener('click', () => { dialog.close(); setView('my'); openForm(group); });
      dialog.append(edit);
    }
  }
  dialog.append(close); document.body.append(dialog); dialog.showModal();
}
function setView(name) {
  state.view = name;
  $('view-my').setAttribute('aria-selected', String(name === 'my'));
  $('view-team').setAttribute('aria-selected', String(name === 'team'));
  $('my-time-off').hidden = name !== 'my'; $('team-time-off').hidden = name !== 'team';
  if (name === 'team') void loadTeam();
}
async function loadMine({ quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (!quiet) notice('Loading your time off…');
  try {
    const now = today();
    const result = await send({ type: 'LOAD_MY_TIME_OFF', startDate: addDays(now, -365), endDate: addDays(now, 365) });
    state.entries = result.entries || []; state.repositories = result.repositories || [];
    state.currentUsers = result.currentUsers || {};
    renderRepositories(); renderMy();
    notice(result.partial ? 'Some time repositories could not be read. The list may be incomplete.'
      : !availableRepositories().length ? 'Configure a time off task in Settings → Time repositories to get started.' : '');
  } catch (error) { notice(error.message || 'Could not load your time off.', true); }
  finally { state.loading = false; }
}
async function loadTeam() {
  const week = state.week;
  $('team-time-off-status').textContent = 'Loading team time off…';
  try {
    const result = await send({ type: 'LOAD_TEAM_TIME_OFF', startDate: week, endDate: addDays(week, 6) });
    if (state.week !== week || state.view !== 'team') return;
    state.teamEntries = result.entries || [];
    $('team-time-off-status').textContent = result.partial ? 'Some repositories could not be read. The calendar may be incomplete.' : '';
    renderTeam();
  } catch (error) { $('team-time-off-status').textContent = error.message || 'Could not load the team calendar.'; }
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
const formDays = () => {
  const start = $('edit-from').value, end = $('edit-to').value;
  if (!start || !end || end < start) return { error: 'Select a valid date range.', days: [] };
  const span = Math.round((dateAt(end) - dateAt(start)) / DAY_MS);
  if (span > 120) return { error: 'Choose a shorter date range (up to 121 calendar days).', days: [] };
  const days = [];
  const fallbackHours = Number($('edit-hours').value);
  const fallbackStart = $('edit-start-time').value;
  for (let offset = 0; offset <= span; offset++) {
    const date = addDays(start, offset), dow = dateAt(date).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    if (weekend && !$('include-weekends').checked) continue;
    const custom = dayState.get(date);
    days.push({ date, included: !excluded.has(date), hours: custom?.hours ?? fallbackHours,
      startTime: custom?.startTime ?? fallbackStart });
  }
  return { days, error: '' };
};
function renderDays() {
  const result = formDays(), host = $('day-preview');
  host.replaceChildren();
  $('day-preview-error').textContent = result.error;
  $('day-preview-error').hidden = !result.error;
  let selected = 0, seconds = 0;
  for (const day of result.days) {
    const row = make('div', 'time-off-day-row');
    const choice = make('label');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = day.included;
    checkbox.setAttribute('aria-label', 'Include ' + dateLabel(day.date));
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) excluded.delete(day.date); else excluded.add(day.date);
      renderDays();
    });
    choice.append(checkbox, make('span', '', dayLabel(day.date)));
    const hours = document.createElement('input'); hours.type = 'number'; hours.min = '0'; hours.max = '24';
    hours.step = '0.25'; hours.value = String(day.hours); hours.disabled = !day.included;
    hours.setAttribute('aria-label', 'Hours on ' + dateLabel(day.date));
    hours.addEventListener('change', () => {
      dayState.set(day.date, { hours: Number(hours.value), startTime: day.startTime }); renderDays();
    });
    row.append(choice, hours); host.append(row);
    if (day.included) { selected++; seconds += day.hours * 3600; }
  }
  $('day-preview-total').textContent = selected + (selected === 1 ? ' day · ' : ' days · ') + duration(seconds);
  $('save-time-off').disabled = Boolean(result.error || !selected || selected > 50 || !Number.isSafeInteger(seconds));
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
  dayState.clear(); excluded.clear();
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
  const old = group ? (group.planned.length ? group.planned : group.entries) : [];
  const start = old[0]?.entryDate || today();
  const end = old.at(-1)?.entryDate || start;
  $('edit-from').value = start; $('edit-to').value = end;
  $('edit-description').value = group?.description || '';
  $('include-weekends').checked = old.some(entry => [0, 6].includes(dateAt(entry.entryDate).getUTCDay()));
  const first = old[0], firstStart = first ? new Date(first.startedAt) : null;
  const time = firstStart ? String(firstStart.getHours()).padStart(2, '0') + ':'
    + String(firstStart.getMinutes()).padStart(2, '0') : '09:00';
  $('edit-start-time').value = time;
  $('edit-hours').value = String(first ? first.durationSeconds / 3600 : 8);
  for (const entry of old) {
    const date = new Date(entry.startedAt);
    dayState.set(entry.entryDate, { hours: entry.durationSeconds / 3600,
      startTime: String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0') });
  }
  if (group) for (let day = start; day <= end; day = addDays(day, 1)) {
    const dow = dateAt(day).getUTCDay();
    if (($('include-weekends').checked || ![0, 6].includes(dow)) && !old.some(entry => entry.entryDate === day)) excluded.add(day);
  }
  $('edit-taken-note').hidden = !group?.taken.length || !group?.planned.length;
  renderDays();
  $('time-off-dialog').showModal();
}
function plannedDaysToSave() {
  const result = formDays();
  if (result.error) throw new Error(result.error);
  const days = result.days.filter(day => day.included).map(day => {
    if (!Number.isFinite(day.hours) || day.hours < 0 || day.hours > 24
        || !Number.isSafeInteger(day.hours * 3600)) throw new Error('Hours must be between 0 and 24.');
    return { date: day.date, startTime: day.startTime, durationSeconds: day.hours * 3600 };
  });
  return normalizeTimeOffDays(days);
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
      groupId: state.group?.groupId ?? null, previous, days });
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
  finally { state.formBusy = false; $('save-time-off').disabled = false; }
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
      groupId: group.groupId ?? null, previous, days: [] });
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
for (const id of ['edit-from', 'edit-to', 'edit-hours', 'edit-start-time', 'include-weekends']) {
  $(id).addEventListener('change', renderDays);
}
form.addEventListener('submit', saveForm);
$('keep-time-off').addEventListener('click', () => $('time-off-cancel-dialog').close());
$('confirm-cancel-time-off').addEventListener('click', confirmCancel);
state.week = monday(today());
void loadMine();
