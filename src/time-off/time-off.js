import { groupTimeOffRecords, normalizeTimeOffDays, timeOffGroupId } from '../domain/time-off.js';
import { annualTimeOffDays, yearlyTimeOffTotals, timeOffUserLogins } from '../domain/time-off-year.js';

const $ = id => document.getElementById(id);
const DAY_MS = 86400000;
const state = { entries: [], repositories: [], currentUsers: {}, groups: [], teamEntries: [],
  year: Number(new Date().getFullYear()), selectedDate: '', loadedTeamYear: null,
  mineRequestId: 0, teamRequestId: 0, myLoadedDestinations: new Set(), teamIdentity: null,
  teamLoading: false, teamIncomplete: true, teamYears: new Map(),
  formBusy: false, cancelEntry: null, cancelEntries: null, deletionBusy: false,
  myTimeOffDates: new Set(), myEntriesByKey: new Map(),
  selectedUser: '', userCandidates: [], suggestionIndex: -1 };
const form = $('time-off-form');
const selectedDates = new Set();
let selectionAnchor = null, pinDayUntilLeave = false;
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

function selectedMyEntries() {
  const repository = $('time-off-repository-filter').value;
  const selectedUser = state.selectedUser.toLowerCase();
  return [...state.myEntriesByKey.values()].filter(entry =>
    selectedDates.has(entry.entryDate)
    && (!repository || entry.destinationId === repository)
    && (!selectedUser || selectedUser === entry.user.toLowerCase()));
}
// Adding PTO is date-based: selecting a day with my existing PTO can be used
// for deletion, but must never count towards another Add operation. Check all
// my time repositories, not only the currently displayed repository or user.
function datesToAdd() {
  return [...selectedDates].filter(date => !state.myTimeOffDates.has(date)).sort();
}
function updateAddButton() {
  const count = datesToAdd().length, configured = availableRepositories().length > 0;
  const add = $('new-time-off');
  add.textContent = count ? 'Add time off (' + count + ' days)' : 'Add time off';
  add.disabled = count === 0 || !configured || $('time-off-dialog').open || state.deletionBusy;
  $('add-time-off-help').title = !configured
    ? 'Configure Time off tasks under Settings → Time repositories first.'
    : !selectedDates.size ? 'Select one or more days in the calendar to add time off.'
      : !count ? 'All selected days already have your time off. Select an available day to add time off.'
        : 'Add time off for ' + count + (count === 1 ? ' available day.' : ' available days.')
          + (count < selectedDates.size ? ' Days with your existing time off are excluded.' : '');
  const own = selectedMyEntries();
  const deleteDays = new Set(own.map(entry => entry.entryDate)).size;
  const remove = $('delete-selected-time-off');
  remove.hidden = deleteDays === 0;
  remove.textContent = 'Delete time off (' + deleteDays + ' days)';
  remove.disabled = state.deletionBusy || own.length > 200
    || $('time-off-cancel-dialog').open;
  remove.title = own.length > 200
    ? 'Too many entries to delete at once. Select fewer days.'
    : 'Delete your own time off for the selected dates. Changes are saved locally first.';
}
function renderRepositories() {
  const select = $('time-off-repository-filter'), previous = select.value;
  const repositories = availableRepositories();
  select.replaceChildren(new Option('All repositories', ''));
  for (const repo of repositories) select.append(new Option(repo.label, repo.id));
  select.value = repositories.some(repo => repo.id === previous) ? previous : '';
  $('time-off-repository-filter-field').hidden = repositories.length <= 1;
  updateAddButton();
}
function currentGroups() {
  const selected = $('time-off-repository-filter').value;
  return state.groups.filter(group => !selected || group.destinationId === selected);
}
function cardFor(group) {
  const card = make('article', 'time-off-card');
  card.dataset.groupKey = group.key;
  const upcoming = group.planned;
  const date = make('button', 'time-off-card-date',
    labelForRange(upcoming[0].entryDate, upcoming.at(-1).entryDate));
  date.type = 'button';
  date.addEventListener('click', () => selectDay(upcoming[0].entryDate));
  card.append(date, make('span', 'time-off-card-meta',
    upcoming.length + (upcoming.length === 1 ? ' day · ' : ' days · ')
    + duration(sum(upcoming)) + (group.entries.some(entry => entry._pending)
      ? ' · Sync pending' : '')));
  return card;
}
function deleteIconAction(title, action) {
  const button = make('button', 'time-off-icon-action');
  button.type = 'button';
  button.setAttribute('aria-label', title);
  button.title = title;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d',
    'M5.5 1a1 1 0 0 0-1 1v1H2a.75.75 0 0 0 0 1.5h.75l.55 8.05A2 2 0 0 0 5.3 14.5h5.4a2 2 0 0 0 2-1.95l.55-8.05H14a.75.75 0 0 0 0-1.5h-2.5V2a1 1 0 0 0-1-1h-5Zm.5 2v-.5h4V3H6Zm-1.75 1.5h7.5l-.54 7.95a.5.5 0 0 1-.5.55H5.3a.5.5 0 0 1-.5-.55l-.55-7.95Z');
  svg.append(path);
  button.append(svg);
  button.addEventListener('click', action);
  return button;
}
function renderMy() {
  state.myEntriesByKey = new Map(state.entries
    .filter(entry => entry.isTimeOff && isOwnEntry(entry))
    .map(entry => [entry.destinationId + '\\u0000' + entry.id, entry]));
  state.myTimeOffDates = new Set([...state.myEntriesByKey.values()].map(entry => entry.entryDate));
  state.groups = groupTimeOffRecords(state.entries);
  const host = $('upcoming-time-off');
  host.replaceChildren();
  const groups = currentGroups().filter(group => group.planned.length)
    .sort((a, b) => a.planned[0].entryDate.localeCompare(b.planned[0].entryDate));
  if (!groups.length) host.append(make('p', 'time-off-empty', 'No upcoming time off.'));
  for (const group of groups) host.append(cardFor(group));
}
function isOwnEntry(entry) {
  const login = state.currentUsers[entry.destinationId];
  return Boolean(login && typeof entry.user === 'string' &&
    entry.user.toLowerCase() === login.toLowerCase());
}
function effectiveTeamRecords() {
  const repository = $('time-off-repository-filter').value;
  let records = state.loadedTeamYear === state.year ? [...state.teamEntries] : [];
  records = records.filter(entry => !repository || entry.destinationId === repository);
  records = records.filter(entry =>
    !isOwnEntry(entry) || !state.myLoadedDestinations.has(entry.destinationId));
  records.push(...state.entries.filter(entry =>
    (!repository || entry.destinationId === repository)
    && entry.entryDate?.slice(0, 4) === String(state.year)));
  return records;
}
function selectedDayDetails() {
  const records = effectiveTeamRecords();
  state.userCandidates = timeOffUserLogins(records, state.currentUsers);
  updateYearStats(records);
  if (!$('time-off-user-suggestions').hidden) renderUserSuggestions();
  const selected = state.selectedUser.toLowerCase();
  return annualTimeOffDays(selected
    ? records.filter(entry => entry.user?.toLowerCase() === selected)
    : records, state.year, state.currentUsers);
}
function updateYearStats(records) {
  const available = state.selectedUser
    ? state.loadedTeamYear === state.year
    : state.myLoadedDestinations.size > 0;
  const stats = available
    ? yearlyTimeOffTotals(records, state.year, state.selectedUser, state.currentUsers)
    : null;
  $('time-off-stats-subject').textContent = state.selectedUser
    ? '@' + state.selectedUser : 'My time off';
  $('time-off-taken-days').textContent = stats ? String(stats.taken) : '—';
  $('time-off-planned-days').textContent = stats ? String(stats.planned) : '—';
  $('time-off-taken-unit').textContent = stats?.taken === 1 ? 'day' : 'days';
  $('time-off-planned-unit').textContent = stats?.planned === 1 ? 'day' : 'days';
}

function closeUserSuggestions() {
  $('time-off-user-suggestions').hidden = true;
  $('time-off-user-search').setAttribute('aria-expanded', 'false');
  $('time-off-user-search').removeAttribute('aria-activedescendant');
  state.suggestionIndex = -1;
}
function syncUserClearButton() {
  $('clear-time-off-user').hidden = !$('time-off-user-search').value.trim() && !state.selectedUser;
}
function setSuggestionIndex(index) {
  const buttons = [...$('time-off-user-suggestions').querySelectorAll('[role="option"]')];
  if (!buttons.length) return;
  state.suggestionIndex = (index + buttons.length) % buttons.length;
  for (const [i, button] of buttons.entries()) button.classList.toggle('active', i === state.suggestionIndex);
  $('time-off-user-search').setAttribute('aria-activedescendant', buttons[state.suggestionIndex].id);
  buttons[state.suggestionIndex].scrollIntoView({ block: 'nearest' });
}
function renderUserSuggestions() {
  const host = $('time-off-user-suggestions'), input = $('time-off-user-search');
  const query = input.value.trim().replace(/^@/, '').toLowerCase();
  const matches = state.userCandidates.filter(login => login.toLowerCase().includes(query)).slice(0, 8);
  host.replaceChildren();
  state.suggestionIndex = -1;
  input.removeAttribute('aria-activedescendant');
  if (!matches.length) {
    host.append(make('p', 'time-off-user-no-results', query
      ? 'No matching GitHub users in this year.' : 'No GitHub users in this calendar yet.'));
  }
  for (const [index, login] of matches.entries()) {
    const option = make('button', 'time-off-user-option');
    option.id = 'time-off-user-option-' + index;
    option.type = 'button';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(state.selectedUser.toLowerCase() === login.toLowerCase()));
    option.append(avatar(login), make('span', '', '@' + login));
    option.addEventListener('pointerdown', event => event.preventDefault());
    option.addEventListener('click', () => selectUser(login));
    host.append(option);
  }
  host.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}
function selectUser(login) {
  state.selectedUser = login;
  $('time-off-user-search').value = login;
  closeUserSuggestions();
  syncUserClearButton();
  renderYear();
  renderInspector();
}
function clearUserFilter() {
  const hadFilter = Boolean(state.selectedUser);
  state.selectedUser = '';
  $('time-off-user-search').value = '';
  closeUserSuggestions();
  syncUserClearButton();
  if (hadFilter) { renderYear(); renderInspector(); }
}
function handleUserSearch() {
  const input = $('time-off-user-search');
  const value = input.value.trim().replace(/^@/, '').toLowerCase();
  if (state.selectedUser && value !== state.selectedUser.toLowerCase()) {
    state.selectedUser = '';
    renderYear();
    renderInspector();
  }
  syncUserClearButton();
  renderUserSuggestions();
}
function handleUserSearchKeydown(event) {
  const input = $('time-off-user-search'), host = $('time-off-user-suggestions');
  if (event.key === 'Escape') { closeUserSuggestions(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
  if (host.hidden) renderUserSuggestions();
  const options = [...host.querySelectorAll('[role="option"]')];
  if (!options.length) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    setSuggestionIndex(state.suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1));
  } else {
    event.preventDefault();
    if (state.suggestionIndex >= 0) options[state.suggestionIndex].click();
    else {
      const exact = options.find(option => option.textContent.toLowerCase()
        === '@' + input.value.trim().replace(/^@/, '').toLowerCase());
      if (exact) exact.click();
      else if (options.length === 1) options[0].click();
    }
  }
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
  state.dayDetails = dayGroups;
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
      if (date < today()) classes.push('past');
      if (group?.own) classes.push('mine');
      if (date === state.selectedDate) classes.push('selected');
      if (selectedDates.has(date)) classes.push('pick');
      const cell = make('button', classes.join(' '));
      if (count === 1 && group?.people?.[0]) {
        cell.append(avatar(group.people[0].user));
      } else if (count > 1) cell.textContent = String(count);
      cell.type = 'button'; cell.dataset.date = date;
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-pressed', String(selectedDates.has(date)));
      cell.setAttribute('aria-label', dateLabel(date) + ': ' + count
        + (count === 1 ? ' person away' : ' people away')
        + (group?.own ? ', my time off' : '')
        + (selectedDates.has(date) ? ', selected for a time off action' : ''));
      cell.addEventListener('mouseenter', () => {
        if (!pinDayUntilLeave) selectDay(date);
      });
      cell.addEventListener('focus', () => {
        if (!pinDayUntilLeave) selectDay(date);
      });
      cell.addEventListener('click', event => {
        event.preventDefault();
        pinDayUntilLeave = true;
        selectDay(date);
        toggleDateSelection(date, event.shiftKey);
      });
      row.append(cell);
    }
    grid.append(row);
  }
  updateAddButton();
}
function renderInspector() {
  const date = state.selectedDate, group = state.dayDetails?.get(date);
  $('selected-day-label').textContent = dateLabel(date);
  $('selected-day-summary').textContent = state.teamLoading
    ? 'Loading team availability…'
    : !group?.count ? (state.teamIncomplete
      ? 'No known absences (team data is incomplete).'
      : state.selectedUser ? 'No time off for @' + state.selectedUser + ' on this day.'
        : 'Nobody is away on this day.')
      : group.count + (group.count === 1 ? ' person away' : ' people away');
  const host = $('selected-day-people');
  host.replaceChildren();
  for (const person of group?.people ?? []) {
    for (const entry of person.entries) {
      const row = make('article', 'time-off-person-row');
      row.append(avatar(person.user));
      const copy = make('div', 'time-off-person-copy');
      const name = make('strong', 'time-off-person-name', person.user);
      copy.append(name);
      if (entry.description) copy.append(make('p', 'time-off-person-note', entry.description));
      const actions = make('div', 'time-off-person-actions');
      actions.append(make('span', 'time-off-person-hours', duration(entry.durationSeconds)));
      const ownEntry = state.myEntriesByKey.get(entry.destinationId + '\\u0000' + entry.id);
      if (ownEntry) {
        const remove = deleteIconAction('Delete my time off on ' + dateLabel(entry.entryDate),
          () => openDeleteEntry(ownEntry));
        actions.append(remove);
      }
      row.append(copy, actions);
      host.append(row);
    }
  }
}
function highlightSelectedDay(previous) {
  for (const date of new Set([previous, state.selectedDate])) {
    const cell = $('year-grid').querySelector('button[data-date="' + date + '"]');
    if (!cell) continue;
    cell.classList.toggle('selected', date === state.selectedDate);
  }
}
function selectDay(date) {
  if (typeof date !== 'string') return;
  const year = Number(date.slice(0, 4));
  if (year !== state.year) {
    state.year = year; state.selectedDate = date;
    if (!activateTeamYear(year)) { renderYear(); renderInspector(); void loadTeam(); }
    return;
  }
  if (date === state.selectedDate) return;
  const previous = state.selectedDate;
  state.selectedDate = date;
  highlightSelectedDay(previous);
  renderInspector();
}
function changeYear(year) {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return;
  const previousYear = state.year, previousDate = state.selectedDate, current = today();
  state.year = year;
  pinDayUntilLeave = false;
  state.selectedDate = year === Number(current.slice(0, 4))
    ? current : String(year).padStart(4, '0') + '-01-01';
  if (year === previousYear) {
    highlightSelectedDay(previousDate); renderInspector(); return;
  }
  if (!activateTeamYear(year)) { renderYear(); renderInspector(); void loadTeam(); }
}
async function loadMine({ quiet = false } = {}) {
  const request = ++state.mineRequestId;
  if (!quiet) notice('Loading your time off…');
  try {
    const result = await send({ type: 'LOAD_MY_TIME_OFF' });
    if (request !== state.mineRequestId) return;
    const identity = JSON.stringify({
      repositories: (result.repositories || []).map(repo => [
        repo.id, [...(repo.taskUrls || [])].sort(),
      ]).sort((a, b) => a[0].localeCompare(b[0])),
      users: Object.entries(result.currentUsers || {}).sort(([a], [b]) => a.localeCompare(b)),
    });
    const changedIdentity = !result.partial && state.teamIdentity !== null && state.teamIdentity !== identity;
    if (!result.partial) state.teamIdentity = identity;
    if (changedIdentity) {
      state.teamYears.clear(); state.teamEntries = []; state.loadedTeamYear = null;
      state.teamIncomplete = true;
      state.selectedUser = '';
      $('time-off-user-search').value = '';
      closeUserSuggestions();
      syncUserClearButton();
    }
    state.entries = result.entries || [];
    state.repositories = result.repositories || [];
    state.currentUsers = result.currentUsers || {};
    state.myLoadedDestinations = new Set((result.readStatus || [])
      .filter(item => item.status === 'ok').map(item => item.destinationId));
    renderRepositories(); renderMy(); renderYear(); renderInspector();
    if (changedIdentity) void loadTeam({ refresh: true });
    if (result.partial) notice('Some time repositories could not be read. The calendar may be incomplete.');
    else if (!availableRepositories().length) notice('Configure a Time off task in Settings → Time repositories to get started.');
    else if (!quiet) notice('');
  } catch (error) {
    if (request === state.mineRequestId) notice(error.message || 'Could not load your time off.', true);
  }
}
function activateTeamYear(year) {
  const saved = state.teamYears.get(year);
  if (!saved) return false;
  state.teamEntries = saved.entries || [];
  state.loadedTeamYear = year;
  state.teamIncomplete = Boolean(saved.partial);
  state.teamLoading = false;
  $('team-time-off-status').textContent = saved.partial
    ? 'Some time repositories could not be read. The year may show fewer people away than expected.'
    : '';
  renderYear(); renderInspector();
  return true;
}
async function loadTeam({ refresh = false } = {}) {
  const year = state.year, identity = state.teamIdentity;
  if (!refresh && activateTeamYear(year)) return;
  const request = ++state.teamRequestId;
  const previous = state.teamYears.get(year);
  state.teamLoading = !previous;
  if (!previous) {
    state.loadedTeamYear = null;
    state.teamEntries = [];
    state.teamIncomplete = true;
  }
  $('team-time-off-status').textContent = (refresh ? 'Refreshing' : 'Loading')
    + ' team time off for ' + year + '…';
  renderYear(); renderInspector();
  try {
    const startDate = String(year).padStart(4, '0') + '-01-01';
    const endDate = String(year).padStart(4, '0') + '-12-31';
    const result = await send({ type: 'LOAD_TEAM_TIME_OFF', startDate, endDate,
      ...(refresh ? { refresh: true } : {}) });
    // Ignore an old account's response after reconfiguration or logout.
    if (identity !== null && identity !== state.teamIdentity) return;
    if (result.partial && previous && !previous.partial) {
      if (request === state.teamRequestId && state.year === year) {
        activateTeamYear(year);
        state.teamIncomplete = true;
        $('team-time-off-status').textContent =
          'GitHub returned incomplete data. Showing the last complete local snapshot.';
      }
      return;
    }
    state.teamYears.delete(year);
    state.teamYears.set(year, result);
    while (state.teamYears.size > 5) state.teamYears.delete(state.teamYears.keys().next().value);
    if (request === state.teamRequestId && state.year === year) activateTeamYear(year);
  } catch (error) {
    if (request !== state.teamRequestId || state.year !== year) return;
    if (previous) activateTeamYear(year);
    $('team-time-off-status').textContent =
      (error.message || 'Could not load team time off.') +
      (previous ? ' Showing the last locally saved calendar.' : '');
    state.teamIncomplete = true;
  } finally {
    if (request === state.teamRequestId && state.year === year) {
      state.teamLoading = false;
      renderYear(); renderInspector();
    }
  }
}

function fillTaskOptions() {
  const repo = repositoryOf($('edit-repository').value), select = $('edit-task');
  const previous = select.value, tasks = repo?.taskUrls || [];
  select.replaceChildren();
  for (const url of tasks) select.append(new Option(taskName(url), url));
  select.value = tasks.includes(previous) ? previous : tasks[0] || '';
  $('edit-task-field').hidden = tasks.length === 1;
}
const validHours = n => Number.isFinite(n) && n > 0 && n <= 24 && Number.isSafeInteger(n * 3600);
const weekend = date => [0, 6].includes(dateAt(date).getUTCDay());
function updateSelectedCells(old) {
  for (const date of new Set([...old, ...selectedDates])) {
    const cell = $('year-grid').querySelector('button[data-date="' + date + '"]');
    if (!cell) continue;
    const picked = selectedDates.has(date);
    cell.classList.toggle('pick', picked);
    cell.setAttribute('aria-pressed', String(picked));
    cell.setAttribute('aria-label', cell.getAttribute('aria-label').replace(/, selected for a time off action$/, '')
      + (picked ? ', selected for a time off action' : ''));
  }
  updateAddButton();
}
function toggleDateSelection(date, shift = false) {
  const old = new Set(selectedDates), next = new Set(selectedDates);
  if (shift && selectionAnchor) {
    const first = date < selectionAnchor ? date : selectionAnchor;
    const last = date < selectionAnchor ? selectionAnchor : date;
    const count = Math.round((dateAt(last) - dateAt(first)) / DAY_MS);
    if (count >= 500) { notice('Time off cannot span more than 500 days.', true); return; }
    for (let i = 0; i <= count; i++) {
      const d = addDays(first, i);
      if (!weekend(d)) next.add(d);
    }
  } else {
    if (next.has(date)) next.delete(date); else next.add(date);
    selectionAnchor = date;
  }
  try {
    if (next.size) normalizeTimeOffDays([...next].sort().map(d => ({ date: d, durationSeconds: 3600 })));
  } catch (error) { notice(error.message, true); return; }
  selectedDates.clear();
  for (const d of next) selectedDates.add(d);
  updateSelectedCells(old);
  if ($('time-off-error').textContent) notice('');
}
function openForm() {
  const dates = datesToAdd(), repos = availableRepositories();
  if (!dates.length || !repos.length) { updateAddButton(); return; }
  const select = $('edit-repository');
  select.replaceChildren();
  for (const repo of repos) select.append(new Option(repo.label, repo.id));
  const preferred = $('time-off-repository-filter').value;
  select.value = repos.some(repo => repo.id === preferred) ? preferred : repos[0].id;
  $('edit-repository-field').hidden = repos.length === 1;
  fillTaskOptions();
  $('edit-hours').value = '8';
  $('edit-description').value = '';
  $('chosen-time-off-dates').textContent = dates.length + (dates.length === 1 ? ' day · ' : ' days · ')
    + labelForRange(dates[0], dates.at(-1));
  setFormError('');
  $('time-off-dialog').showModal();
  updateAddButton();
}
function closeForm() {
  if ($('time-off-dialog').open) $('time-off-dialog').close();
  updateAddButton();
}
async function saveForm(event) {
  event.preventDefault();
  if (state.formBusy) return;
  const raw = $('edit-hours').value.trim(), hours = raw ? Number(raw) : NaN;
  if (!validHours(hours) || $('edit-hours').validity.stepMismatch) {
    setFormError('Enter valid hours per day (0.25–24, in 15-minute increments).');
    return;
  }
  let days;
  try {
    days = normalizeTimeOffDays(datesToAdd().map(date => ({
      date, durationSeconds: Math.round(hours * 3600),
    })));
  } catch (error) { setFormError(error.message); return; }
  const taskUrl = $('edit-task').value, destinationId = $('edit-repository').value;
  if (!taskUrl || !repositoryOf(destinationId)?.taskUrls.includes(taskUrl)) {
    setFormError('Choose a configured time off task.'); return;
  }
  state.formBusy = true;
  $('save-time-off').disabled = true;
  setFormError('');
  try {
    const result = await send({
      type: 'SAVE_TIME_OFF', destinationId, taskUrl,
      taskTitle: taskName(taskUrl), description: $('edit-description').value.trim(),
      groupId: null, timezone: null, previous: [], days,
    });
    state.entries.push(...(result.entries || []).map(entry => ({
      ...entry, isTimeOff: true, isPlannedTimeOff: Date.parse(entry.endedAt) > Date.now(),
      destinationId: result.destinationId,
      timeRepository: repositoryOf(result.destinationId)?.label || '',
      user: state.currentUsers[result.destinationId] || '',
    })));
    state.myLoadedDestinations.add(result.destinationId);
    selectedDates.clear();
    selectionAnchor = null;
    pinDayUntilLeave = false;
    closeForm();
    renderMy(); renderYear(); renderInspector();
    notice('Saved locally. Your team will see it after GitHub synchronization.');
    // The local queue response already contains the optimistic change; do not
    // re-read GitHub simply because a user added or deleted PTO.
  } catch (error) { setFormError(error.message || 'Could not add time off.'); }
  finally { state.formBusy = false; updateAddButton(); }
}
function openDeleteEntry(entry) {
  if (!isOwnEntry(entry) || state.deletionBusy) return;
  state.cancelEntry = entry;
  state.cancelEntries = null;
  $('time-off-cancel-title').textContent = 'Delete time off for this day?';
  $('time-off-cancel-message').textContent = 'Delete ' + duration(entry.durationSeconds)
    + ' on ' + dateLabel(entry.entryDate)
    + '? Other days in the same time off plan will stay unchanged.';
  $('confirm-cancel-time-off').textContent = 'Delete this day';
  $('time-off-cancel-error').hidden = true;
  $('time-off-cancel-dialog').showModal();
  updateAddButton();
}
function openDeleteSelected() {
  const own = selectedMyEntries();
  if (!own.length || own.length > 200 || state.deletionBusy) return;
  const days = new Set(own.map(entry => entry.entryDate));
  const repositories = new Set(own.map(entry => entry.destinationId)).size;
  state.cancelEntry = null;
  state.cancelEntries = own;
  $('time-off-cancel-title').textContent = 'Delete selected time off?';
  $('time-off-cancel-message').textContent = 'Delete your time off on '
    + days.size + (days.size === 1 ? ' selected day' : ' selected days')
    + ' (' + own.length + (own.length === 1 ? ' entry' : ' entries') + ')? '
    + 'Other days in the same plans and all teammates’ time off will be preserved.'
    + (repositories > 1 ? ' Each of the ' + repositories
      + ' repositories will be updated in a separate atomic commit.' : '');
  $('confirm-cancel-time-off').textContent = 'Delete time off (' + days.size + ' days)';
  $('time-off-cancel-error').hidden = true;
  $('time-off-cancel-dialog').showModal();
  updateAddButton();
}
function originalForDeletion(entry, includeIdentity = false) {
  return {
    id: entry.id, date: entry.entryDate, startedAt: entry.startedAt,
    endedAt: entry.endedAt, updatedAt: entry.updatedAt,
    ...(includeIdentity ? { taskUrl: entry.taskUrl, groupId: timeOffGroupId(entry) } : {}),
  };
}
async function confirmCancel() {
  if (state.deletionBusy) return;
  const batch = state.cancelEntries, single = state.cancelEntry;
  const entries = batch ?? (single ? [single] : []);
  if (!entries.length || entries.some(entry => !isOwnEntry(entry))) return;
  const button = $('confirm-cancel-time-off');
  state.deletionBusy = true;
  button.disabled = true;
  $('time-off-cancel-error').hidden = true;
  updateAddButton();
  let completed = 0;
  try {
    const byRepository = new Map();
    for (const entry of entries) {
      if (!byRepository.has(entry.destinationId)) byRepository.set(entry.destinationId, []);
      byRepository.get(entry.destinationId).push(entry);
    }
    for (const [destinationId, records] of byRepository) {
      const first = records[0], many = Boolean(batch);
      await send({
        type: 'SAVE_TIME_OFF', destinationId, taskUrl: first.taskUrl,
        taskTitle: first.taskTitle || '', description: first.description || '',
        groupId: many ? null : timeOffGroupId(first), timezone: first.timezone ?? null,
        ...(many ? { bulkDayDeletion: true } : { singleDayDeletion: true }),
        previous: records.map(entry => originalForDeletion(entry, many)), days: [],
      });
      completed += records.length;
      const ids = new Set(records.map(entry => entry.id));
      state.entries = state.entries.filter(entry =>
        entry.destinationId !== destinationId || !ids.has(entry.id));
      state.myLoadedDestinations.add(destinationId);
      if (batch) state.cancelEntries = state.cancelEntries.filter(entry =>
        entry.destinationId !== destinationId || !ids.has(entry.id));
    }
    $('time-off-cancel-dialog').close();
    state.cancelEntry = null;
    state.cancelEntries = null;
    // Remove successfully deleted dates from the selection, but keep other
    // dates in case they were being selected for adding time.
    if (batch) {
      const remaining = new Set(state.entries.filter(entry => isOwnEntry(entry))
        .map(entry => entry.entryDate));
      for (const entry of entries) if (!remaining.has(entry.entryDate)) {
        selectedDates.delete(entry.entryDate);
      }
      selectionAnchor = null;
    }
    renderMy(); renderYear(); renderInspector();
    notice((new Set(entries.map(entry => entry.entryDate)).size)
      + ' time off day(s) deleted locally. Changes will sync to GitHub.');
    // The local queue response already contains the optimistic change; do not
    // re-read GitHub simply because a user added or deleted PTO.
  } catch (error) {
    if (completed) {
      renderMy(); renderYear(); renderInspector();
      // The local queue response already contains the optimistic change; do not
    // re-read GitHub simply because a user added or deleted PTO.
    }
    $('time-off-cancel-error').textContent = (completed ? completed
      + ' entry/entries queued for deletion. Remaining repository failed: ' : '')
      + (error.message || 'Could not delete selected time off.');
    $('time-off-cancel-error').hidden = false;
  } finally {
    state.deletionBusy = false;
    button.disabled = false;
    updateAddButton();
  }
}

$('time-off-user-search').addEventListener('focus', renderUserSuggestions);
$('time-off-user-search').addEventListener('input', handleUserSearch);
$('time-off-user-search').addEventListener('keydown', handleUserSearchKeydown);
$('clear-time-off-user').addEventListener('click', clearUserFilter);
$('time-off-user-filter').addEventListener('focusout', () => queueMicrotask(() => {
  if (!$('time-off-user-filter').contains(document.activeElement)) closeUserSuggestions();
}));
document.addEventListener('pointerdown', event => {
  if (!$('time-off-user-filter').contains(event.target)) closeUserSuggestions();
});
$('year-grid').addEventListener('mouseleave', () => { pinDayUntilLeave = false; });
$('new-time-off').addEventListener('click', openForm);
$('delete-selected-time-off').addEventListener('click', openDeleteSelected);
$('refresh-time-off').addEventListener('click', () => {
  void loadMine(); void loadTeam({ refresh: true });
});
$('time-off-repository-filter').addEventListener('change', () => {
  renderMy(); renderYear(); renderInspector();
});
$('previous-year').addEventListener('click', () => changeYear(state.year - 1));
$('next-year').addEventListener('click', () => changeYear(state.year + 1));
$('this-year').addEventListener('click', () => changeYear(new Date().getFullYear()));
$('close-time-off').addEventListener('click', closeForm);
$('cancel-time-off-form').addEventListener('click', closeForm);
$('time-off-dialog').addEventListener('close', updateAddButton);
$('edit-repository').addEventListener('change', fillTaskOptions);
form.addEventListener('submit', saveForm);
$('keep-time-off').addEventListener('click', () => {
  state.cancelEntry = null;
  state.cancelEntries = null;
  $('time-off-cancel-dialog').close();
});
$('time-off-cancel-dialog').addEventListener('close', updateAddButton);
$('confirm-cancel-time-off').addEventListener('click', confirmCancel);
state.selectedDate = today();
renderYear(); renderInspector();
void loadMine();
void loadTeam();
