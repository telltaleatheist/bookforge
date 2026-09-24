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
const classes=['pages','clean','translate','simplify','analysis'];
const chosen=(cls:string)=>cls==='pages'?'dots-ocr':cls==='clean'?'qwen3.5-9b':'qwen3.8-27b-4bit';

function fixture(options:{missing?:boolean;competing?:boolean;competitorStocks?:boolean;failCompetitor?:boolean;leased?:boolean;chatMaxInFlight?:number|null;noActivity?:boolean;oldActivity?:boolean;leaseOnLoad?:boolean}={}) {
  let stocked=!options.missing, competed=false, loaded:string|null=null, loadLease:string|null=null;
  const calls:{method:string;path:string;body:any}[]=[];
  const revision='a'.repeat(40);
  const model=(id:string)=>({id,family:'fixture',params_b:9,revision,fingerprint:`${id}@${revision}`,modalities:id==='dots-ocr'?['text','image']:['text'],backend_supported:true,installed:id!=='qwen3.8-27b'&&stocked,resident:false,loadable:true,memory_bytes_estimate:1,context_default:8192,max_model_len:8192});
  const models=()=>['dots-ocr','qwen3.5-9b','qwen3.8-27b-4bit','qwen3.8-27b'].map(model);
  const info=()=>({server:{name:'fixture',version:'0.6.2',api_version:1},host:{platform:'win32',arch:'x86_64',backend:'llama-windows',gpu:{vendor:'nvidia',name:'fake',vram_bytes:24e9}},role:'engine',managed_by:null,job_types:['load-model','unload-model'],capabilities:[{job_type:'llm',models:models()}]});
  const capability=()=>({backend_kind:'llama-windows',total_bytes:24e9,desktop_allowance_bytes:0,classes:classes.map(capability=>({capability,enabled:true,selected:chosen(capability),reason:'fixture',shortfall_bytes:0,route:'local'}))});
  const task=(id:string,state='done')=>({task_id:id,type:'module',request:{type:'module'},state,error:null,created:'2026-09-16T00:00:00Z',started:'2026-09-16T00:00:00Z',finished:state==='running'?null:'2026-09-16T00:00:01Z',unmet:[]});
  const sse=(event:string,data:any={})=>new Response(`id: 1\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`,{headers:{'content-type':'text/event-stream'}});
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
      return Response.json({server:{name:'fixture',version:'1.0.13',api_version:1,backend:'llama-windows',uptime_s:1},resident:null,stopping:null,warming:null,claim:null,streaming:null,chat:{in_flight:0,rows:[],max_in_flight:options.chatMaxInFlight===undefined?2:options.chatMaxInFlight,max_in_flight_basis:'engine concurrency 1, +1'},lease:null,slots:{accelerated:{busy:0,of:1,queue_depth:0,accepts_work:true}},running:[],queued:[]});
    }
    if(p==='/v1/models')return Response.json(models());
    if(p==='/v1/catalog')return Response.json({backend_kind:'llama-windows',rows:models().map(m=>({kind:'model',id:m.id,name:m.id,job_type:'llm',installed:m.installed,installed_bytes:m.installed?1:null,expected_bytes:1,floors:[],license:null,source:'fixture',resident:false})).concat([{kind:'engine',id:'llama-cpp',name:'engine',job_type:'llm',installed:true,installed_bytes:1,expected_bytes:1,floors:[],license:null,source:'fixture',resident:false}])});
    if(p==='/v1/tasks'&&req.method==='POST'){
      if(options.competing&&!competed){competed=true;return Response.json({error:{code:'task_busy',message:'BookForge preparation active',details:{task_id:'other'}}},{status:409});}
      return Response.json({task_id:'ours'},{status:202});
    }
    if(p==='/v1/tasks')return Response.json({tasks:[task('other','running')]});
    if(p==='/v1/tasks/other/events'){if(options.competitorStocks)stocked=true;return options.failCompetitor?sse('failed',{code:'pull_failed',message:'fixture failed'}):sse('done');}
    if(p==='/v1/tasks/ours/events'){stocked=true;return sse('done');}
    if(p.startsWith('/v1/tasks/'))return Response.json(task(p.split('/')[3]!));
    /*
     * LEASE-ON-LOAD (Crucible 1.0.13). The load's own `params.lease` is what
     * decides whether the `done` frame carries a `lease_id` — so a test that
     * reads the id off the frame is reading a consequence of the param the
     * dispatcher actually sent, not a constant the fixture made up.
     * `leaseOnLoad:false` is a server that ignores the option (or an older one),
     * which must leave the placement taking its own lease exactly as before.
     */
    /*
     * A 409 `leased` ON THE LOAD DOOR, which is where a placement meets it now:
     * with the lease on the load there is no separate lease POST to be refused
     * on, and a `load-model` that would evict a leased model is refused by the
     * same code with the same body (crucible/leases.py, `leased_error`).
     */
    if(p==='/v1/jobs'&&options.leased)return Response.json({error:{code:'leased',message:"'dots-ocr' (the resident llm) is leased by 'bookforge' for 'tts' since 2026-09-18T03:00:00+00:00, until at least 2026-09-18T03:02:00+00:00",details:{lease_id:'someone-elses',kind:'llm',client:'bookforge',act:'tts',since:'2026-09-18T03:00:00+00:00',expires_at:'2026-09-18T03:02:00+00:00'}}},{status:409});
    if(p==='/v1/jobs'){loaded=body?.model??null;loadLease=options.leaseOnLoad===false?null:(body?.params?.lease?'load-lease':null);return Response.json({job_id:'load'},{status:202});}
    if(p==='/v1/jobs/load/events')return sse('done',loadLease===null?{resident:loaded}:{resident:loaded,lease_id:loadLease});
    // `leased`, with the six fields `Lease.to_dict()` attaches (crucible/leases.py).
    // The code is `leased` and not `model_leased`: the leased thing is a voice or
    // an aligner as often as a model, which is why the rename happened at all.
    if(p.endsWith('/lease')&&req.method==='POST'&&options.leased)return Response.json({error:{code:'leased',message:"'dots-ocr' (the resident llm) is leased by 'bookforge' for 'tts' since 2026-09-18T03:00:00+00:00, until at least 2026-09-18T03:02:00+00:00",details:{lease_id:'someone-elses',kind:'llm',client:'bookforge',act:'tts',since:'2026-09-18T03:00:00+00:00',expires_at:'2026-09-18T03:02:00+00:00'}}},{status:409});
    if(p.endsWith('/lease')&&req.method==='POST')return Response.json({lease_id:'lease',kind:'llm',subject:p.split('/')[3],client:'fixture',act:body.act,since:'2026-09-16T00:00:00Z',expires_at:'2026-09-16T00:02:00Z'},{status:201});
    if(p.startsWith('/v1/leases/')&&p.endsWith('/heartbeat')&&req.method==='POST')return Response.json({expires_at:'2026-09-16T00:04:00Z'});
    if(p.startsWith('/v1/leases/')&&req.method==='DELETE')return new Response(null,{status:204});
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
 * ── THE LOAD CARRIES THE LEASE, AND THE PLACEMENT ADOPTS IT — PK14a ─────────
 *
 * It used to be two requests: `POST /v1/jobs` (load-model), then
 * `POST /v1/models/{id}/lease` once the `done` frame landed. Between them the
 * card was held by NOTHING, and a client that died in that window stranded it
 * for ever — a load's own completion is deliberately not a settlement trigger.
 * Crucible 1.0.13 lets the load ask for the lease itself, so the act's name and
 * its ttl travel ON the load and the id comes back on the `done` frame.
 *
 * So the assertion that used to read the act off the lease POST now reads it off
 * the LOAD, and the absence of that POST is asserted outright: a placement that
 * took a second lease on a card its own load already holds would be refused
 * `409 leased` by itself.
 */
for(const [kind,cls] of [['read','pages'],['clean','clean'],['translate','translate'],['simplify','simplify'],['analysis','analysis']] as const){
  test(`real HTTP native Windows ${kind} loads the exact selected model under a lease the load itself took`,async()=>{
    const f=fixture();try{
      const result=await dispatch.placeJob(kind,f.entry.name,()=>{},()=>true);
      expect(result.verdict).toBe('go');if(result.verdict!=='go')throw Error(JSON.stringify(result));
      try{expect(result.placement.model).toBe(chosen(cls));expect(result.placement.endpoint).toBe(`${f.entry.url}/openai`);
        const load=f.calls.find(c=>c.path==='/v1/jobs')!;
        expect(load.body.model).toBe(chosen(cls));
        // THE ACT AND THE TTL, on the load, in the server's own spelling.
        expect(load.body.params.lease).toEqual({act:cls,ttl_seconds:120});
        // ADOPTED, NOT RE-TAKEN: the id is the one the done frame handed back.
        expect(result.placement.lease?.id).toBe('load-lease');
        expect(f.calls.some(c=>c.path.endsWith('/lease')&&c.method==='POST')).toBe(false);
      }finally{await result.placement.lease?.release();}
      expect(f.calls.some(c=>c.path==='/v1/leases/load-lease'&&c.method==='DELETE')).toBe(true);
    }finally{f.close();}
  });
}

/**
 * A SERVER THAT LEASES NOTHING ON THE LOAD LEAVES THE OLD ROAD EXACTLY WHERE IT
 * WAS. `lease_id` absent from the `done` frame is an answer — an older Crucible,
 * or a load submitted without the option — and the separate
 * `POST /v1/models/{id}/lease` is what it is still for. Without this, "adopt"
 * would be a silent requirement that every server be 1.0.13.
 */
test('real HTTP a done frame with no lease_id still takes the lease the old way',async()=>{
  const f=fixture({leaseOnLoad:false});try{
    const result=await dispatch.placeJob('clean',f.entry.name,()=>{},()=>true);
    expect(result.verdict).toBe('go');if(result.verdict!=='go')throw Error(JSON.stringify(result));
    try{
      expect(f.calls.some(c=>c.path==='/v1/models/qwen3.5-9b/lease'&&c.method==='POST')).toBe(true);
      expect(result.placement.lease?.id).toBe('lease');
    }finally{await result.placement.lease?.release();}
    expect(f.calls.some(c=>c.path==='/v1/leases/lease'&&c.method==='DELETE')).toBe(true);
  }finally{f.close();}
});

/**
 * AN ADOPTED LEASE IS KEPT ALIVE LIKE ANY OTHER — the half of "same heartbeat,
 * same release" that only a beat can prove. A lease whose id came from a load
 * and is then never heartbeaten lapses in two minutes, and since 1.0.13 a lapse
 * CLEARS THE CARD: the run would lose the model it is three blocks into using,
 * and nothing in the placement would say so.
 *
 * The interval callback is captured rather than waited for — the cadence is 40 s
 * and a keeper that waited it out would cost more than the bug — and what is
 * asserted is the URL it goes to, because the whole question is WHICH id is
 * being kept alive.
 */
test('real HTTP an adopted lease heartbeats and releases the load\'s own id',async()=>{
  const f=fixture();
  let beat:(()=>void)|null=null;
  spyOn(globalThis,'setInterval').mockImplementation(((callback:()=>void)=>{beat=callback;return {unref(){}};}) as typeof setInterval);
  spyOn(globalThis,'clearInterval').mockImplementation(()=>{});
  try{
    const lease=await dispatch.takeLease(f.entry,'qwen3.5-9b','clean','load-lease');
    expect(lease.id).toBe('load-lease');
    // NOTHING WAS TAKEN: adopting is not a cheaper take, it is no take at all.
    expect(f.calls.some(c=>c.path.endsWith('/lease')&&c.method==='POST')).toBe(false);
    expect(beat).not.toBeNull();
    beat!();
    // A REAL ROUND TRIP, not a microtask: the beat is fire-and-forget by design
    // (a lost heartbeat must never stop a run), so the only thing to wait on is
    // the request arriving at the fixture.
    const beaten=async()=>{for(let i=0;i<200;i+=1){if(f.calls.some(c=>c.path==='/v1/leases/load-lease/heartbeat'))return true;await Bun.sleep(5);}return false;};
    expect(await beaten()).toBe(true);
    expect(f.calls).toContainEqual({method:'POST',path:'/v1/leases/load-lease/heartbeat',body:null});
    await lease.release();
    expect(f.calls.some(c=>c.path==='/v1/leases/load-lease'&&c.method==='DELETE')).toBe(true);
  }finally{f.close();}
});

/**
 * A 409 `leased` IS READ, WHICH IT WAS NOT — the keeper for the twenty-line
 * branch that keyed on `model_leased`, a code Crucible has never emitted: the
 * server renamed it to `leased` on 2026-09-14 because the leased thing is a
 * voice or an aligner as often as a model (crucible/leases.py, `leased_error`).
 * The dead branch meant a real refusal fell to the generic arm — which waited by
 * luck, because `leased` happens to be in the SDK's server-specific set — and
 * the "leased by whom, for what, until when" sentence the body carries was
 * never read. The assertion is on the sentence, because the sentence is the
 * whole of what the branch is for.
 */
test('a 409 leased on the lease door waits and names who holds the card, for what, until when',async()=>{
  const f=fixture({leased:true});try{
    const result=await dispatch.placeJob('read',f.entry.name,()=>{},()=>true);
    expect(result.verdict).toBe('wait');if(result.verdict!=='wait')throw Error(JSON.stringify(result));
    expect(result.standing).toBe(false);
    // THE WHOLE SENTENCE, not a substring of it: the server's own message names
    // the holder too, so anything looser passes on the generic arm this branch
    // exists to replace — which is exactly how a dead branch stays dead.
    expect(result.reason).toBe(`the resident llm on "${f.entry.name}" is leased: bookforge, tts, until 2026-09-18T03:02:00+00:00`);
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
    }finally{await result.placement.lease?.release();}
  }finally{f.close();}
});

test('real HTTP a server that states no chat depth leaves the placement on four',async()=>{
  const f=fixture({chatMaxInFlight:null});try{
    const result=await dispatch.placeJob('translate',f.entry.name,()=>{},()=>true);
    expect(result.verdict).toBe('go');if(result.verdict!=='go')throw Error(JSON.stringify(result));
    try{expect(result.placement.concurrency).toBe(dispatch.CRUCIBLE_CHAT_CONCURRENCY);}
    finally{await result.placement.lease?.release();}
  }finally{f.close();}
});

test('real HTTP a Crucible older than the route is "it did not say", not a refused placement',async()=>{
  const f=fixture({noActivity:true});try{
    const result=await dispatch.placeJob('simplify',f.entry.name,()=>{},()=>true);
    expect(result.verdict).toBe('go');if(result.verdict!=='go')throw Error(JSON.stringify(result));
    try{expect(result.placement.concurrency).toBe(dispatch.CRUCIBLE_CHAT_CONCURRENCY);}
    finally{await result.placement.lease?.release();}
  }finally{f.close();}
});

/**
 * ── A SERVER THIS BUILD CANNOT FULLY READ STILL PLACES (Owen, 2026-09-24) ──
 *
 * *"dont require any particular crucible server. if it can make the call to the
 * crucible server then it should work."* This used to REFUSE the placement as
 * `CrucibleTooOld`. The activity read is a courtesy — the admission bound — so a
 * document the SDK cannot parse leaves the run on its default depth, exactly as
 * the 404 control above does, and the load and the lease go ahead.
 */
test('real HTTP a server whose activity document this build cannot read still places, at the default depth',async()=>{
  const f=fixture({oldActivity:true});try{
    const result=await dispatch.placeJob('translate',f.entry.name,()=>{},()=>true);
    expect(result.verdict).toBe('go');if(result.verdict!=='go')throw Error(JSON.stringify(result));
    try{expect(result.placement.concurrency).toBe(dispatch.CRUCIBLE_CHAT_CONCURRENCY);}
    finally{await result.placement.lease?.release();}
  }finally{f.close();}
});

/**
 * A READING STATES NO CHAT DEPTH AT ALL, and never asks. `--vlm-concurrency` is
 * the page reader's own flag and the engine takes it from the server that serves
 * the pages; a chat depth on a `pages` placement would be a number about the
 * wrong door.
 */
test('real HTTP a reading placement states no chat depth and does not ask for one',async()=>{
  const f=fixture({chatMaxInFlight:2});try{
    const result=await dispatch.placeJob('read',f.entry.name,()=>{},()=>true);
    expect(result.verdict).toBe('go');if(result.verdict!=='go')throw Error(JSON.stringify(result));
    try{expect(result.placement.concurrency).toBeNull();
      expect(f.calls.some(c=>c.path==='/v1/activity')).toBe(false);
    }finally{await result.placement.lease?.release();}
  }finally{f.close();}
});
