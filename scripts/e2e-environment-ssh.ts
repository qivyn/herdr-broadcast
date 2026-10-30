import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { isolatedHerdr } from './e2e-environment.ts';
import { herdrResult, runHerdr, machineList, agentGet, paneRead, paneSendKeys, paneSendText } from '../src/herdr.ts';
import { shellQuote, machineCommand } from '../src/machine-command.ts';
import { Store, type Execution } from '../src/db.ts';
import { Engine } from '../src/engine.ts';
import { Conversations, continuationKey } from '../src/continuation.ts';
import { inspectEnvironment, AgentEnvironments } from '../src/agent-environment.ts';
/** Real saved SSH profile, isolated integrations and native Pi recovery; no model requests. */
// Bun caches executable lookup, so the SSH wrapper must be on PATH before the test process starts.
if (!process.env.BROADCAST_E2E_SSH_HARNESS_ROOT) {
  const harness = mkdtempSync('/tmp/bc-ssh-harness-');
  mkdirSync(join(harness, 'bin'));
  writeFileSync(join(harness, 'bin/ssh'), `#!/bin/sh\nIFS= read -r BC_SSH_DIR < ${shellQuote(join(harness, 'transport-root'))}\nexec /usr/bin/ssh -F /dev/null -i "$BC_SSH_DIR/client" -o "UserKnownHostsFile=$BC_SSH_DIR/known_hosts" -o IdentitiesOnly=yes "$@"\n`);
  chmodSync(join(harness, 'bin/ssh'), 0o700);
  try {
    const child = Bun.spawn([process.execPath, import.meta.path], { env: { ...process.env,
        BROADCAST_E2E_SSH_HARNESS_ROOT: harness, BROADCAST_E2E_SSH_ORIGINAL_PATH: process.env.PATH,
        PATH: join(harness, 'bin') + ':' + process.env.PATH }, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
    process.exitCode = await child.exited;
  }
  finally {
    rmSync(harness, { recursive: true, force: true });
  }
  process.exit(process.exitCode ?? 0);
}
const harness = process.env.BROADCAST_E2E_SSH_HARNESS_ROOT;
const originalPath = process.env.BROADCAST_E2E_SSH_ORIGINAL_PATH!;
const env = await isolatedHerdr('ssh-recovery');
const root = env.root, remote = join(root, 'remote');
mkdirSync(remote);
let sshd: ReturnType<typeof Bun.spawn> | undefined;
let machine: string | undefined;
let store: Store | undefined, engine: Engine | undefined, conversations: Conversations | undefined;
async function run(argv: string[], environment = process.env) {
  const p = Bun.spawn(argv, { env: environment, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (code) throw new Error(stderr + stdout);
  return stdout;
}
try {
  for (const key of ['host', 'client'])
    await run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', join(root, key)]);
  const socket = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() { } } });
  const port = socket.port!;
  socket.stop(true);
  writeFileSync(join(root, 'authorized_keys'), readFileSync(join(root, 'client.pub')));
  writeFileSync(join(root, 'known_hosts'), `[127.0.0.1]:${port} ${readFileSync(join(root, 'host.pub'), 'utf8')}`);
  const remoteEnv = { XDG_CONFIG_HOME: join(remote, 'config'), XDG_STATE_HOME: join(remote, 'state'), XDG_DATA_HOME: join(remote, 'data'), XDG_CACHE_HOME: join(remote, 'cache'), XDG_RUNTIME_DIR: join(remote, 'run'), PI_CODING_AGENT_DIR: join(remote, 'pi agent'), CODEX_HOME: join(remote, 'codex home'), BROADCAST_CODEX_OFFLINE_KEY: 'offline-fixture', PI_OFFLINE: '1', PI_TELEMETRY: '0', SHELL: '/bin/sh', PATH: originalPath };
  for (const p of Object.values(remoteEnv).filter(p => p.startsWith(remote)))
    mkdirSync(p, { recursive: true });
  mkdirSync(join(remoteEnv.XDG_CONFIG_HOME, 'herdr'), { recursive: true });
  writeFileSync(join(remoteEnv.CODEX_HOME, 'config.toml'), `model_provider = "offline"\nmodel = "offline"\n[model_providers.offline]\nname = "Offline fixture"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nenv_key = "BROADCAST_CODEX_OFFLINE_KEY"\n[features]\nhooks = true\n[projects.${JSON.stringify(remote)}]\ntrust_level = "trusted"\n`);
  writeFileSync(join(remoteEnv.XDG_CONFIG_HOME, 'herdr/config.toml'), 'onboarding = false\n[shell]\ndefault_shell = "/bin/sh"\n');
  const remoteScript = join(root, 'remote.sh');
  writeFileSync(remoteScript, '#!/bin/sh\n' + Object.entries(remoteEnv).map(([k, v]) => `export ${k}=${shellQuote(v)}`).join('\n') + '\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n');
  chmodSync(remoteScript, 0o700);
  writeFileSync(join(root, 'sshd_config'), `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${root}/host\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile ${root}/authorized_keys\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers ${userInfo().username}\nForceCommand ${remoteScript}\nLogLevel ERROR\n`);
  sshd = Bun.spawn(['/usr/sbin/sshd', '-D', '-e', '-f', join(root, 'sshd_config')], { stdout: Bun.file(join(root, 'sshd.log')), stderr: Bun.file(join(root, 'sshd.log')) });
  await Bun.sleep(300);
  if (sshd.exitCode !== null)
    throw new Error(readFileSync(join(root, 'sshd.log'), 'utf8'));
  writeFileSync(join(harness, 'transport-root'), root + '\n');
  const added = await runHerdr(['machine', 'add', `ssh://${userInfo().username}@127.0.0.1:${port}`, '--label', 'Isolated SSH', '--remote-session', 'recovery'], { timeoutMs: 60000 });
  assert.equal(added.code, 0, added.stderr + added.stdout);
  machine = (await machineList())[0]?.id;
  assert.ok(machine, 'saved machine');
  const checked = await inspectEnvironment(machine);
  const pi = checked.agents.find(a => a.kind === 'pi')!;
  assert.equal(pi.configDir, remoteEnv.PI_CODING_AGENT_DIR);
  assert.equal(pi.integrationState, 'missing');
  assert.equal(pi.cliReady, true, 'Install Pi before running this E2E');
  const manager = new AgentEnvironments(join(root, 'environment.json'), () => { });
  const op = manager.start(machine, ['pi']);
  await manager.settle();
  assert.equal(op.state, 'done', JSON.stringify(op));
  assert.equal((await manager.check(machine)).agents.find(a => a.kind === 'pi')?.ready, true);
  const extension = join(remoteEnv.PI_CODING_AGENT_DIR, 'extensions/herdr-agent-state.ts');
  writeFileSync(extension, readFileSync(extension, 'utf8').replace(/HERDR_INTEGRATION_VERSION=\d+/, 'HERDR_INTEGRATION_VERSION=1'));
  assert.equal((await manager.check(machine)).agents.find(a => a.kind === 'pi')?.integrationState, 'outdated');
  const update = manager.start(machine, ['pi']);
  await manager.settle();
  assert.equal(update.state, 'done');
  // A pre-existing native history makes restore observable without sending any model request.
  const session = '01234567-1234-4567-89ab-0123456789ab';
  const dir = join(remoteEnv.PI_CODING_AGENT_DIR, 'sessions', `--${remote.slice(1).replaceAll('/', '-')}--`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(remoteEnv.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ packages: [], quietStartup: true }));
  const file = join(dir, `2026-10-26T12-00-00-000Z_${session}.jsonl`), marker = 'SSH_SAVED_HISTORY_ONLY';
  writeFileSync(file, [
    { type: 'session', version: 3, id: session, timestamp: '2026-10-26T12:00:00.000Z', cwd: remote },
    { type: 'message', id: '11111111', parentId: null, timestamp: '2026-10-26T12:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: marker }], timestamp: 1793016000000 } },
    { type: 'message', id: '22222222', parentId: '11111111', timestamp: '2026-10-26T12:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Saved SSH response; no request needed.' }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 1793016001000 } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  const userMessages = () => readFileSync(file, 'utf8').split('\n').filter(line => line && JSON.parse(line).message?.role === 'user').length;
  store = new Store(join(root, 'broadcast.sqlite'));
  engine = new Engine(store, () => { });
  conversations = new Conversations(store, engine, () => { });
  await engine.refreshMachines();
  const id = store.createBroadcast({ title: 'SSH recovery fixture', prompt: 'NEVER SEND THIS', executions: [{ machine_id: machine, machine_label: 'Isolated SSH', target_kind: 'existing', agent_kind: 'pi', cwd: remote, pane_id: 'closed', terminal_id: 'closed' }] });
  const execution = store.executions(id)[0]!;
  store.update(execution.id, { state: 'completed' });
  const saved = store.execution(execution.id)!;
  const chosen = await conversations.continue(saved, true);
  assert.equal(chosen.mode, 'choose', JSON.stringify(chosen));
  const picker = store.continuation(continuationKey(saved))!;
  async function waitScreen(pane: string, text: string) {
    let last = '';
    for (let i = 0; i < 80; i++) {
      last = (await runHerdr(['pane', 'read', pane, '--source', 'visible', '--format', 'text'], { machine })).stdout;
      if (last.includes(text))
        return;
      if (/Update available/.test(last) && /enter continue.*esc skip/i.test(last)) await paneSendKeys(machine!, pane, ['esc']);
      await Bun.sleep(250);
    }
    throw new Error('Unexpected terminal: ' + last);
  }
  await waitScreen(picker.pane_id, marker);
  await herdrResult(['pane', 'send-keys', picker.pane_id, 'Enter'], { machine });
  await waitScreen(picker.pane_id, 'Saved SSH response; no request needed.');
  // Reading the explicitly opened picker is allowed to adopt its reported native identity.
  for (let i = 0; i < 40 && !store.execution(saved.id)!.session_value; i++) {
    await conversations.target(store.execution(saved.id)!);
    await Bun.sleep(250);
  }
  const identified = store.execution(saved.id)!;
  assert.equal(identified.session_kind, 'path');
  assert.equal(identified.session_value, file);
  const reopened = new Store(store.path);
  assert.equal(reopened.execution(saved.id)!.session_value, file);
  reopened.close();
  await herdrResult(['workspace', 'close', picker.workspace_id], { machine });
  assert.equal((await conversations.continue(identified, false, true)).mode, 'manual', 'refresh must not start a process');
  const restored = await conversations.continue(identified);
  assert.ok(['opened', 'resumed'].includes(restored.mode), JSON.stringify(restored));
  const live = store.continuation(continuationKey(identified))!;
  assert.notEqual(live.terminal_id, picker.terminal_id);
  await waitScreen(live.pane_id, 'Saved SSH response; no request needed.');
  assert.equal((await conversations.target(identified))?.mode, 'reconnect');
  assert.equal(store.execution(saved.id)!.state, 'completed');
  assert.equal(store.execution(saved.id)!.sent_at, null);
  assert.equal(userMessages(), 1);
  // Codex uses the actual saved SSH route for launch capability, hook target and history proof.
  const codexInstall = manager.start(machine, ['codex']); await manager.settle();
  assert.equal(codexInstall.state, 'done', JSON.stringify(codexInstall));
  assert.deepEqual(await engine.launchArgs(machine, 'codex', ['resume', session]), ['--no-daemon', 'resume', session]);
  const codexPrompt = 'SSH_CODEX_NATIVE_' + crypto.randomUUID();
  const cb = store.createBroadcast({ title: 'SSH Codex fixture', prompt: codexPrompt, executions: [{ machine_id: machine, machine_label: 'Isolated SSH', target_kind: 'new', agent_kind: 'codex', cwd: remote, slot: 1 }] });
  const ce = store.executions(cb)[0]!; engine.submit(store.rounds(cb)[0]!.id);
  let trustHandled = false;
  for (let i = 0; i < 160 && !store.execution(ce.id)!.session_value; i++) {
    const e: Execution = store.execution(ce.id)!;
    if (e.pane_id) {
      const screen = await paneRead(machine, e.pane_id, 60, 'visible');
      if (screen.includes('Hooks need review') && !trustHandled) {
        assert.equal(e.input_attempted, 0, 'SSH trust page must not receive broadcast');
        await paneSendKeys(machine, e.pane_id, ['enter']);
        await waitScreen(e.pane_id, 'Lifecycle hooks');
        await paneSendText(machine, e.pane_id, 't'); await Bun.sleep(200);
        await paneSendKeys(machine, e.pane_id, ['esc']); trustHandled = true;
      }
      if (/Update available/.test(screen) && /[123][.)].*(?:Skip|Update|Ignore)/i.test(screen)) await paneSendKeys(machine, e.pane_id, ['esc']);
    }
    if (['failed', 'uncertain'].includes(e.state)) throw new Error(JSON.stringify(e));
    await Bun.sleep(250);
  }
  const boundCodex = store.execution(ce.id)!;
  assert.equal(boundCodex.state, 'sent'); assert.ok(boundCodex.session_value, 'SSH hook and exact history must bind native ID');
  assert.equal((await agentGet(machine, boundCodex.pane_id!)).agent_session?.value, boundCodex.session_value);
  await paneSendKeys(machine, boundCodex.pane_id!, ['esc']); await Bun.sleep(300);
  await herdrResult(['workspace', 'close', boundCodex.workspace_id!], { machine });
  const codexRestore = await conversations.continue(boundCodex);
  assert.ok(['opened', 'resumed', 'inspect'].includes(codexRestore.mode), JSON.stringify(codexRestore));
  const codexDirect = store.continuation(continuationKey(boundCodex))!;
  await waitScreen(codexDirect.pane_id, codexPrompt);
  const files = [...new Bun.Glob('sessions/**/*.jsonl').scanSync({ cwd: remoteEnv.CODEX_HOME, absolute: true })];
  const codexMessages = files.flatMap(file => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)))
    .filter(row => row.type === 'response_item' && row.payload?.role === 'user' && row.payload.content?.some((c: {text?: string}) => c.text === codexPrompt));
  assert.equal(codexMessages.length, 1, 'SSH Codex restoration must never replay broadcast');
  console.log(JSON.stringify({ result: 'passed', checks: ['real SSH authentication', 'saved machine profile routing', 'custom config directory with spaces', 'install and recheck', 'outdated integration update', 'native Pi picker identity persisted', 'closed session requires explicit recovery', 'same native history restored', 'no broadcast replay', 'Codex capability checked on saved SSH machine', 'Codex first hook trust blocks input', 'Codex hook plus remote history binds native ID', 'Codex exact restore without replay'] }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  if (process.env.E2E_LOG_DIR) {
    const logs = resolve(process.env.E2E_LOG_DIR);
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'environment-ssh.log'), String(error));
  }
} finally {
  await conversations?.settle();
  engine?.stop();
  await engine?.settle();
  store?.close();
  if (machine)
    await runHerdr(['server', 'stop'], { machine, timeoutMs: 10000 }).catch(() => undefined);
  if (machine) {
    // The stop acknowledgement precedes the final session snapshot write.
    for (let attempt = 0; ; attempt++) {
      const result = await machineCommand(machine, 'herdr session list --json');
      const sessions = JSON.parse(result.stdout).sessions as { name: string; running: boolean }[];
      if (!sessions.some(s => s.name === 'recovery' && s.running)) break;
      if (attempt >= 50) throw new Error('Temporary remote Herdr did not stop');
      await Bun.sleep(100);
    }
  }
  if (sshd) {
    sshd.kill();
    await sshd.exited;
  }
  await env.close();
}
