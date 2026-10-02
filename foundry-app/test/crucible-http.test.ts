import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';

mock.module('electron', () => ({app:{getPath:(name:string)=>path.join(os.tmpdir(),'foundry-http-test',name),getName:()=> 'Foundry',getVersion:()=> 'test',getAppPath:()=>path.dirname(import.meta.dir),isPackaged:false,on:()=>{},whenReady:async()=>{}},BrowserWindow:class{},dialog:{},ipcMain:{handle:()=>{},on:()=>{}},nativeImage:{},net:{},protocol:{},session:{},shell:{}}));
const registry=await import('../electron/crucible-registry');
const settings=await import('../electron/app-settings');
const setup=await import('../electron/setup');
const coordinate=await import('../electron/crucible-coordinate');
const dispatch=await import('../electron/crucible-dispatch');
afterEach(()=>mock.restore());
const classes=['pages','clean','translate','simplify','analysis','decide'];
const chosen=(cls:string)=>cls==='pages'?'dots-ocr':cls==='clean'?'qwen3.5-9b':cls==='decide'?'qwen3.5-2b':'qwen3.8-27b-4bit';

function fixture(options:{missing?:boolean;competing?:boolean;competitorStocks?:boolean;failCompetitor?:boolean;held?:boolean;chatMaxInFlight?:number|null;admitsOnlyWhenResident?:number;noActivity?:boolean;oldActivity?:boolean}={}) {
  let stocked=!options.missing, competed=false, loaded:string|null=null;
  const calls:{method:string;path:string;body:any}[]=[];
  const revision='a'.repeat(40);
  const model=(id:string)=>({id,family:'fixture',params_b:9,revision,fingerprint:`${id}@${revision}`,modalities:id==='dots-ocr'?['text','image']:['text'],backend_supported:true,installed:id!=='qwen3.8-27b'&&stocked,weights_of:null,resident:false,loadable:true,memory_bytes_estimate:1,context_default:8192,max_model_len:8192});
  const models=()=>['dots-ocr','qwen3.5-9b','qwen3.8-27b-4bit','qwen3.8-27b'].map(model);
  const info=()=>({server:{name:'fixture',version:'1.0.76',api_version:1},features:['queue.sessions','queue.calls','queue.jobs','events'],host:{platform:'win32',arch:'x86_64',backend:'llama-windows',gpu:{vendor:'nvidia',name:'fake',vram_bytes:24e9}},role:'engine',managed_by:null,job_types:['load-model','unload-model'],capabilities:[{job_type:'llm',models:models()}],pages_engine:{engine:'llama-cpp',installed:true,detail:'fixture',request:{model:'dots-ocr',dpi:200,max_pixels:11289600,max_tokens:8192,temperature:0,prompt:'fixture',dialect:'dots-json',concurrency:1,truncated_finish_reason:'length'}}});
  const capability=()=>({backend_kind:'llama-windows',total_bytes:24e9,desktop_allowance_bytes:0,classes:classes.map(capability=>({capability,enabled:true,selected:chosen(capability),reason:'fixture',shortfall_bytes:0,route:'local',work:null,context_ceilings:null}))});
  const task=(id:string,state='done')=>({task_id:id,type:'module',request:{type:'module'},state,error:null,created:'2026-09-16T00:00:00Z',started:'2026-09-16T00:00:00Z',finished:state==='running'?null:'2026-09-16T00:00:01Z',unmet:[],message:null});
  const sse=(event:string,data:any={})=>new Response(`id: 1\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`,{headers:{'content-type':'text/event-stream'}});
  // A queue session's state document, every field Crucible 1.0.76 sends.
  const sessionDoc=(id:string,status:string,act:string,more:Record<string,unknown>={})=>({session_id:id,status,act,client:'fixture',model:loaded,position:null,idle_s:300,max_wait_s:86400,created:'2026-10-01T00:00:00Z',opened_at:'2026-10-01T00:00:00Z',idle_deadline:null,max_hold_deadline:null,items_run:0,in_flight:[],stream_session:null,load_job:null,closed_at:null,reason:null,message:null,error:null,...more});
  // An open session's own stream, held open until the client lets go of it.
  const quiet=()=>new Response(new ReadableStream({start(){}}),{headers:{'content-type':'text/event-stream'}});
  let sessionAct='';
  const server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){
    expect(req.headers.get('authorization')).toBe('Bearer fixture-token');
    expect(req.headers.get('x-crucible-api')).toBe('1');
    const url=new URL(req.url);const p=url.pathname;const body=req.method==='POST'?await req.json().catch(()=>null):null;calls.push({method:req.method,path:p,body});
    if(p==='/v1/info')return Response.json(info());
    if(p==='/v1/capability')return Response.json(capability());
    // `chat.max_in_flight` is spelled as Crucible 1.0.10 spells it on the wire.
    // `noActivity` is a server older than that route: it answers 404, which is
    // "it did not say" and must leave the placement on its own default.
    if(p==='/v1/activity'){
      if(options.noActivity)return Response.json({error:{code:'not_found',message:'no such route'}},{status:404});
      /*
       * A CRUCIBLE OLDER THAN THIS BUILD: the route is there and answers 200,
       * and the document is missing fields a 1.0.13 SDK reads (`stopping`,
       * `chat.max_in_flight`, `resident.unclaimed_since`). Since Owen's
       * 2026-09-24 ruling that is "it did not say", exactly like a 404.
       */
      if(options.oldActivity)return Response.json({server:{name:'fixture',version:'1.0.9',api_version:1,backend:'llama-windows',uptime_s:1},resident:null,warming:null,claim:null,streaming:null,chat:{in_flight:0,rows:[]},lease:null,slots:{accelerated:{busy:0,of:1,queue_depth:0,accepts_work:true}},running:[],queued:[]});
      return Response.json({server:{name:'fixture',version:'1.0.76',api_version:1,backend:'llama-windows',uptime_s:1},resident:null,stopping:null,warming:null,claim:null,streaming:null,chat:{in_flight:0,rows:[],max_in_flight:options.admitsOnlyWhenResident!==undefined?(loaded!==null?options.admitsOnlyWhenResident:null):options.chatMaxInFlight===undefined?2:options.chatMaxInFlight,max_in_flight_basis:'engine concurrency 1, +1'},session:null,slots:{accelerated:{busy:0,of:1,queue_depth:0,accepts_work:true}},running:[],queued:[]});
    }
    if(p==='/v1/models')return Response.json(models());
    if(p==='/v1/catalog')return Response.json({backend_kind:'llama-windows',rows:models().map(m=>({kind:'model',id:m.id,name:m.id,job_type:'llm',installed:m.installed,installed_bytes:m.installed?1:null,expected_bytes:1,shares_weights_of:null,missing_files:null,floors:[],license:null,source:'fixture',resident:false})).concat([{kind:'engine',id:'llama-cpp',name:'engine',job_type:'llm',installed:true,installed_bytes:1,expected_bytes:1,shares_weights_of:null,missing_files:null,floors:[],license:null,source:'fixture',resident:false}])});
    if(p==='/v1/tasks'&&req.method==='POST'){
      if(options.competing&&!competed){competed=true;return Response.json({error:{code:'task_busy',message:'BookForge preparation active',details:{task_id:'other'}}},{status:409});}
      return Response.json({task_id:'ours'},{status:202});
    }
    if(p==='/v1/tasks')return Response.json({tasks:[task('other','running')]});
    if(p==='/v1/tasks/other/events'){if(options.competitorStocks)stocked=true;return options.failCompetitor?sse('failed',{code:'pull_failed',message:'fixture failed'}):sse('done');}
    if(p==='/v1/tasks/ours/events'){stocked=true;return sse('done');}
    if(p.startsWith('/v1/tasks/'))return Response.json(task(p.split('/')[3]!));
    /*
     * QUEUE SESSIONS (Crucible 1.0.76), which replaced the load-then-lease pair.
     * A session named with a `model` opens with it resident — `loaded` is what
     * the activity read's admission depends on. `held` is a machine another
     * client holds: the session waits in the line (#1 of 2) and the line lets it
     * go (`expired`), which is weather.
     */
    if(p==='/v1/queue/sessions'&&req.method==='POST'){
      sessionAct=body.act;
      if(options.held)return Response.json(sessionDoc('ses-held','queued',body.act,{position:1,opened_at:null}),{status:202});
      loaded=body?.model??null;
      return Response.json(sessionDoc('ses-1','open',body.act),{status:201});
    }
    if(p==='/v1/queue/sessions/ses-held/events')return new Response(`id: 1\nevent: queued\ndata: ${JSON.stringify({position:1,of:2})}\n\nid: 2\nevent: removed\ndata: ${JSON.stringify({reason:'expired',message:'nobody followed it'})}\n\n`,{headers:{'content-type':'text/event-stream'}});
    if(p==='/v1/queue/sessions/ses-1/events')return quiet();
    if(p==='/v1/queue/sessions/ses-1/touch')return Response.json(sessionDoc('ses-1','open',sessionAct));
    if(p==='/v1/queue/sessions/ses-1'&&req.method==='DELETE')return Response.json(sessionDoc('ses-1','closed',sessionAct,{closed_at:'2026-10-01T00:01:00Z',reason:'client',message:'closed by its client'}));
    return Response.json({error:{code:'fixture_unhandled',message:`${req.method} ${p}`}},{status:500});
  }});
  const entry={name:`fixture-${server.port}`,url:`http://127.0.0.1:${server.port}`,token:'fixture-token',enabled:true};
  spyOn(registry,'crucibleServers').mockReturnValue([entry]);
  spyOn(registry,'crucibleServerNamed').mockReturnValue(entry);
  spyOn(registry,'slotAvailability').mockReturnValue({slots:[{kind:'crucible',name:entry.name}],refusal:null} as never);
  spyOn(registry,'engineSharedWith').mockReturnValue(null);
  spyOn(settings,'readAppSettings').mockReturnValue({queueGpuDial:'any'} as never);
  spyOn(setup,'modelPreparationReady').mockReturnValue(true);
  return {entry,calls,close:()=>server.stop(true)};
}

test('real HTTP module readiness does not prepare an unselected uninstalled larger variant',async()=>{
  const f=fixture();try{await coordinate.prepareFoundryForUse();expect(f.calls.filter(c=>c.method==='POST')).toEqual([]);}finally{f.close();}
});

test('after following another app task, preparation checks and installs its own remaining demand',async()=>{
  const f=fixture({missing:true,competing:true});try{
    await coordinate.prepareFoundryForUse();
    const posts=f.calls.filter(c=>c.path==='/v1/tasks'&&c.method==='POST');
    expect(posts).toHaveLength(2);expect(posts[1]!.body.module.name).toBe('foundry');
    expect(JSON.stringify(posts[1]!.body)).not.toContain('qwen3.8-27b"');
  }finally{f.close();}
});

/**
 * ── ONE SESSION, OPENED WITH THE MODEL RESIDENT (Crucible 1.0.76) ───────────
 *
 * The load-then-lease pair is gone: a placement asks for a queue SESSION naming
 * the act and the selected model, the server loads it for the session, and while
 * it is open nothing from any other client runs there. Nothing is sent to the
 * old `load-model` or lease routes, and the settle closes the session.
 */
for(const [kind,cls] of [['read','pages'],['clean','clean'],['translate','translate'],['simplify','simplify'],['analysis','analysis']] as const){
  test(`real HTTP native Windows ${kind} opens one session with the exact selected model`,async()=>{
    const f=fixture();try{
      const result=await dispatch.placeJob(kind,f.entry.name,()=>{},()=>true);
      expect(result.verdict).toBe('go');if(result.verdict!=='go')throw Error(JSON.stringify(result));
      try{expect(result.placement.model).toBe(chosen(cls));expect(result.placement.endpoint).toBe(`${f.entry.url}/openai`);
        const opened=f.calls.find(c=>c.path==='/v1/queue/sessions'&&c.method==='POST')!;
        expect(opened.body).toEqual({act:cls,model:chosen(cls),idle_s:300,max_wait_s:86400});
        expect(result.placement.session?.id).toBe('ses-1');
        expect(f.calls.some(c=>c.path==='/v1/jobs'||c.path.includes('/lease'))).toBe(false);
        const headers=JSON.parse(result.placement.env['FOUNDRY_ENDPOINT_HEADERS']!);
        expect(headers['X-Crucible-Client']).toBe(registry.CRUCIBLE_CLIENT_NAME);
      }finally{await result.placement.session?.release();}
      expect(f.calls.some(c=>c.path==='/v1/queue/sessions/ses-1'&&c.method==='DELETE')).toBe(true);
    }finally{f.close();}
  });
}

/**
 * A MACHINE ANOTHER CLIENT HOLDS: the session waits in the line, the placement
 * says where it stands, and a line that lets it go (`expired`) is weather — a
 * wait, never a refusal, so `any` steps past and a pinned row asks again.
 */
test('real HTTP a session that waits in the line says its place, and an expired one waits',async()=>{
  const f=fixture({held:true});const said:string[]=[];try{
    const result=await dispatch.placeJob('read',f.entry.name,(line)=>{said.push(line);},()=>true);
    expect(result.verdict).toBe('wait');if(result.verdict!=='wait')throw Error(JSON.stringify(result));
    expect(result.standing).toBe(false);
    expect(said).toContain(`Waiting for ${f.entry.name}: #1 of 2 in its line`);
    expect(result.reason).toBe(`"${f.entry.name}" let this run's turn go from its line (expired)`);
  }finally{f.close();}
});

/**
 * ── THE POOL DEPTH IS THE SERVER'S, ASKED OVER REAL HTTP — PK8 ──────────────
 *
 * Crucible 1.0.10 admits `chat.max_in_flight` chats per engine and refuses the
 * rest `503 chat_queue_full`. The placement used to state a flat four
 * (`CRUCIBLE_CHAT_CONCURRENCY`, the Sep 8 throughput knee), so on the Mac's
 * serial `mlx-lm` — which admits 2 — four went out, two were admitted and two
 * spent the pass being re-asked until the clean run failed on them.
 *
 * These drive the real placement against a real local server, because the thing
 * that was wrong is a FIELD ON THE WIRE: `@crucible/client` 1.0.10's `Activity`
 * parses `in_flight` and drops `max_in_flight`, so the app reads the document
 * itself, with the token, and a test against a mocked client would prove the
 * mock. The fixture asserts the Authorization and X-Crucible-Api headers on
 * every request it serves, so a depth that arrives at all is a depth that was
 * asked for correctly.
 */
test('real HTTP a chat placement takes the depth the server says it admits',async()=>{
  const f=fixture({chatMaxInFlight:2});try{
    const result=await dispatch.placeJob('clean',f.entry.name,()=>{},()=>true);
    expect(result.verdict).toBe('go');if(result.verdict!=='go')throw Error(JSON.stringify(result));
    try{expect(result.placement.concurrency).toBe(2);
      expect(f.calls.some(c=>c.path==='/v1/activity')).toBe(true);
    }finally{await result.placement.session?.release();}
  }finally{f.close();}
});

/**
 * ADMISSION BELONGS TO THE RESIDENT ENGINE (Crucible, 2026-09-24): with nothing
 * loaded `chat.maxInFlight` is null, and once a model is resident it is that
 * engine's number. The placement read it BEFORE its own load and so always saw
 * null and fell back to four — Owen's cleanup ran at the engine's clamp of two
 * against a server that would have said so. It is read once the session has opened
 * with the model resident.
 */
test('real HTTP a card we load states its admission only once resident, and the placement takes that number',async()=>{
  const f=fixture({admitsOnlyWhenResident:6});try{
    const result=await dispatch.placeJob('clean',f.entry.name,()=>{},()=>true);
    expect(result.verdict).toBe('go');if(result.verdict!=='go')throw Error(JSON.stringify(result));
    try{expect(result.placement.concurrency).toBe(6);}
    finally{await result.placement.session?.release();}
  }finally{f.close();}
});

test('real HTTP a server that states no chat depth leaves the placement on four',async()=>{
  const f=fixture({chatMaxInFlight:null});try{
    const result=await dispatch.placeJob('translate',f.entry.name,()=>{},()=>true);
    expect(result.verdict).toBe('go');if(result.verdict!=='go')throw Error(JSON.stringify(result));
    try{expect(result.placement.concurrency).toBe(dispatch.CRUCIBLE_CHAT_CONCURRENCY);}
    finally{await result.placement.session?.release();}
  }finally{f.close();}
});

test('real HTTP a Crucible older than the route is "it did not say", not a refused placement',async()=>{
  const f=fixture({noActivity:true});try{
    const result=await dispatch.placeJob('simplify',f.entry.name,()=>{},()=>true);
    expect(result.verdict).toBe('go');if(result.verdict!=='go')throw Error(JSON.stringify(result));
    try{expect(result.placement.concurrency).toBe(dispatch.CRUCIBLE_CHAT_CONCURRENCY);}
    finally{await result.placement.session?.release();}
  }finally{f.close();}
});

/**
 * ── A SERVER THIS BUILD CANNOT FULLY READ STILL PLACES (Owen, 2026-09-24) ──
 *
 * *"dont require any particular crucible server. if it can make the call to the
 * crucible server then it should work."* This used to REFUSE the placement as
 * `CrucibleTooOld`. The activity read is a courtesy — the admission bound — so a
 * document the SDK cannot parse leaves the run on its default depth, exactly as
 * the 404 control above does, and the session goes ahead.
 */
test('real HTTP a server whose activity document this build cannot read still places, at the default depth',async()=>{
  const f=fixture({oldActivity:true});try{
    const result=await dispatch.placeJob('translate',f.entry.name,()=>{},()=>true);
    expect(result.verdict).toBe('go');if(result.verdict!=='go')throw Error(JSON.stringify(result));
    try{expect(result.placement.concurrency).toBe(dispatch.CRUCIBLE_CHAT_CONCURRENCY);}
    finally{await result.placement.session?.release();}
  }finally{f.close();}
});

/**
 * A READING STATES NO CHAT DEPTH AT ALL, and never asks. `--vlm-concurrency` is
 * the page reader's own flag and the engine takes it from the server that serves
 * the pages; a chat depth on a `pages` placement would be a number about the
 * wrong door.
 */
/**
 * A CLEANUP'S TRIAGE RUNS ON THE CLEANER'S MODEL (2026-09-25). The server's `decide`
 * class picks the 2B here and its `clean` class the 9B; the triage takes the 9B —
 * measured the model that separates, and the one the cleanup is about to use —
 * while the session's act stays `decide`, which is what the door is asked as.
 */
test('real HTTP a clean-triage is placed on the clean class model, in a session opened as decide',async()=>{
  const f=fixture();try{
    const result=await dispatch.placeJob('clean-triage',f.entry.name,()=>{},()=>true);
    expect(result.verdict).toBe('go');if(result.verdict!=='go')throw Error(JSON.stringify(result));
    try{expect(result.placement.model).toBe('qwen3.5-9b');
      const opened=f.calls.find(c=>c.path==='/v1/queue/sessions')!;
      expect(opened.body.model).toBe('qwen3.5-9b');
      expect(opened.body.act).toBe('decide');
    }finally{await result.placement.session?.release();}
  }finally{f.close();}
});

test('real HTTP a reading placement states no chat depth and does not ask for one',async()=>{
  const f=fixture({chatMaxInFlight:2});try{
    const result=await dispatch.placeJob('read',f.entry.name,()=>{},()=>true);
    expect(result.verdict).toBe('go');if(result.verdict!=='go')throw Error(JSON.stringify(result));
    try{expect(result.placement.concurrency).toBeNull();
      expect(f.calls.some(c=>c.path==='/v1/activity')).toBe(false);
    }finally{await result.placement.session?.release();}
  }finally{f.close();}
});
