// Keep completed annual team scans across page reloads. Scope the data to the
// current GitHub identity, configuration generation, and connected repositories.
export const TEAM_TIME_OFF_YEAR_CACHE_KEY = 'timeOffTeamYearsV1';
const MAX_YEARS = 5;
const MAX_YEAR_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

export function teamTimeOffCacheScope(snapshot, destinations) {
  const login = snapshot.auth?.githubLogin || snapshot.auth?.user?.login || '';
  return JSON.stringify({
    generation: snapshot.generation,
    // OAuth token rotation must not invalidate a cached year for the same user.
    identity: login ? {
      mode: snapshot.auth?.mode || 'github_app', login: login.toLowerCase(),
    } : { mode: snapshot.auth?.mode || 'unknown', authGeneration: snapshot.authGeneration },
    destinations: destinations.map(item => [
      item.id, item.owner, item.repo, item.branch || 'main',
      item.defaultBranch || 'main', item.repoId || null, item.storageLogin || '',
    ]).sort((a, b) => a[0].localeCompare(b[0])),
  });
}

export async function readCachedTeamTimeOff(backend, scope, year) {
  const cache = (await backend.getMany([TEAM_TIME_OFF_YEAR_CACHE_KEY]))[TEAM_TIME_OFF_YEAR_CACHE_KEY];
  const result = cache?.version === 1 && cache.scope === scope
    ? cache.years?.[String(year)]?.result : null;
  return result?.configured === true && result.partial === false && Array.isArray(result.entries)
    ? { ...result, cached: true } : null;
}

export async function getTeamTimeOffCacheRevision(backend) {
  return (await backend.getMany([TEAM_TIME_OFF_YEAR_CACHE_KEY]))[TEAM_TIME_OFF_YEAR_CACHE_KEY]?.revision ?? 0;
}

export async function saveCachedTeamTimeOff(backend, scope, year, result, savedAt = Date.now(),
  { expectedRevision, expectedGeneration } = {}) {
  if (result?.configured !== true || result.partial || !Array.isArray(result.entries)) return false;
  const { cached, ...value } = result;
  const size = JSON.stringify(value).length;
  if (size > MAX_YEAR_BYTES) return false;
  return backend.mutateMany([TEAM_TIME_OFF_YEAR_CACHE_KEY, 'configurationGeneration'], current => {
    const stored = current[TEAM_TIME_OFF_YEAR_CACHE_KEY], revision = stored?.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== revision) return { result: false };
    if (expectedGeneration !== undefined && current.configurationGeneration !== undefined
        && current.configurationGeneration !== expectedGeneration) return { result: false };
    const years = stored?.version === 1 && stored.scope === scope ? { ...stored.years } : {};
    const key = String(year);
    if ((years[key]?.savedAt ?? -1) > savedAt) return { result: false };
    years[key] = { savedAt, size, result: value };
    const recent = Object.entries(years).sort((a, b) => b[1].savedAt - a[1].savedAt);
    let total = 0;
    const retained = {};
    for (const [itemYear, item] of recent) {
      if (Object.keys(retained).length >= MAX_YEARS || total + item.size > MAX_TOTAL_BYTES) continue;
      retained[itemYear] = item;
      total += item.size;
    }
    return {
      set: { [TEAM_TIME_OFF_YEAR_CACHE_KEY]: { version: 1, revision, scope, years: retained } },
      result: true,
    };
  });
}

export async function invalidateCachedTeamTimeOff(backend) {
  await backend.mutateMany([TEAM_TIME_OFF_YEAR_CACHE_KEY], current => ({
    set: { [TEAM_TIME_OFF_YEAR_CACHE_KEY]: { version: 1,
      revision: (current[TEAM_TIME_OFF_YEAR_CACHE_KEY]?.revision ?? 0) + 1, scope: null, years: {} } },
    result: true,
  }));
}
