import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { callSocket, requestChild } from "../src/service/ipc.ts";
import { atomicJSON, runtimeState, saveRuntime, socketPath, type Release } from "../src/service/state.ts";
import { sourceHash } from "../src/service/releases.ts";
import { exited } from "../src/service/managed.ts";
import { Store, pidAlive } from "../src/db.ts";
import { startWebDetached, stopWeb } from "../src/web/launch.ts";
import { until } from "./helpers.ts";

const managed = resolve(import.meta.dir, "../src/service/managed.ts");
const ipc = resolve(import.meta.dir, "../src/service/ipc.ts");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "broadcast-manager-"));
  const database = join(dir, "broadcast.sqlite");
  const make = (name: string, fail = false): Release => {
    const directory = join(dir, "releases", `release-${name}`); mkdirSync(join(directory, "src/service"), { recursive: true });
    writeFileSync(join(directory, "src/service/entry.ts"), `
      import { runLauncher } from ${JSON.stringify(managed)};
      import { handleParent, requestParent } from ${JSON.stringify(ipc)};
      import { updateGuard } from ${JSON.stringify(resolve(import.meta.dir, "../src/service/update-state.ts"))};
      const [mode, db, dir, raw] = process.argv.slice(2); const release = JSON.parse(raw);
      if (mode === 'launcher') await runLauncher(db, dir, release);
      else {
        if (${fail}) process.exit(71);
        const web=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return Response.json({app:'herdr-broadcast',state:{}});}});
        handleParent(async command => {
          if (command === 'status') return {release, update: await Bun.file(dir+'/update.json').json(), web:{url:'http://127.0.0.1:'+web.port+'/'}};
          if (command === 'drain') { await Bun.write(dir+'/drains', String(Number(await Bun.file(dir+'/drains').text().catch(()=>'0'))+1)); await Bun.sleep(100); return true; }
          if (command === 'activate' || command === 'confirm') return true;
          if (command === 'exit') {
            const current=await Bun.file(dir+'/update.json').json();
            const rejected=await requestParent('persist-update',1000,{patch:{error:'late old manager'},expected:updateGuard(current)}).then(()=>false,()=>true);
            await Bun.write(dir+'/stale-rejected',String(rejected));
            setTimeout(()=>process.exit(0),20);return true;
          }
          if (command === 'restart') {
            const next=await Bun.file(dir+'/candidate.json').json();
            let status=await Bun.file(dir+'/update.json').json();
            status=await requestParent('persist-update',1000,{patch:{phase:'updating',outcome:'running',operation_id:'test-operation',step:'resources'},expected:updateGuard(status)});
            status=await requestParent('persist-update',1000,{patch:{phase:'restarting',step:'drain'},expected:updateGuard(status)});
            setTimeout(()=>process.send({event:'switch',next,status}),30); return status;
          }
        });
        process.on('disconnect',()=>process.exit(0));
        if(release.revision==='slow') await Bun.sleep(500);
        process.send({event:'ready',bootId:'test-boot',release});
      }
    `);
    return { directory, revision: name, version: name, hash: sourceHash(directory), sourceRoot: directory, sourceHash: sourceHash(directory), sourceRevision: name, protocol: 1, schema: 9 };
  };
  return { dir, database, make };
}
async function launch(f: ReturnType<typeof fixture>, initial: Release) {
  const child = spawn(process.execPath, [join(initial.directory, 'src/service/entry.ts'), 'launcher', f.database, f.dir, JSON.stringify(initial)], { stdio: ['ignore','pipe','pipe'] });
  let log = ''; child.stderr!.on('data', x => { log += x; });
  const end = Date.now()+5000;
  while (Date.now()<end) { try { await callSocket(socketPath(f.database), 'status', 200); return child; } catch {} if (child.exitCode !== null) throw new Error(log); await Bun.sleep(25); }
  child.kill(); throw new Error('launcher timeout: '+log);
}
async function stop(f: ReturnType<typeof fixture>, child?: ChildProcess) {
  await callSocket(socketPath(f.database),'stop',1000).catch(()=>{});
  if (child) { await exited(child,2000).catch(()=>child.kill()); }
  rmSync(f.dir,{recursive:true,force:true}); rmSync(socketPath(f.database),{force:true});
}
for (const failure of ['manager', 'fingerprint', 'protocol']) test(`launcher rolls back a ${failure} failure and persists the failed operation`, async()=>{
  const f=fixture(), old=f.make('old'); let child:ChildProcess|undefined;
  try {
    child=await launch(f,old); const candidate=f.make('new',failure==='manager');
    if(failure==='fingerprint') candidate.hash='wrong'; if(failure==='protocol') candidate.protocol=99;
    atomicJSON(join(f.dir,'candidate.json'),candidate);
    expect(statSync(socketPath(f.database)).mode & 0o777).toBe(0o600);
    expect((await callSocket(socketPath(f.database),'restart')).operation_id).toBe('test-operation');
    await until(()=>{const state=runtimeState(f.dir);const update=JSON.parse(readFileSync(join(f.dir,'update.json'),'utf8'));return !state.transaction && update.outcome==='failed';},5000);
    const state=await callSocket(socketPath(f.database),'status'); expect(state.release.revision).toBe('old'); expect(state.update.error).toContain('恢复旧版');
    expect(runtimeState(f.dir).current?.revision).toBe('old');
  } finally {await stop(f,child);}
},10000);

test('interrupted transaction starts the last confirmed directory, never the unconfirmed candidate',async()=>{
  const f=fixture(),old=f.make('old'),candidate=f.make('candidate',true);let child:ChildProcess|undefined;
  saveRuntime(f.dir,{current:candidate,previous:old,transaction:{id:'interrupted',previous:old,next:candidate,step:'activating'}});
  try {child=await launch(f,candidate);const state=await callSocket(socketPath(f.database),'status');expect(state.release.revision).toBe('old');expect(state.update.outcome).toBe('failed');expect(runtimeState(f.dir).transaction).toBeUndefined();}
  finally{await stop(f,child);}
},10000);

test('confirmed manager replacement persists both versions; explicit stop removes control and stays stopped',async()=>{
  const f=fixture(),old=f.make('old');let child:ChildProcess|undefined;
  try {child=await launch(f,old);atomicJSON(join(f.dir,'candidate.json'),f.make('new'));await callSocket(socketPath(f.database),'restart');await until(()=>runtimeState(f.dir).current?.revision==='new'&&!runtimeState(f.dir).transaction,5000);
    // The durable commit precedes the manager's final confirmation. Stop is only
    // accepted after the control API reports that the entire switch has settled.
    const end = Date.now() + 5000;
    while ((await callSocket(socketPath(f.database), 'status')).switching) {
      if (Date.now() >= end) throw new Error('manager confirmation timeout');
      await Bun.sleep(25);
    }
    expect(runtimeState(f.dir).previous?.revision).toBe('old');await callSocket(socketPath(f.database),'stop');await exited(child,2000);expect(pidAlive(child.pid!)).toBe(false);
    await expect(callSocket(socketPath(f.database),'status',200)).rejects.toThrow();
  }finally{await stop(f,child);}
},10000);

for(const failure of ['exit','identity']) test(`real manager rejects Web startup ${failure} before activation`,async()=>{
  const f=fixture(),release=f.make('health');const entry=join(release.directory,'src/service/entry.ts');
  writeFileSync(entry,`
    import { runManager } from ${JSON.stringify(managed)};
    const [mode,db,dir,raw]=process.argv.slice(2);const r=JSON.parse(raw);
    if(mode==='manager') {try {await runManager(db,dir,r);}catch(e){console.error(e.message);process.exit(1);}}
    else {if(${JSON.stringify(failure)}==='exit')process.exit(72);
      const web=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return Response.json({app:'herdr-broadcast',bootId:'wrong',hash:r.hash,revision:r.revision,database:db,dispatching:false,schema:9});}});
      process.send({event:'ready',url:'http://127.0.0.1:'+web.port+'/'});
    }
  `); release.hash=sourceHash(release.directory);
  const child=spawn(process.execPath,[entry,'manager',f.database,f.dir,JSON.stringify(release)],{stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,HERDR_PLUGIN_CONFIG_DIR:join(f.dir,'config')}});
  let log='';let ready=false;child.stderr!.on('data',x=>{log+=x;});child.on('message',(m:any)=>{if(m.event==='ready')ready=true;});
  try{await exited(child,5000);expect(child.exitCode).toBe(1);expect(ready).toBe(false);expect(log).toContain(failure==='identity'?'identity mismatch':'exited before');}
  finally{if(child.exitCode===null)child.kill();await stop(f);}
},10000);

test('start waits through a real manager switch; concurrent stops wait for one drain and release the launcher lock', async () => {
  const f = fixture(), old = f.make('old'), store = new Store(f.database); let child: ChildProcess | undefined;
  try {
    child = await launch(f, old); atomicJSON(join(f.dir, 'candidate.json'), f.make('slow'));
    await callSocket(socketPath(f.database), 'restart');
    await until(() => !!runtimeState(f.dir).transaction);
    expect((await callSocket(socketPath(f.database), 'describe')).outcome).toBe('running');
    expect((await startWebDetached(store)).how).toBe('running');
    expect(runtimeState(f.dir).current?.revision).toBe('slow');
    expect(readFileSync(join(f.dir, 'stale-rejected'), 'utf8')).toBe('true');
    expect(JSON.parse(readFileSync(join(f.dir, 'update.json'), 'utf8')).error).toBeNull();
    expect(existsSync(join(f.dir, 'web.log'))).toBe(false); // No attempted second launcher.
    const stopping = Promise.all([stopWeb(store), stopWeb(store)]);
    await until(() => existsSync(join(f.dir, 'drains')));
    expect((await callSocket(socketPath(f.database), 'describe')).outcome).toBe('succeeded');
    expect(await stopping).toEqual(['stopped', 'stopped']);
    expect(pidAlive(child.pid!)).toBe(false); expect(existsSync(join(f.dir, 'launcher.lock'))).toBe(false);
    expect(existsSync(socketPath(f.database))).toBe(false);
    expect(readFileSync(join(f.dir, 'drains'), 'utf8')).toBe('1');
    const started = await startWebDetached(store); expect(started.how).toBe('started');
    expect(await stopWeb(store)).toBe('stopped');
  } finally { store.close(); await stop(f, child); }
}, 15000);

test('manager cancellation during check, failed drain and SIGTERM recovery still permit restart', async () => {
  const f = fixture(), release = f.make('real'), entry = join(release.directory, 'src/service/entry.ts');
  const herdr = join(f.dir, 'herdr');
  writeFileSync(herdr, `#!/bin/sh\nexec "${process.execPath}" "${join(f.dir, 'herdr.ts')}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(f.dir, 'herdr.ts'), `
    import {existsSync,writeFileSync} from 'node:fs';
    const dir=${JSON.stringify(f.dir)};
    if(existsSync(dir+'/slow-check')) {writeFileSync(dir+'/checking','yes'); await Bun.sleep(3000);}
    console.log(JSON.stringify({result:{plugins:[{plugin_id:'herdr-broadcast',plugin_root:dir,source:{kind:'local'}}]}}));
  `);
  writeFileSync(entry, `
    import {runLauncher,runManager} from ${JSON.stringify(managed)};
    import {handleParent} from ${JSON.stringify(ipc)};
    import {existsSync,writeFileSync,rmSync} from 'node:fs';
    const [mode,db,dir,raw]=process.argv.slice(2),r=JSON.parse(raw);
    process.env.HERDR_BIN_PATH=${JSON.stringify(herdr)};
    process.env.HERDR_PLUGIN_CONFIG_DIR=dir+'/config';
    if(mode==='launcher')await runLauncher(db,dir,r);
    else if(mode==='manager'){writeFileSync(dir+'/manager.pid',String(process.pid));await runManager(db,dir,r);}
    else{
      const web=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return Response.json({app:'herdr-broadcast',state:{},bootId:process.env.HERDR_BROADCAST_BOOT_ID,hash:r.hash,revision:r.revision,database:db,dispatching:false,schema:9});}});
      handleParent(async cmd=>{
        if(cmd==='status')return {url:'http://127.0.0.1:'+web.port+'/'};
        if(cmd==='drain'){if(existsSync(dir+'/refuse-drain')){rmSync(dir+'/refuse-drain');return false;}return true;}
        if(cmd==='activate')return true;
        if(cmd==='exit'){setTimeout(()=>process.exit(0),20);return true;}
      });
      process.send({event:'ready',url:'http://127.0.0.1:'+web.port+'/'});
    }
  `); release.hash = sourceHash(release.directory);
  let child: ChildProcess | undefined;
  try {
    child = await launch(f, release);
    await until(() => JSON.parse(readFileSync(join(f.dir, 'update.json'), 'utf8')).kind === 'local');
    writeFileSync(join(f.dir, 'slow-check'), ''); writeFileSync(join(f.dir, 'refuse-drain'), '');
    const check = callSocket(socketPath(f.database), 'check');
    await until(() => existsSync(join(f.dir, 'checking')));
    expect(await callSocket(socketPath(f.database), 'stop')).toBe('failed'); await check;
    rmSync(join(f.dir, 'slow-check')); rmSync(join(f.dir, 'checking'));
    expect((await callSocket(socketPath(f.database), 'status')).lifecycle).toBe('idle');
    // SIGTERM follows the same failed-drain recovery path, without replacing the manager.
    writeFileSync(join(f.dir, 'refuse-drain'), '');
    const pid = Number(readFileSync(join(f.dir, 'manager.pid'), 'utf8')); process.kill(pid, 'SIGTERM');
    await until(() => !existsSync(join(f.dir, 'refuse-drain')));
    expect(pidAlive(pid)).toBe(true);
    const operation = await callSocket(socketPath(f.database), 'restart'); expect(operation.operation_id).toBeTruthy();
    await until(() => JSON.parse(readFileSync(join(f.dir, 'update.json'), 'utf8')).outcome === 'succeeded', 5000);
    expect(Number(readFileSync(join(f.dir, 'manager.pid'), 'utf8'))).not.toBe(pid);
  } finally { await stop(f, child); }
}, 15000);
