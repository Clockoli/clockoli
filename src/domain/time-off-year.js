// Annual Time off views count people, never individual time entries.
// One person may record several PTO entries or share multiple time repositories.
export function annualTimeOffDays(records, year, currentUsers = {}, now = Date.now()) {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new Error('Invalid Time off year.');
  }
  const targetYear = String(year).padStart(4, '0');
  const days = new Map();
  for (const entry of records ?? []) {
    if (!entry || entry.isTimeOff !== true || entry.entryDate?.slice(0, 4) !== targetYear
        || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(entry.entryDate)
        || typeof entry.user !== 'string' || !entry.user.trim()) continue;
    const date = entry.entryDate, key = entry.user.toLowerCase();
    let day = days.get(date);
    if (!day) { day = { date, people: new Map() }; days.set(date, day); }
    let person = day.people.get(key);
    if (!person) {
      person = { user: entry.user, entries: [], own: false, seconds: 0 };
      day.people.set(key, person);
    }
    person.entries.push(entry);
    person.seconds += Number(entry.durationSeconds) || 0;
    if (currentUsers[entry.destinationId]?.toLowerCase() === key) person.own = true;
  }
  const result = new Map();
  for (const [date, group] of days) {
    const people = [...group.people.values()].sort((a, b) =>
      Number(b.own) - Number(a.own) || a.user.localeCompare(b.user));
    const status = entry => Date.parse(entry.endedAt) > new Date(now).getTime() ? 'planned' : 'taken';
    for (const person of people) {
      person.planned = person.entries.some(entry => status(entry) === 'planned');
      person.taken = person.entries.some(entry => status(entry) === 'taken');
    }
    result.set(date, {
      date, count: people.length, people, own: people.some(person => person.own),
      planned: people.some(person => person.planned),
      taken: people.some(person => person.taken),
    });
  }
  return result;
}
