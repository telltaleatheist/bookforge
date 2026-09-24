/**
 * ── A CANCELLED PLACEMENT GIVES THE CARD BACK — PK12 ────────────────────────
 *
 * Measured 2026-09-20: a reading was placed on a Crucible, `load-model
 * qwen3.5-9b` went out, and Owen pressed Stop while the progress line read
 * *"vllm loading; 50s elapsed"*. The load COMPLETED in that same second. The
 * placement fired `DELETE /v1/jobs/{id}` without waiting for the answer, threw
 * out of `placeOnCrucible` before `takeLease`, and walked away — leaving
 * `resident: qwen3.5-9b` with `claim: None, lease: None, chat.in_flight: 0,
 * running: []`. Nothing held 21 GB of card, indefinitely, because Crucible's
 * settlement is triggered by a HOLDER LETTING GO and a load's own completion is
 * deliberately not one.
 *
 * These drive the REAL dispatcher against a real local `Bun.serve`, for the same
 * reason `crucible-http.test.ts` does: what was wrong is a sequence of HTTP
 * calls — which ones go out, in which order, and what is read back — and a test
 * against a mocked client would prove the mock. The fixture models the one fact
 * that makes the bug possible: its `DELETE /v1/jobs/load` answers `cancelled`
 * while the job's own record says `done`, so a cleanup that trusts the cancel
 * receipt instead of the job state fails here.
 */
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';

mock.module('electron', () => ({app:{getPath:(name:string)=>path.join(os.tmpdir(),'foundry-cancel-test',name),getName:()=> 'Foundry',getVersion:()=> 'test',getAppPath:()=>path.dirname(import.meta.dir),isPackaged:false,on:()=>{},whenReady:async()=>{}},BrowserWindow:class{},dialog:{},ipcMain:{handle:()=>{},on:()=>{}},nativeImage:{},net:{},protocol:{},session:{},shell:{}}));
const registry=await import('../electron/crucible-registry');
const settings=await import('../electron/app-settings');
const setup=await import('../electron/setup');
const dispatch=await import('../electron/crucible-dispatch');
afterEach(()=>mock.restore());

const classes=['pages','clean','translate','simplify','analysis'];
const chosen=(cls:string)=>cls==='pages'?'dots-ocr':cls==='clean'?'qwen3.5-9b':'qwen3.8-27b-4bit';

/**
 * `loadEnds` is what the server does with the `load-model` job:
 *   `done`      — it lands anyway, which is Owen's case;
 *   `cancelled` — the server honours the DELETE and nothing is resident.
 * `hangRelease` never answers `DELETE /v1/leases/{id}`, which is the deadline's
 * keeper. `resident` is the fixture's card: the lease release settles it to null
 * exactly as Crucible's own settlement does.
 */
function fixture(options:{loadEnds:'done'|'cancelled';hangRelease?:boolean;leaseOnLoad?:boolean}) {
  let resident:string|null=null;
  let loadLease:string|null=null;
  const calls:{method:string;path:string}[]=[];
  const revision='a'.repeat(40);
  const model=(id:string)=>({id,family:'fixture',params_b:9,revision,fingerprint:`${id}@${revision}`,modalities:id==='dots-ocr'?['text','image']:['text'],backend_supported:true,installed:true,resident:resident===id,loadable:true,memory_bytes_estimate:1,context_default:8192,max_model_len:8192});
  const models=()=>['dots-ocr','qwen3.5-9b','qwen3.8-27b-4bit'].map(model);
  const info=()=>({server:{name:'fixture',version:'1.0.10',api_version:1},host:{platform:'win32',arch:'x86_64',backend:'llama-windows',gpu:{vendor:'nvidia',name:'fake',vram_bytes:24e9}},role:'engine',managed_by:null,job_types:['load-model','unload-model'],capabilities:[{job_type:'llm',models:models()}]});
  const capability=()=>({backend_kind:'llama-windows',total_bytes:24e9,desktop_allowance_bytes:0,classes:classes.map(capability=>({capability,enabled:true,selected:chosen(capability),reason:'fixture',shortfall_bytes:0,route:'local'}))});
  const frame=(id:number,event:string,data:unknown)=>`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const sse=(body:string)=>new Response(body,{headers:{'content-type':'text/event-stream'}});
  const server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){
    const url=new URL(req.url);const p=url.pathname;calls.push({method:req.method,path:p});
    if(p==='/v1/info')return Response.json(info());
    if(p==='/v1/capability')return Response.json(capability());
    if(p==='/v1/models')return Response.json(models());
    if(p==='/v1/jobs'&&req.method==='POST'){
      const body=await req.json() as {type:string;params?:{lease?:unknown}};
      if(body.type==='unload-model'){resident=null;return Response.json({job_id:'unload'},{status:202});}
      /*
       * LEASE-ON-LOAD (Crucible 1.0.13). Whether the `done` frame carries a
       * `lease_id` is decided by the load's own `params.lease` — so what the
       * cleanup reads is a consequence of what the dispatcher sent.
       * `leaseOnLoad:false` is the server that leases nothing on a load, which
       * is what keeps the take-and-release dance under test.
       */
      loadLease=options.leaseOnLoad===false?null:(body.params?.lease?'load-lease':null);
      return Response.json({job_id:'load'},{status:202});
    }
    /*
     * THE WHOLE LOAD IN ONE BODY, warming then terminal, because that IS the
     * measured shape: the Stop landed on the warming line and the `done` frame
     * was already on its way. The dispatcher aborts inside the `warming` line's
     * progress callback and reads `done` on the very next turn.
     */
    if(p==='/v1/jobs/load/events'){
      if(options.loadEnds==='cancelled')return sse(frame(1,'warming',{message:'vllm loading; 50s elapsed'})+frame(2,'cancelled',{status:'cancelled'}));
      resident='dots-ocr';
      return sse(frame(1,'warming',{message:'vllm loading; 50s elapsed'})+frame(2,'done',loadLease===null?{resident:'dots-ocr'}:{resident:'dots-ocr',lease_id:loadLease}));
    }
    if(p==='/v1/jobs/unload/events')return sse(frame(1,'done',{resident:null}));
    // THE RECEIPT LIES AND THE RECORD DOES NOT. A DELETE on a job that has
    // already finished is a no-op there; the job's own state is the only fact
    // about what landed on the card.
    if(p==='/v1/jobs/load'&&req.method==='DELETE')return Response.json({job_id:'load',status:'cancelled'});
    // 1.0.13 puts `lease_id` on the RECORD as well as on the `done` frame, and
    // that is not a duplicate: a lease id a client cannot recover after a broken
    // stream is a hold nobody can release.
    // `chunks_done` is load-bearing in the SDK (what a resume differences
    // against), so the job record carries it, as every current server's does —
    // a load job's is empty.
    if(p==='/v1/jobs/load')return Response.json({job_id:'load',type:'load-model',model:'dots-ocr',status:options.loadEnds,progress:1,position:null,error:null,artifacts:[],chunks_done:[],lease_id:loadLease,created:'2026-09-20T18:29:00Z',started:'2026-09-20T18:28:47Z',finished:'2026-09-20T18:29:37Z'});
    if(p.endsWith('/lease')&&req.method==='POST')return Response.json({lease_id:'lease',kind:'llm',subject:p.split('/')[3],client:'fixture',act:'pages',since:'2026-09-20T18:29:37Z',expires_at:'2026-09-20T18:31:37Z'},{status:201});
    if(p.startsWith('/v1/leases/')&&req.method==='DELETE'){
      if(options.hangRelease)return await new Promise<Response>(()=>{});
      resident=null;
      return new Response(null,{status:204});
    }
    return Response.json({error:{code:'fixture_unhandled',message:`${req.method} ${p}`}},{status:500});
  }});
  const entry={name:`fixture-${server.port}`,url:`http://127.0.0.1:${server.port}`,token:'fixture-token',enabled:true};
  spyOn(registry,'crucibleServers').mockReturnValue([entry]);
  spyOn(registry,'crucibleServerNamed').mockReturnValue(entry);
  spyOn(registry,'slotAvailability').mockReturnValue({slots:[{kind:'crucible',name:entry.name}],refusal:null} as never);
  spyOn(registry,'engineSharedWith').mockReturnValue(null);
  spyOn(settings,'readAppSettings').mockReturnValue({queueGpuDial:'any'} as never);
  spyOn(setup,'modelPreparationReady').mockReturnValue(true);
  return {entry,calls,residentNow:()=>resident,close:()=>server.stop(true)};
}

/**
 * OWEN'S CASE, AS IT IS SINCE CRUCIBLE 1.0.13. Stop lands on the warming line;
 * the load completes anyway. The load carried its own lease, so what is resident
 * is ALREADY held by us and the cleanup is one verb: release the id the `done`
 * frame handed back.
 *
 * THE OLD DANCE WOULD NOW BE WRONG HERE, which is why its absence is asserted: a
 * `POST /v1/models/dots-ocr/lease` against a card our own load is holding is
 * refused `409 leased` naming us, and the `unload-model` behind it refused for
 * the same reason. Exactly one DELETE, to exactly the id we were given.
 */
test('real HTTP a placement cancelled while its leased load lands releases that lease',async()=>{
  const f=fixture({loadEnds:'done'});
  const logged:string[]=[];
  spyOn(console,'log').mockImplementation((...args:unknown[])=>{logged.push(args.join(' '));});
  try{
    const abort=new AbortController();
    const result=await dispatch.placeJob('read',f.entry.name,(line)=>{
      if(line.includes('vllm loading'))abort.abort();
    },()=>true,abort.signal);
    expect(result.verdict).toBe('wait');
    // The cancel was SENT and its answer WAITED FOR, and the job's own state was
    // read — the receipt says `cancelled` while the record says `done`.
    expect(f.calls).toContainEqual({method:'DELETE',path:'/v1/jobs/load'});
    expect(f.calls).toContainEqual({method:'GET',path:'/v1/jobs/load'});
    // THE LOAD'S OWN LEASE, released once and nothing else asked for.
    expect(f.calls.filter((c)=>c.method==='DELETE'&&c.path.startsWith('/v1/leases/')))
      .toEqual([{method:'DELETE',path:'/v1/leases/load-lease'}]);
    expect(f.calls.some((c)=>c.path.endsWith('/lease')&&c.method==='POST')).toBe(false);
    expect(f.calls.some((c)=>c.path==='/v1/jobs/unload/events')).toBe(false);
    // AND THE CARD IS BACK, which is the only assertion that is about the night.
    expect(f.residentNow()).toBeNull();
    expect(logged.some((line)=>line.includes('cancelled placement: the load of dots-ocr on "'+f.entry.name+'" had landed holding its own lease; released it.'))).toBe(true);
  }finally{f.close();}
});

/**
 * THE SERVER THAT LEASED NOTHING ON THE LOAD — an older Crucible, or a load
 * submitted without the option. PK12's take-and-release survives untouched for
 * exactly this case: nothing holds the model, so becoming a holder that lets go
 * is still the one gesture Crucible's settlement reacts to.
 */
test('real HTTP a cancelled load that leased nothing is still released by taking a lease and letting go',async()=>{
  const f=fixture({loadEnds:'done',leaseOnLoad:false});
  const logged:string[]=[];
  spyOn(console,'log').mockImplementation((...args:unknown[])=>{logged.push(args.join(' '));});
  try{
    const abort=new AbortController();
    const result=await dispatch.placeJob('read',f.entry.name,(line)=>{
      if(line.includes('vllm loading'))abort.abort();
    },()=>true,abort.signal);
    expect(result.verdict).toBe('wait');
    expect(f.calls).toContainEqual({method:'POST',path:'/v1/models/dots-ocr/lease'});
    expect(f.calls).toContainEqual({method:'DELETE',path:'/v1/leases/lease'});
    expect(f.residentNow()).toBeNull();
    expect(logged.some((line)=>line.includes('cancelled placement: the load of dots-ocr on "'+f.entry.name+'" had landed; released it.'))).toBe(true);
  }finally{f.close();}
});

/**
 * THE OTHER HALF: the server honours the DELETE, the load ends `cancelled`, and
 * nothing is resident. A cleanup that ran anyway would take a lease on a model
 * that is not there — and, on a machine where somebody else's run had already
 * started, would be this app reaching for a card it never loaded.
 */
test('real HTTP a placement whose load is genuinely cancelled takes no lease and unloads nothing',async()=>{
  const f=fixture({loadEnds:'cancelled'});try{
    const abort=new AbortController();
    const result=await dispatch.placeJob('read',f.entry.name,(line)=>{
      if(line.includes('vllm loading'))abort.abort();
    },()=>true,abort.signal);
    expect(result.verdict).toBe('wait');
    if(result.verdict!=='wait')throw Error(JSON.stringify(result));
    expect(result.reason).toBe(`the load of dots-ocr on "${f.entry.name}" was cancelled`);
    expect(f.calls.some((c)=>c.path.endsWith('/lease')&&c.method==='POST')).toBe(false);
    expect(f.calls.some((c)=>c.path.startsWith('/v1/leases/'))).toBe(false);
    expect(f.calls.filter((c)=>c.path==='/v1/jobs'&&c.method==='POST')).toHaveLength(1);
    expect(f.residentNow()).toBeNull();
  }finally{f.close();}
});

/**
 * THE DEADLINE. A Stop must be a Stop: a server that accepts the lease and then
 * never answers the release must not hold the button down. The bound is passed
 * rather than waited out — thirty seconds of real time on every run of the suite
 * would be the keeper costing more than the bug — and what is asserted is the
 * two things the bound owes: it RETURNS, and the line it leaves behind names the
 * model and the machine, so the sweep or a person can finish the job.
 */
test('real HTTP the cleanup is bounded, and names the model when the bound fires',async()=>{
  const f=fixture({loadEnds:'done',hangRelease:true});
  const errors:string[]=[];
  spyOn(console,'error').mockImplementation((...args:unknown[])=>{errors.push(args.join(' '));});
  try{
    const started=Date.now();
    await dispatch.releaseAbandonedLoad(
      f.entry,
      registry.clientFor(f.entry),
      {jobId:'load',cancelled:null,leaseId:null},
      'dots-ocr',
      'pages',
      f.entry.name,
      200,
    );
    expect(Date.now()-started).toBeLessThan(5_000);
    const named=errors.find((line)=>line.includes('may still be resident'));
    expect(named).toBeDefined();
    expect(named).toContain('dots-ocr');
    expect(named).toContain(f.entry.name);
    expect(named).toContain('crucible unload-model dots-ocr');
  }finally{f.close();}
});
