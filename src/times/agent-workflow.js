import { CLASSIFIER_INSTRUCTIONS, LLM_HOSTS } from '../agents/semantic-matching.js';
import { buildTaskTimeline, buildObservedTaskTimeline, turnOverlapsTrackedIntervals } from '../agents/task-matching.js';
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
let matchingData = null, matchingSequence = 0, overlayState = null;
const showUnmatched = document.getElementById('agent-show-unmatched');
const comparison = document.getElementById('agent-matching-comparison');
showUnmatched.addEventListener('change',()=>publishOverlay());
function publishOverlay(data,decisions=null) {
  if(data!==undefined)overlayState=data?{data,decisions}:null;
  const entries=[];
  if(overlayState){
    const {data,decisions}=overlayState;
    for(const task of data.tasks){
      const timeline=buildObservedTaskTimeline(task,data.rows,data.dayStart,data.dayEnd,decisions);
      for(const window of timeline.windows)entries.push({url:task.url,start:window.start,end:window.end,
        segments:window.segments.filter(t=>!['other_task','model_unrelated'].includes(t.attribution)).map(t=>({start:t.visibleStart,end:t.visibleEnd,matched:t.attribution==='matched'}))});
    }
  }
  globalThis.dispatchEvent(new CustomEvent('clockoli:agent-activity-overlay',{detail:overlayState?{entries,showUnmatched:showUnmatched.checked}:null}));
}
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
function compactTime(ms) {
  if(!Number.isFinite(ms))return '—';
  if(ms>0&&ms<1000)return '<1s';
  return time(Math.round(ms/1000)*1000);
}
function renderComparison(data,decisions=null) {
  comparison.replaceChildren();
  for(const task of data.tasks){
    for(const interval of task.intervals){
      if(interval.end<=data.dayStart||interval.start>=data.dayEnd)continue;
      const entry={...task,intervals:[interval]};
      const before=buildObservedTaskTimeline(entry,data.rows,data.dayStart,data.dayEnd);
      const after=decisions===null?before:buildObservedTaskTimeline(entry,data.rows,data.dayStart,data.dayEnd,decisions);
      const card=node('div',null,comparison,'agent-compact-entry');
      node('strong',task.title,card);
      node('span',clockTime(Math.max(interval.start,data.dayStart))+'–'+clockTime(Math.min(interval.end,data.dayEnd))+' · '+compactTime(before.trackedMs)+' tracked',card);
      node('span',compactTime(before.coveredMs)+' observed AI intervals · '+before.observedTurns+' overlapping turns (all work)',card);
      const result=node('div',null,card,'agent-match-comparison-line');
      node('strong',decisions===null?'Rules: '+compactTime(before.matchedCoveredMs)+' · '+before.matchedTurns+' proposed matches':
        'Rules: '+compactTime(before.matchedCoveredMs)+' / '+before.matchedTurns+' turns → AI: '+compactTime(after.matchedCoveredMs)+' / '+after.matchedTurns+' turns',result);
      node('span',after.unresolvedTurns+' unresolved · '+after.rejectedTurns+' model-rejected · '+after.otherTaskTurns+' attributed elsewhere',result);
      if(decisions!==null){
        const changed=data.rows.filter(r=>turnOverlapsTrackedIntervals(r,[interval],data.dayStart,data.dayEnd)&&decisions.has(r.turnId)&&
          ((r.matchedUrl===task.url)!==(decisions.get(r.turnId)?.url===task.url)));
        if(changed.length){
          const detail=node('details',null,card);
          node('summary',changed.length+' changed task decisions',detail);
          for(const row of changed){
            const d=decisions.get(row.turnId);
            node('p',clockTime(row.startedAt,true)+' · '+(row.matchedUrl===task.url?'Match':'No match')+' → '+(d.url===task.url?'Match':'No match')+' · '+d.reason+' ('+d.confidence+')',detail);
          }
        }
      }
    }
  }
}
function renderMatching(data,decisions=null) {
  matchingResults.replaceChildren();
  const warnings = [count(data.rows.length) + ' turns within tracked entries · shown inside calendar blocks for selected day'];
  if (data.partial) warnings.push('Task history incomplete.');
  if (data.omittedTurns) warnings.push(count(data.omittedTurns) + ' overlapping turns omitted by diagnostic limit.');
  if (Object.values(data.providers).some(p => p.connected && !p.complete)) warnings.push('Collector history may be incomplete.');
  matchingStatus.textContent = warnings.join(' · ');
  publishOverlay(data,decisions);
  renderComparison(data,decisions);
  renderTrackedEntries(data, matchingResults,decisions);
  const debug=node('details',null,matchingResults,'agent-matching-debug');
  node('summary','Matching diagnostics',debug);
  node('p',count(data.rows.filter(r=>r.state==='matched').length)+' proposed matches · rules v'+data.ruleVersion+' · '+count(data.bytesRead)+' journal bytes read',debug);
  if(Number.isFinite(data.outsideTurns))node('p',count(data.outsideTurns)+' turns outside tracked entries ignored.',debug);
}
function renderTrackedEntries(data,parent,decisions=null) {
  const entries=data.tasks.flatMap(task=>task.intervals.map(interval=>({task,interval})))
    .filter(e=>e.interval.start<data.dayEnd&&e.interval.end>data.dayStart)
    .sort((a,b)=>a.interval.start-b.interval.start||a.interval.end-b.interval.end);
  if(!entries.length){node('p','No tracked entries in the available history for this day.',parent);return;}
  for(const {task,interval} of entries){
    const rows=data.rows.filter(r=>turnOverlapsTrackedIntervals(r,[interval],data.dayStart,data.dayEnd));
    const timeline=buildObservedTaskTimeline({...task,intervals:[interval]},rows,data.dayStart,data.dayEnd,decisions);
    const card=node('section',null,parent,'agent-match-task agent-entry-card');
    const heading=node('div',null,card,'agent-entry-heading');
    node('strong',task.title,heading);
    node('span',localTime(interval.start)+' – '+localTime(interval.end)+(interval.active?' · running snapshot':''),heading);
    renderTaskTimeline(timeline,card);
    if(rows.length){
      const debug=node('details',null,card,'agent-matching-debug');
      node('summary','Turn details & matching decisions ('+rows.length+')',debug);
      for(const turn of rows)renderTurnDecision(turn,task,debug,decisions);
    }
  }
}
function renderTurnDecision(turn,task,parent,decisions){
  const d=decisions?.get(turn.turnId);
  const details=node('details',null,parent,'agent-match-row is-'+turn.state);
  const url=decisions===null?turn.matchedUrl:d?.url;
  node('summary',clockTime(turn.startedAt??turn.endedAt,true)+' · '+turn.provider+' · '+time(turn.elapsedMs)+' · '+(url===task.url?'Proposed match':url?'Other task':'Unassigned'),details);
  node('p','Full turn: '+localTime(turn.startedAt)+' – '+localTime(turn.endedAt)+' · '+turn.status+' · ID: '+turn.turnId,details);
  const e=turn.signals;
  node('p','Repository: '+(e.repository||'—')+' · branch issue: '+(e.branchIssueNumbers.join(', ')||'—')+' · client: '+(e.client||'—')+' · working context: '+(e.cwdMismatch?'conflict':e.contextSeen?'present':'missing'),details);
  node('p','Explicit task references: '+(e.explicitTaskUrls.join(', ')||'none'),details);
  node('p','Rules: '+turn.reason+' · '+(matchingReasons[turn.reason]||turn.reason),details);
  if(decisions)node('p','Model: '+(d?d.reason+' · '+d.confidence+' · '+(d.modelUrl||'null')+' · '+d.explanation:'Not analyzed'),details);
  const c=turn.candidates.find(c=>c.url===task.url);
  if(c)node('p','This task: overlap '+time(c.overlapMs)+' · contained '+(c.contained?'yes':'no')+' · repository '+(c.repository?'yes':'no')+' · branch '+(c.branch?'yes':'no')+' · explicit URL '+(c.explicit?'yes':'no'),details);
}
function clockTime(value,precise=false){
  if(value===null||value===undefined)return '—';
  const date=new Date(value);
  return Number.isFinite(date.getTime())?date.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',...(precise?{second:'2-digit',fractionalSecondDigits:3}:{}),hour12:false}):'—';
}
function clearMatching() {
  clearSemantic();
  matchingSequence++;
  matchingData = null;
  publishOverlay(null);
  matchingRun.disabled = false;
  matchingExport.disabled = true;
  matchingResults.replaceChildren();
  comparison.replaceChildren();
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
  let stage = 'load';
  try {
    const data = await send({ type: 'AGENT_MATCHING_DIAGNOSTICS', date });
    if (id !== matchingSequence) return;
    matchingData = { date, ...data };
    matchingExport.disabled = false;
    stage = 'render';
    // The raw observed rows and timer boundaries are the source of truth.
    // A precomputed summary is not required to render, including after a
    // worker restart or reload during development.
    const start = new Date(date + 'T00:00:00');
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const dayStart = Number.isFinite(data.dayStart) ? data.dayStart : start.getTime();
    const dayEnd = Number.isFinite(data.dayEnd) ? data.dayEnd : end.getTime();
    const intervals=data.tasks.flatMap(task=>task.intervals);
    const rows=data.rows.filter(row=>turnOverlapsTrackedIntervals(row,intervals,dayStart,dayEnd));
    const normalized = { ...data, dayStart, dayEnd, rows, totalTurns: rows.length+(data.omittedTurns||0),
      outsideTurns: (data.outsideTurns||0)+data.rows.length-rows.length };
    matchingData = { date, ...normalized, tasks: normalized.tasks.map(task => ({
      ...task, observedTimeline: buildObservedTaskTimeline(task, normalized.rows, dayStart, dayEnd),
    })) };
    renderMatching(normalized);
  } catch (error) {
    if (id === matchingSequence) {
      matchingStatus.textContent = stage === 'render'
        ? 'Activity data loaded, but timeline rendering failed. Download debug JSON and check the Activity console.'
        : 'Activity data could not be loaded. Check source access and task history, then retry.';
      // Do not log raw records, prompts or credential-bearing error bodies.
      console.warn('Clockoli matching ' + stage + ' failed: ' + (error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError' : 'Error'));
    }
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
    // Replace the same entry view instead of rendering a second copy.
    semanticPreview.hidden=true;
    renderMatching(data,decisions);
    document.getElementById('agent-entry-debug').open=false;
    document.getElementById('semantic-matching-controls').open=false;
    // Normal debug download contains no prompts, model explanations or raw
    // descriptions. Keep only structured decisions and usage.
    const {preview,...safeData}=data;
    matchingData={date:matchingDate.value,...safeData,
      tasks:safeData.tasks.map(({description,...task})=>({...task,semanticTimeline:buildTaskTimeline(task.intervals,data.rows.filter(r=>decisions.get(r.turnId)?.url===task.url),data.dayStart,data.dayEnd),semanticObservedTimeline:buildObservedTaskTimeline(task,data.rows,data.dayStart,data.dayEnd,decisions)})),
      semantic:{provider:p,model,usage,failures,decisions:[...decisions].map(([turnId,{url,modelUrl,reason,confidence,cached}])=>({turnId,url,modelUrl,reason,confidence,cached}))}};
    matchingExport.disabled=false;
    semanticStatus.textContent=decisions.size+' analyzed · '+[...decisions.values()].filter(d=>d.url).length+' proposed matches · '+usage.input+' input / '+usage.output+' output tokens this run'+(usage.unknown?' (some usage unavailable)':'')+(failures.length?' · stopped on error':'');
  }finally{apiKey='';semanticRunning=false;semanticPrepare.disabled=false;syncSemantic();}
});

const attributionLabels={model_unrelated:'Model: unrelated work',matched:'Proposed match',unassigned:'Time overlap only / unresolved',model_unassigned:'Model: unassigned',other_task:'Attributed to another task'};
function renderTaskTimeline(timeline,parent) {
  const summary=node('div',null,parent,'agent-entry-kpis');
  for(const [label,value] of [['Tracked time',time(timeline.trackedMs)],['AI turn coverage (all observed)',time(timeline.coveredMs)+' ('+percent(timeline.coveragePct)+')'],['Proposed task AI time',time(timeline.matchedCoveredMs)],['AI turns',count(timeline.observedTurns)]]){
    const kpi=node('div',null,summary);node('span',label,kpi);node('strong',value,kpi);
  }
  for(const window of timeline.windows){
    const block=node('div',null,parent,'agent-task-window');
    if(window.start!==window.trackedStart||window.end!==window.trackedEnd)node('span','Shown on selected day: '+localTime(window.start)+' – '+localTime(window.end),block);
    const axis=node('div',null,block,'agent-entry-axis');
    for(let i=0;i<=4;i++)node('span',clockTime(window.start+(window.end-window.start)*i/4),axis);
    const bar=node('div',null,block,'agent-task-bar');
    bar.setAttribute('aria-label','Observed AI turn intervals within this tracked entry');
    const lanes=[];
    for(const segment of window.segments){
      let lane=lanes.findIndex(end=>end<=segment.visibleStart);
      if(lane<0)lane=lanes.length;
      lanes[lane]=segment.visibleEnd;
      const mark=node('div',null,bar,'agent-task-turn is-'+segment.attribution);
      mark.style.left=100*(segment.visibleStart-window.start)/window.trackedMs+'%';
      mark.style.width=100*(segment.visibleEnd-segment.visibleStart)/window.trackedMs+'%';
      mark.style.top=lane*15+'px';
      mark.title=segment.provider+' · '+clockTime(segment.start,true)+' – '+clockTime(segment.end,true)+' · '+time(segment.end-segment.start)+' · '+(attributionLabels[segment.attribution]||'Observed');
    }
    bar.style.height=Math.max(15,lanes.length*15)+'px';
    const legend=node('div',null,block,'agent-task-legend');
    for(const key of new Set(window.segments.map(t=>t.attribution))){
      const item=node('span',null,legend);node('i',null,item,'agent-task-swatch is-'+key);
      item.append(document.createTextNode(attributionLabels[key]||'Observed AI'));
    }
    const gap=node('span',null,legend);node('i',null,gap,'agent-task-swatch is-gap');gap.append(document.createTextNode('No observed AI turn'));
    const sequence=[...window.covered.map(i=>({...i,ai:true})),...window.gaps.map(i=>({...i,ai:false}))].sort((a,b)=>a.start-b.start);
    const details=node('details',null,block,'agent-task-interval-list');
    details.open=false;
    node('summary','All observed activity and gaps (including rejected turns; '+sequence.length+' intervals)',details);
    const table=node('table',null,details,'agent-entry-sequence');
    const header=node('tr',null,node('thead',null,table));
    for(const label of ['From','To','Duration','Activity'])node('th',label,header);
    const body=node('tbody',null,table);
    for(const e of sequence){
      const row=node('tr',null,body,e.ai?'is-ai':'is-gap');
      node('td',clockTime(e.start,true),row);node('td',clockTime(e.end,true),row);node('td',time(e.end-e.start),row);
      const n=e.ai?window.segments.filter(t=>t.visibleStart<e.end&&t.visibleEnd>e.start).length:0;
      node('td',e.ai?'AI interval · '+n+' turn'+(n===1?'':'s'):'No observed turn',row);
    }
  }
  if(timeline.unverified.length)node('p',timeline.unverified.length+' observations have unverified timing; see turn details. No duration inferred.',parent);
  const attribution=node('details',null,parent,'agent-matching-debug');
  node('summary','Attribution summary',attribution);
  node('p',timeline.matchedTurns+' proposed matches · '+timeline.unresolvedTurns+' unresolved · '+timeline.otherTaskTurns+' attributed elsewhere · '+timeline.rejectedTurns+' model-rejected',attribution);
  node('p','Proposed matched coverage: '+time(timeline.matchedCoveredMs)+' · sum of full observed turn durations: '+time(timeline.observedTurnMs),attribution);
}
let statusPending=false;
async function refreshConnection(){
  if(statusPending)return;
  statusPending=true;
  try{
    const data=await send({type:'AGENT_MATCHING_STATUS'});
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
