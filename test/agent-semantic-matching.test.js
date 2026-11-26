import assert from 'node:assert/strict';
import {test} from 'node:test';
import {classifySemantic,validateDecisions,validateSemanticRequest,createSemanticExtractor,semanticContext,makeSemanticBatches,redactSemanticText,LLM_HOSTS} from '../src/agents/semantic-matching.js';
import {extractCodexMatchingRow,matchingEvidenceByTurn} from '../src/agents/task-matching.js';
const payload={tasks:[{id:'c1',title:'Agent review UI',description:null}],turns:[{id:'t1',repository:'clockoli/wip',branchIssueNumbers:[],messages:[{text:'Fix agent review',kind:'direct_event',truncated:false}],previousContext:[],candidates:['c1']}]};
const request={type:'AGENT_SEMANTIC_CLASSIFY',provider:'openai',model:'test-model',apiKey:'fixture-only-key',rootId:'fixture-root',payload,confirmed:true};
const response={decisions:[{turn_id:'t1',task_id:'c1',reason:'direct',confidence:'high',explanation:'Matching agent review'}]};
test('all providers use only their fixed endpoint and proper authentication, no redirects or cookies',async()=>{
  for(const [provider,url] of Object.entries({openai:'https://api.openai.com/v1/chat/completions',openrouter:'https://openrouter.ai/api/v1/chat/completions',anthropic:'https://api.anthropic.com/v1/messages'})){
    const result=await classifySemantic({...request,provider},{hasPermission:async origin=>origin===LLM_HOSTS[provider],fetchImpl:async (actual,opts)=>{
      assert.equal(actual,url);assert.equal(opts.redirect,'error');assert.equal(opts.credentials,'omit');
      assert.equal(provider==='anthropic'?opts.headers['x-api-key']:opts.headers.Authorization,provider==='anthropic'?request.apiKey:'Bearer '+request.apiKey);
      const b=JSON.parse(opts.body);assert.equal(b.model,'test-model');assert.equal(JSON.stringify(b).includes(request.apiKey),false);
      return new Response(JSON.stringify(provider==='anthropic'?{content:[{type:'text',text:JSON.stringify(response)}],usage:{input_tokens:10,output_tokens:5}}:{choices:[{message:{content:JSON.stringify(response)}}],usage:{prompt_tokens:10,completion_tokens:5}}));
    }});
    assert.equal(result.decisions[0].task_id,'c1');assert.equal(result.usage.inputTokens,10);assert.equal(JSON.stringify(result).includes(request.apiKey),false);
  }
});
test('consent, endpoint, host permission and response candidate restrictions fail closed',async()=>{
  for(const bad of [{...request,confirmed:false},{...request,provider:'https://evil.example'},{...request,url:'https://evil.example'},{...request,model:' bad'}])assert.throws(()=>validateSemanticRequest(bad));
  await assert.rejects(classifySemantic(request,{fetchImpl:()=>assert.fail('no network before permission')}),/permission/);
  for(const bad of [{decisions:[]},{decisions:[{...response.decisions[0],task_id:'c2'}]},{decisions:[{...response.decisions[0],reason:'unrelated'}]}])assert.throws(()=>validateDecisions(JSON.stringify(bad),payload));
  assert.equal(validateDecisions(JSON.stringify({decisions:[{...response.decisions[0],confidence:'low'}]}),payload)[0].task_id,null);
  await assert.rejects(classifySemantic(request,{hasPermission:async()=>true,fetchImpl:async()=>new Response('private raw error',{status:401})}),/Provider HTTP 401/);
});
test('transient extraction excludes environment and tool output, uses explicit lifecycle fallback and prior context',()=>{
  const extractor=createSemanticExtractor(extractCodexMatchingRow);
  const event=(type,id,ts)=>({type:'event_msg',timestamp:'2026-11-26T10:00:'+ts+'Z',payload:{type,turn_id:id}});
  const rows=[
    {type:'session_meta',payload:{id:'session',cwd:'/private'}},
    event('task_started','a','00'),
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context>ignored'}]}},
    {type:'event_msg',payload:{type:'user_message',turn_id:'a',message:'Fix agent review'}},
    {type:'response_item',payload:{type:'function_call_output',output:'PRIVATE_OUTPUT'}},
    event('task_complete','a','01'),event('task_started','b','02'),
    {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Continue testing'}]}},
    event('task_complete','b','03'),
  ].map(extractor).filter(Boolean);
  const items=semanticContext(matchingEvidenceByTurn(rows));
  assert.equal(items[0].semanticMessages[0].text,'Fix agent review');
  assert.equal(items[1].semanticMessages[0].kind,'unverified_user_role');
  assert.equal(items[1].previousContext[0].text,'Fix agent review');
  assert.equal(JSON.stringify(items).includes('PRIVATE_OUTPUT'),false);
  assert.equal(JSON.stringify(items).includes('ignored'),false);
  assert.equal(redactSemanticText('api_key=secret123 /Users/example/file').text.includes('secret123'),false);
});
test('batch only verified contained turns, separate provider task IDs from local URLs',()=>{
  const item={startedAt:0,endedAt:1000,repository:'clockoli/wip',branchNumbers:[],semanticMessages:payload.turns[0].messages,previousContext:[]};
  const task={url:'https://github.com/example/issues/issues/25',title:'Agent tracking'};
  const turn={upstreamTurnId:'a',sessionKey:'s',startedAt:new Date(0).toISOString(),endedAt:new Date(1000).toISOString(),elapsedMs:1000,status:'completed'};
  const result=makeSemanticBatches([task],[{turn,item,match:{candidates:[{url:task.url,contained:true}]}},{turn:{...turn,upstreamTurnId:'b'},item,match:{candidates:[]}}]);
  assert.equal(result.batches.length,1);assert.deepEqual(result.skipped,['b']);
  assert.equal(JSON.stringify(result.batches[0].payload).includes(task.url),false);
});
