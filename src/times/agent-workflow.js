import { CLASSIFIER_INSTRUCTIONS, LLM_HOSTS } from '../agents/semantic-matching.js';
import { buildTaskTimeline } from '../agents/task-matching.js';
const countFormat = new Intl.NumberFormat('en-US');
const percentFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const count = value => countFormat.format(value);
const percent = value => value === null ? '—' : percentFormat.format(value) + '%';
function time(ms) {
  if (!Number.isFinite(ms)) return '—';
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  const remainder = (ms % 60000) / 1000;
  return [hours && hours + 'h', minutes && minutes + 'm', remainder && remainder + 's']
    .filter(Boolean).join(' ') || '0s';
}
function send(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, response => {
    if (chrome.runtime.lastError || !response?.ok) return reject(new Error('Workflow unavailable'));
    resolve(response.data);
  }));
}
const matchingPanel = document.getElementById('agent-matching');
const matchingDate = document.getElementById('agent-matching-date');
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
  explicit_url_and_overlap: 'Explicit task URL and overlapping timer',
  repository_branch_and_overlap: 'Repository + issue branch + overlapping timer',
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
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false,
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
    renderTaskTimeline(task.timeline, row);
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
matchingDate.addEventListener('change', clearMatching);
matchingRun.addEventListener('click', async () => {
  if (!matchingDate.reportValidity() || !matchingDate.value) return;
  clearMatching();
  const id = matchingSequence;
  const date = matchingDate.value;
  matchingRun.disabled = true;
  matchingStatus.textContent = 'Reading task history and selected journals…';
  try {
    const data = await send({ type: 'AGENT_MATCHING_DIAGNOSTICS', date });
    if (id !== matchingSequence) return;
    matchingData = { date, ...data };
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
  semanticProvider.disabled=semanticRunning;
  semanticModel.disabled=semanticRunning;
  semanticKey.disabled=semanticRunning;
  semanticConsent.disabled=semanticRunning;
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
    const data=await send({type:'AGENT_SEMANTIC_PREVIEW',date:matchingDate.value});
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
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([p,model,data.preview.rootId,batch.payload])));
      if(generation!==semanticGeneration)break;
      const cacheKey=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
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
          const modelIndex=batch.payload.tasks.findIndex(t=>t.id===d.model_task_id);
          if(i>=0)decisions.set(batch.turnIds[i],{...d,url:j>=0?batch.taskUrls[j]:null,modelUrl:modelIndex>=0?batch.taskUrls[modelIndex]:null,cached});
        }
        node('p','Batch '+(index+1)+(cached?' · cached':' · '+(result.usage.inputTokens??'—')+' input / '+(result.usage.outputTokens??'—')+' output tokens')+
          (result.usage.cost===null?'':' · provider cost '+result.usage.cost+' USD'),semanticResults);
      }catch(error){failures.push(index+1);node('p','Batch '+(index+1)+': '+error.message,semanticResults);break;}
    }
    if(generation!==semanticGeneration)return;
    node('h3','Semantic proposals (not confirmed)',semanticResults);
    for(const task of data.tasks){
      const turns=data.rows.filter(r=>decisions.get(r.turnId)?.url===task.url).map(r=>({...r,key:r.turnId}));
      const timeline=buildTaskTimeline(task.intervals,turns,data.dayStart,data.dayEnd);
      const block=node('div',null,semanticResults,'agent-match-task');
      node('strong',task.title,block);
      renderTaskTimeline(timeline,block);
    }
    for(const row of data.rows){
      const d=decisions.get(row.turnId);
      const detail=node('details',null,semanticResults,'agent-match-row');
      const task=data.tasks.find(t=>t.url===d?.url);
      node('summary',localTime(row.startedAt??row.endedAt)+' · '+(task?.title??(d?'Unassigned':'Not analyzed'))+' · '+time(row.elapsedMs),detail);
      node('p','Rules v'+data.ruleVersion+': '+row.reason+' · '+(row.matchedUrl||'Unassigned'),detail);
      node('p','Model: '+(d?d.reason+' · '+d.confidence+' · '+(d.modelUrl||'null')+' · '+d.explanation:'No model decision'),detail);
      node('p','Turn ID: '+row.turnId,detail);
    }
    // Normal debug download contains no prompts, model explanations or raw
    // descriptions. Keep only structured decisions and usage.
    const {preview,...safeData}=data;
    matchingData={date:matchingDate.value,thresholdMinutes:Number(matchingThreshold.value),...safeData,
      tasks:safeData.tasks.map(({description,...task})=>({...task,semanticTimeline:buildTaskTimeline(task.intervals,data.rows.filter(r=>decisions.get(r.turnId)?.url===task.url),data.dayStart,data.dayEnd)})),
      semantic:{provider:p,model,usage,failures,decisions:[...decisions].map(([turnId,{url,modelUrl,reason,confidence,cached}])=>({turnId,url,modelUrl,reason,confidence,cached}))}};
    matchingExport.disabled=false;
    semanticStatus.textContent=decisions.size+' analyzed · '+[...decisions.values()].filter(d=>d.url).length+' proposed matches · '+usage.input+' input / '+usage.output+' output tokens this run'+(usage.unknown?' (some usage unavailable)':'')+(failures.length?' · stopped on error':'');
  }finally{apiKey='';semanticRunning=false;semanticPrepare.disabled=false;syncSemantic();}
});

function renderTaskTimeline(timeline,parent) {
  node('span','Tracked: '+time(timeline.trackedMs)+' · observed AI coverage: '+time(timeline.coveredMs)+
    ' ('+percent(timeline.coveragePct)+') · no matched AI observed: '+time(timeline.uncoveredMs),parent);
  node('span',timeline.matchedTurns+' proposed turns · sum of full observed turn durations: '+time(timeline.observedTurnMs),parent);
  if(timeline.unverified.length)node('span',timeline.unverified.length+' unverified intervals (not used for coverage)',parent);
  for(const window of timeline.windows){
    const block=node('div',null,parent,'agent-task-window');
    node('span','Timer: '+localTime(window.trackedStart)+' – '+localTime(window.trackedEnd)+(window.active?' (running snapshot)':''),block);
    if(window.start!==window.trackedStart||window.end!==window.trackedEnd)node('span','Shown on selected day: '+localTime(window.start)+' – '+localTime(window.end),block);
    const bar=node('div',null,block,'agent-task-bar');
    bar.setAttribute('aria-label','Observed AI turn intervals within the task timer');
    const lanes=[];
    for(const segment of window.segments){
      let lane=lanes.findIndex(end=>end<=segment.visibleStart);
      if(lane<0)lane=lanes.length;
      lanes[lane]=segment.visibleEnd;
      const mark=node('div',null,bar,'agent-task-turn');
      mark.style.left=100*(segment.visibleStart-window.start)/window.trackedMs+'%';
      mark.style.width=100*(segment.visibleEnd-segment.visibleStart)/window.trackedMs+'%';
      mark.style.top=lane*15+'px';
      mark.title=segment.provider+' · '+localTime(segment.start)+' – '+localTime(segment.end)+' · '+time(segment.end-segment.start);
    }
    bar.style.height=Math.max(15,lanes.length*15)+'px';
    node('span','Covered: '+time(window.coveredMs)+' · gaps: '+time(window.uncoveredMs),block);
    const details=node('details',null,block,'agent-task-interval-list');
    node('summary','Show all turns and gaps',details);
    const list=node('ul',null,details);
    const events=[...window.segments.map(t=>({start:t.visibleStart,end:t.visibleEnd,turn:t})),...window.gaps];
    events.sort((a,b)=>a.start-b.start||a.end-b.end);
    for(const e of events)node('li',(e.turn?e.turn.provider:'No matched AI observed')+' · '+localTime(e.start)+' – '+localTime(e.end)+' · '+time(e.end-e.start)+
      (e.turn?' (full turn '+localTime(e.turn.start)+' – '+localTime(e.turn.end)+'; '+time(e.turn.end-e.turn.start)+
        (e.turn.providerDurationMs!==null?' ; provider duration '+time(e.turn.providerDurationMs):'')+')':''),list);
  }
  for(const t of timeline.unverified)node('span','Unverified '+t.provider+' · '+localTime(t.start)+' – '+localTime(t.end)+' · elapsed '+time(t.elapsedMs),parent);
}
let statusPending=false;
async function refreshConnection(){
  if(statusPending)return;
  statusPending=true;
  try{
    // This existing local aggregate request is used only for connection status.
    const data=await send({type:'AGENT_WORKFLOW_SUMMARY',period:'today',provider:'all',thresholdMinutes:15});
    matchingPanel.hidden=!Object.values(data.providers).some(p=>p.connected);
    if(matchingPanel.hidden)clearMatching();
    if(!data.providers.codex?.connected||data.providers.codex.paused||data.providers.codex.permission!=='granted'){
      semanticCache.clear();if(prepared)clearSemantic();
    }
  }catch{/* Keep last visible state if worker temporarily unavailable. */}
  finally{statusPending=false;}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshConnection();});
setInterval(()=>{if(!document.hidden)refreshConnection();},60000);
refreshConnection();
