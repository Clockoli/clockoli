import { CLASSIFIER_INSTRUCTIONS, LLM_HOSTS } from '../agents/semantic-matching.js';
import { summarizeAgentWorkflow } from '../agents/metrics.js';
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
  matchingPanel.hidden = panel.hidden;
  if (panel.hidden) clearMatching();
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

const matchingPanel = document.getElementById('agent-matching');
const matchingDate = document.getElementById('agent-matching-date');
const matchingThreshold = document.getElementById('agent-matching-threshold');
const matchingStatus = document.getElementById('agent-matching-status');
const matchingResults = document.getElementById('agent-matching-results');
const matchingRun = document.getElementById('agent-matching-run');
const matchingExport = document.getElementById('agent-matching-export');
let matchingData = null, matchingSequence = 0;
function localDate(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
matchingDate.value = localDate(new Date());
matchingDate.max = matchingDate.value;
function node(tag, text, parent, className) {
  const el = document.createElement(tag);
  if (text !== null) el.textContent = text;
  if (className) el.className = className;
  parent.append(el);
  return el;
}
const matchingReasons = {
  explicit_url_and_containment: 'Explicit task URL and contained timer',
  repository_branch_and_containment: 'Repository + issue branch + contained timer',
  task_history_incomplete: 'Task history is incomplete; automatic matching disabled',
  source_evidence_unavailable: 'Source evidence unavailable',
  source_lifecycle_changed: 'Source lifecycle differs from collected turn; scan again',
  interval_unverified: 'Turn interval is not verified',
  extended_turn: 'Extended turn (> 60 minutes)',
  prompt_reference_scan_incomplete: 'Prompt URL extraction was incomplete',
  working_directory_changed: 'Turn working directory differs from session',
  conflicting_identity: 'Conflicting task references',
  session_context_unverified: 'Session repository context not verified for this turn',
  identity_outside_tracked_interval: 'Task identity matches, but turn is outside its timer',
  repository_only: 'Repository matches, no strong task identity',
  time_only: 'Time overlaps, no strong task identity',
  no_overlapping_task: 'No overlapping task',
  provider_matching_not_supported: 'Claude matching not implemented yet',
  source_file_too_large: 'Journal exceeds per-file diagnostic limit',
  diagnostic_byte_limit: 'Diagnostic byte limit reached',
  source_scan_incomplete: 'Journal scan incomplete',
  source_access_changed: 'Source access changed during diagnostic',
  source_paused: 'Source paused',
  source_missing: 'Journal unavailable or removed',
  turn_evidence_missing: 'Turn identity missing in source journal',
  permission_denied: 'Directory permission required',
  fsa_timeout: 'Directory busy or read timed out; retry',
  source_unavailable: 'Source unavailable',
};
function localTime(value) {
  if (value === null || value === undefined) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('en-GB', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }) : '—';
}
function renderMatching(data) {
  matchingResults.replaceChildren();
  const matched = data.rows.filter(row => row.state === 'matched').length;
  const warnings = [count(matched) + ' matched / ' + count(data.totalTurns) + ' observed turns · rules v' + data.ruleVersion];
  if (data.partial) warnings.push('Task history incomplete.');
  if (data.omittedTurns) warnings.push(count(data.omittedTurns) + ' turns omitted by diagnostic limit.');
  if (Object.values(data.providers).some(p => p.connected && !p.complete)) warnings.push('Collector history may be incomplete.');
  warnings.push('Scanned ' + count(data.bytesRead) + ' bytes from selected journals.');
  matchingStatus.textContent = warnings.join(' ');
  node('h3', 'Tasks tracked on this day', matchingResults);
  if (!data.tasks.length) node('p', 'No tracked task candidates found.', matchingResults);
  for (const task of data.tasks) {
    const row = node('div', null, matchingResults, 'agent-match-task');
    node('strong', task.title, row);
    node('span', task.url, row);
    node('span', task.intervals.map(i => localTime(i.start) + ' – ' + localTime(i.end) + (i.active ? ' (running)' : '')).join('; '), row);
    const s = task.summary;
    node('span', 'Matched turns: ' + count(s.totalTurns) + ' · included time: ' + time(s.eligibleMs)
      + ' · short-turn share: ' + percent(s.shortSharePct) + ' · median: ' + time(s.medianMs), row);
    node('span', ['< 1m', '1–5m', '5–15m', '15–30m', '30–60m'].map((label, i) =>
      label + ': ' + count(s.buckets[i].count) + ' (' + time(s.buckets[i].ms) + ')').join(' · '), row);
  }
  node('h3', 'Turn-by-turn decision log', matchingResults);
  for (const turn of data.rows) {
    const details = node('details', null, matchingResults, 'agent-match-row is-' + turn.state);
    const task = data.tasks.find(t => t.url === turn.matchedUrl);
    node('summary', localTime(turn.startedAt ?? turn.endedAt) + ' · ' + turn.provider + ' · '
      + time(turn.elapsedMs) + ' · ' + (task ? task.title : 'Unassigned') + ' · '
      + (matchingReasons[turn.reason] || turn.reason), details);
    node('p', 'Turn ID (local pseudonym): ' + turn.turnId + ' · ' + turn.status + ' · ' +
      localTime(turn.startedAt) + ' – ' + localTime(turn.endedAt), details);
    const e = turn.signals;
    node('p', 'Repository: ' + (e.repository || '—') + ' · branch issue: ' + (e.branchIssueNumbers.join(', ') || '—')
      + ' · client: ' + (e.client || '—') + ' · matching CWD evidence: ' + (e.cwdMismatch ? 'conflict' : e.contextSeen ? 'present' : 'missing'), details);
    node('p', 'Explicit task references: ' + (e.explicitTaskUrls.join(', ') || 'none'), details);
    node('p', 'Decision: ' + turn.reason, details);
    const list = node('ul', null, details);
    for (const c of turn.candidates) {
      node('li', c.title + ' · ' + c.url + ' · overlap ' + time(c.overlapMs) +
        ' · contained ' + (c.contained ? 'yes' : 'no') + ' · repository ' + (c.repository ? 'yes' : 'no') +
        ' · branch ' + (c.branch ? 'yes' : 'no') + ' · explicit URL ' + (c.explicit ? 'yes' : 'no'), list);
    }
    if (!turn.candidates.length) node('li', 'No task candidates', list);
  }
}
function clearMatching() {
  clearSemantic();
  matchingSequence++;
  matchingData = null;
  matchingRun.disabled = false;
  matchingExport.disabled = true;
  matchingResults.replaceChildren();
  matchingStatus.textContent = 'Choose a day and analyze to see the task candidates and matching decisions.';
}
for (const control of [matchingDate, matchingThreshold]) control.addEventListener('change', clearMatching);
matchingRun.addEventListener('click', async () => {
  if (!matchingDate.reportValidity() || !matchingDate.value) return;
  clearMatching();
  const id = matchingSequence;
  const date = matchingDate.value, thresholdMinutes = Number(matchingThreshold.value);
  matchingRun.disabled = true;
  matchingStatus.textContent = 'Reading task history and selected journals…';
  try {
    const data = await send({ type: 'AGENT_MATCHING_DIAGNOSTICS', date, thresholdMinutes });
    if (id !== matchingSequence) return;
    matchingData = { date, thresholdMinutes, ...data };
    renderMatching(data);
    matchingExport.disabled = false;
  } catch {
    if (id === matchingSequence) matchingStatus.textContent = 'Matching unavailable. Check your source access and task history, then retry.';
  } finally {
    if (id === matchingSequence) matchingRun.disabled = false;
  }
});
matchingExport.addEventListener('click', () => {
  if (!matchingData) return;
  const blob = new Blob([JSON.stringify(matchingData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url;
  link.download = 'clockoli-matching-' + matchingData.date + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

const semanticProvider = document.getElementById('semantic-provider');
const semanticModel = document.getElementById('semantic-model');
const semanticKey = document.getElementById('semantic-key');
const semanticConsent = document.getElementById('semantic-consent');
const semanticPrepare = document.getElementById('semantic-prepare');
const semanticRun = document.getElementById('semantic-run');
const semanticStatus = document.getElementById('semantic-status');
const semanticPreview = document.getElementById('semantic-preview');
const semanticResults = document.getElementById('semantic-results');
let semanticGeneration=0, prepared=null, semanticRunning=false;
const semanticCache=new Map();
function clearSemantic() {
  semanticGeneration++;
  prepared=null;
  semanticKey.value='';
  semanticConsent.checked=false;
  semanticPreview.textContent='';
  semanticPreview.hidden=true;
  semanticResults.replaceChildren();
  semanticRun.disabled=true;
  semanticStatus.textContent='';
}
function syncSemantic() {
  semanticRun.disabled=semanticRunning||!prepared?.preview?.batches?.length||!semanticConsent.checked||
    !semanticKey.value.trim()||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(semanticModel.value.trim());
}
for(const input of [semanticModel,semanticKey,semanticConsent])input.addEventListener('input',syncSemantic);
semanticProvider.addEventListener('change',()=>{semanticConsent.checked=false;semanticKey.value='';syncSemantic();});
semanticModel.addEventListener('input',()=>{semanticConsent.checked=false;syncSemantic();});
semanticPrepare.addEventListener('click',async()=>{
  if(semanticRunning||!matchingDate.value||!matchingDate.reportValidity())return;
  clearSemantic();
  const generation=semanticGeneration;
  semanticPrepare.disabled=true;
  semanticStatus.textContent='Reading local source and available task descriptions…';
  try {
    const data=await send({type:'AGENT_SEMANTIC_PREVIEW',date:matchingDate.value,thresholdMinutes:Number(matchingThreshold.value)});
    if(generation!==semanticGeneration)return;
    prepared=data;
    semanticPreview.hidden=false;
    semanticPreview.textContent=CLASSIFIER_INSTRUCTIONS+'\n\n'+data.preview.batches.map((b,i)=>'Batch '+(i+1)+'\n'+JSON.stringify(b.payload,null,2)).join('\n\n');
    semanticStatus.textContent=data.preview.batches.length+' request(s) prepared · '+data.preview.skipped.length+' turns excluded (no verified candidate or context, or diagnostic limit). Review all content before sending.';
    syncSemantic();
  }catch{if(generation===semanticGeneration)semanticStatus.textContent='Could not prepare semantic preview.';}
  finally{semanticPrepare.disabled=false;}
});
async function semanticSend(message) {
  return new Promise((resolve,reject)=>chrome.runtime.sendMessage(message,response=>{
    if(chrome.runtime.lastError||!response?.ok){
      const error=typeof response?.error==='string'?response.error:response?.error?.message;
      // Only surface fixed, non-secret errors; never raw API bodies.
      const safe=/^(Provider HTTP [0-9]{3}|Provider network error or timeout|Provider returned no complete classification|Model did not return valid JSON|Incomplete model decisions|Invalid model decision|Invalid or oversized provider response|API host permission not granted|Agent source access changed; prepare again)$/.test(error||'')?error:'Semantic request failed';
      return reject(new Error(safe));
    }
    resolve(response.data);
  }));
}
semanticRun.addEventListener('click',async()=>{
  if(semanticRun.disabled||semanticRunning||!prepared)return;
  const data=prepared,generation=semanticGeneration,p=semanticProvider.value,model=semanticModel.value.trim();
  let apiKey=semanticKey.value.trim();
  semanticKey.value='';semanticConsent.checked=false;
  semanticRunning=true;semanticPrepare.disabled=true;syncSemantic();
  semanticResults.replaceChildren();
  try{
    if(!await chrome.permissions.request({origins:[LLM_HOSTS[p]]})){semanticStatus.textContent='API host access declined.';return;}
    if(generation!==semanticGeneration)return;
    const decisions=new Map(),usage={input:0,output:0,unknown:0},failures=[];
    for(const [index,batch] of data.preview.batches.entries()){
      if(generation!==semanticGeneration)break;
      semanticStatus.textContent='Classifying batch '+(index+1)+' / '+data.preview.batches.length+'…';
      // Session-page cache; exact model + exact preview; no persistent text or keys.
      const cacheKey=JSON.stringify([p,model,data.preview.rootId,batch.payload]);
      try{
        let result=semanticCache.get(cacheKey);
        const cached=Boolean(result);
        if(!result){
          result=await semanticSend({type:'AGENT_SEMANTIC_CLASSIFY',provider:p,model,apiKey,rootId:data.preview.rootId,payload:batch.payload,confirmed:true});
          if(semanticCache.size>=30)semanticCache.delete(semanticCache.keys().next().value);
          semanticCache.set(cacheKey,result);
          if(result.usage.inputTokens===null||result.usage.outputTokens===null)usage.unknown++;
          usage.input+=result.usage.inputTokens||0;usage.output+=result.usage.outputTokens||0;
        }
        if(generation!==semanticGeneration)break;
        for(const d of result.decisions){
          const i=batch.payload.turns.findIndex(t=>t.id===d.turn_id);
          const j=batch.payload.tasks.findIndex(t=>t.id===d.task_id);
          if(i>=0)decisions.set(batch.turnIds[i],{...d,url:j>=0?batch.taskUrls[j]:null,cached});
        }
        node('p','Batch '+(index+1)+(cached?' · cached':' · '+(result.usage.inputTokens??'—')+' input / '+(result.usage.outputTokens??'—')+' output tokens')+
          (result.usage.cost===null?'':' · provider cost '+result.usage.cost+' USD'),semanticResults);
      }catch(error){failures.push(index+1);node('p','Batch '+(index+1)+': '+error.message,semanticResults);break;}
    }
    if(generation!==semanticGeneration)return;
    node('h3','Semantic proposals (not confirmed)',semanticResults);
    for(const task of data.tasks){
      const turns=data.rows.filter(r=>decisions.get(r.turnId)?.url===task.url).map(r=>({...r,key:r.turnId}));
      const summary=summarizeAgentWorkflow(turns,{period:'all',provider:'all',thresholdMinutes:Number(matchingThreshold.value)});
      node('p',task.title+' · '+summary.totalTurns+' proposed turns · '+time(summary.eligibleMs)+' · short share '+percent(summary.shortSharePct),semanticResults);
    }
    for(const row of data.rows){
      const d=decisions.get(row.turnId);
      const detail=node('details',null,semanticResults,'agent-match-row');
      const task=data.tasks.find(t=>t.url===d?.url);
      node('summary',localTime(row.startedAt??row.endedAt)+' · '+(task?.title??(d?'Unassigned':'Not analyzed'))+' · '+time(row.elapsedMs),detail);
      node('p','Rule v1: '+row.reason+' · '+(row.matchedUrl||'Unassigned'),detail);
      node('p','Model: '+(d?d.reason+' · '+d.confidence+' · '+d.explanation:'No model decision'),detail);
      node('p','Turn ID: '+row.turnId,detail);
    }
    // Normal debug download contains no prompts, model explanations or raw
    // descriptions. Keep only structured decisions and usage.
    const {preview,...safeData}=data;
    matchingData={date:matchingDate.value,thresholdMinutes:Number(matchingThreshold.value),...safeData,
      tasks:safeData.tasks.map(({description,...task})=>task),
      semantic:{provider:p,model,usage,failures,decisions:[...decisions].map(([turnId,{url,reason,confidence,cached}])=>({turnId,url,reason,confidence,cached}))}};
    matchingExport.disabled=false;
    semanticStatus.textContent=decisions.size+' analyzed · '+[...decisions.values()].filter(d=>d.url).length+' proposed matches · '+usage.input+' input / '+usage.output+' output tokens this run'+(usage.unknown?' (some usage unavailable)':'')+(failures.length?' · stopped on error':'');
  }finally{apiKey='';semanticRunning=false;semanticPrepare.disabled=false;syncSemantic();}
});
