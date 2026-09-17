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

function fixture(options:{missing?:boolean;competing?:boolean;competitorStocks?:boolean;failCompetitor?:boolean}={}) {
  let stocked=!options.missing, competed=false, loaded:string|null=null;
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
    const url=new URL(req.url);const p=url.pathname;const body=req.method==='POST'?await req.json():null;calls.push({method:req.method,path:p,body});
    if(p==='/v1/info')return Response.json(info());
    if(p==='/v1/capability')return Response.json(capability());
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
    if(p==='/v1/jobs'){loaded=body?.model??null;return Response.json({job_id:'load'},{status:202});}
    if(p==='/v1/jobs/load/events')return sse('done',{resident:loaded});
    if(p.endsWith('/lease')&&req.method==='POST')return Response.json({lease_id:'lease',kind:'llm',subject:p.split('/')[3],client:'fixture',act:body.act,since:'2026-09-16T00:00:00Z',expires_at:'2026-09-16T00:02:00Z'},{status:201});
    if(p==='/v1/leases/lease'&&req.method==='DELETE')return new Response(null,{status:204});
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

for(const [kind,cls] of [['read','pages'],['clean','clean'],['translate','translate'],['simplify','simplify'],['analysis','analysis']] as const){
  test(`real HTTP native Windows ${kind} loads and leases the exact selected model`,async()=>{
    const f=fixture();try{
      const result=await dispatch.placeJob(kind,f.entry.name,()=>{},()=>true);
      expect(result.verdict).toBe('go');if(result.verdict!=='go')throw Error(JSON.stringify(result));
      try{expect(result.placement.model).toBe(chosen(cls));expect(result.placement.endpoint).toBe(`${f.entry.url}/openai`);
        expect(f.calls.find(c=>c.path==='/v1/jobs')!.body.model).toBe(chosen(cls));
        expect(f.calls.find(c=>c.path.endsWith('/lease'))!.body.act).toBe(cls);
      }finally{await result.placement.lease?.release();}
      expect(f.calls.some(c=>c.path==='/v1/leases/lease'&&c.method==='DELETE')).toBe(true);
    }finally{f.close();}
  });
}
