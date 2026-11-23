import { normalizeTimeOffConfig, parseTimeOffConfig, serializeTimeOffConfig, TIME_OFF_CONFIG_PATH } from '../domain/time-off.js';

function missing(error) { return error?.status === 404 || error?.code === 'not_found'; }

export async function readTimeOffSettings(github, { signal } = {}) {
  try {
    const file = await github.getText(TIME_OFF_CONFIG_PATH, { signal });
    return { config: parseTimeOffConfig(file.text), sha: file.sha };
  } catch (error) {
    if (!missing(error)) throw error;
    // A 404 can also mean the repository is gone or its permissions changed.
    await github.assertDestinationReachable();
    return { config: normalizeTimeOffConfig(), sha: null };
  }
}

export async function saveTimeOffSettings(github, { taskUrls, expectedSha }) {
  const config = normalizeTimeOffConfig({ version: 1, taskUrls });
  if (expectedSha !== null && (typeof expectedSha !== 'string' || !/^[0-9a-f]{40}$/i.test(expectedSha))) {
    throw new Error('Invalid time off settings revision.');
  }
  const repo = await github.validateRepository();
  if (repo.permissions?.admin !== true) throw new Error('GitHub repository administrator access is required to change time off tasks.');
  const previous = await readTimeOffSettings(github);
  if (previous.sha !== expectedSha) throw new Error('Time off tasks changed on GitHub. Reload the list before saving.');
  const saved = await github.putText(TIME_OFF_CONFIG_PATH, serializeTimeOffConfig(config.taskUrls),
    'Configure Clockoli time off tasks', previous.sha);
  return { config, sha: saved.sha };
}
