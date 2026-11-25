import { read, write } from './database.js';

const selected = {};
const FOLDERS = { codex: 'sessions', claude: 'projects' };
const statusElement = document.querySelector('#status');

function show(value) { statusElement.textContent = JSON.stringify(value, null, 2); }
async function askWorker(type) {
  const response = await chrome.runtime.sendMessage({ type });
  if (!response?.ok) throw new Error(response?.error || 'worker unavailable');
  show(response.status);
}

async function updatePermission(provider) {
  const panel = document.querySelector(`[data-provider="${provider}"]`);
  const handle = selected[provider];
  let permission = 'not_selected';
  if (handle) {
    try { permission = await handle.queryPermission({ mode: 'read' }); }
    catch (error) { permission = error.name; }
  }
  panel.querySelector('.permission').textContent = permission;
  panel.querySelector('.allow').hidden = permission !== 'prompt';
}

for (const provider of Object.keys(FOLDERS)) {
  const panel = document.querySelector(`[data-provider="${provider}"]`);
  panel.querySelector('.choose').addEventListener('click', async () => {
    try {
      const handle = await showDirectoryPicker({ mode: 'read', id: `clockoli-probe-${provider}` });
      if (handle.name !== FOLDERS[provider]) throw new Error(`Select the ${FOLDERS[provider]} directory`);
      let hasChildDirectory = false;
      for await (const item of handle.values()) {
        if (item.kind === 'directory') { hasChildDirectory = true; break; }
      }
      if (!hasChildDirectory) throw new Error('Selected directory has no session subdirectories');
      await write('handles', provider, handle);
      selected[provider] = handle;
      await updatePermission(provider);
      await askWorker('scan');
    } catch (error) {
      show({ error: error.name === 'AbortError' ? 'selection_cancelled' : error.message });
    }
  });
  panel.querySelector('.allow').addEventListener('click', async () => {
    try {
      // The handle is loaded before the gesture. Never request permission in the worker.
      const permission = await selected[provider].requestPermission({ mode: 'read' });
      await updatePermission(provider);
      if (permission === 'granted') await askWorker('scan');
    } catch (error) { show({ error: error.name }); }
  });
}

document.querySelector('#scan').addEventListener('click', () => askWorker('scan').catch(error => show({ error: error.message })));
document.querySelector('#refresh').addEventListener('click', async () => {
  try {
    for (const provider of Object.keys(FOLDERS)) await updatePermission(provider);
    await askWorker('status');
  } catch (error) { show({ error: error.message }); }
});

for (const provider of Object.keys(FOLDERS)) {
  selected[provider] = await read('handles', provider);
  await updatePermission(provider);
}
await askWorker('status').catch(error => show({ error: error.message }));
