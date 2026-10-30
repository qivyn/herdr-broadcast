/** Read-only native evidence: candidate verification and conservative unknown-identity discovery. */
import type { Broadcast, Execution } from "./db.ts";
import { LOCAL, machineList, type MachineProfile } from "./herdr.ts";
import { shellQuote } from "./machine-command.ts";
import { parseTarget } from "./web/ssh.ts";
import { nativeResumeArgs } from "./agents.ts";

export interface DiscoveredSession { kind: "id" | "path"; value: string }
export const PROOF_FAILURES = ["unsupported_agent", "invalid_identity", "read_limit", "read_timeout", "unreadable", "incomplete", "identity_mismatch"] as const;
export type ProofFailure = typeof PROOF_FAILURES[number];
export interface SessionDiscovery { status: "found" | "none" | "ambiguous" | "unavailable"; session?: DiscoveredSession; reason?: ProofFailure }
export interface SessionQuery { agent: string; cwd: string; prompt: string; sentAt: number; store?: string; expected?: DiscoveredSession }
export const canVerifySession = (agent: string | null) => ["codex", "claude", "pi"].includes(agent ?? "");

// Kept in the source so local and SSH lookups use exactly the same parser. Only matching
// identifiers leave the machine; prompts travel over stdin, never command-line arguments.
export const sessionScanner = String.raw`
import os, sys, json, glob, re, time, datetime
MAX_FILES = 2000
MAX_BYTES = 128 * 1024 * 1024
MAX_LINE = 4 * 1024 * 1024
UUID = re.compile(r'^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$')

def timestamp(value):
    if isinstance(value, (float, int)): return value if value > 100000000000 else value * 1000
    if not isinstance(value, str): return None
    try: return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000
    except (ValueError, OverflowError): return None

def plain(value):
    if isinstance(value, str): return value.replace('\r\n', '\n').strip()
    if isinstance(value, list):
        if any(not isinstance(x, dict) or x.get('type') not in ('text', 'input_text') for x in value): return None
        return ''.join(x.get('text', '') for x in value).replace('\r\n', '\n').strip()
    return None

def canonical(value):
    return os.path.realpath(os.path.expanduser(value)) if isinstance(value, str) and value else None

def scan(q):
    agent, cwd = q['agent'], canonical(q['cwd'])
    prompt, sent = plain(q['prompt']), q['sentAt']
    expected = q.get('expected')
    def fail(reason):
        return {'status': 'unavailable', **({'reason': reason} if expected else {})}
    if expected:
        if agent not in ('pi', 'claude', 'codex'): return fail('unsupported_agent')
        kind, value = expected.get('kind'), expected.get('value')
        if not isinstance(value, str) or len(value) > 4096 or any(ord(c) < 32 or ord(c) == 127 for c in value): return fail('invalid_identity')
        if kind == 'path':
            if agent != 'pi' or not os.path.isabs(value) or not value.endswith('.jsonl'): return fail('invalid_identity')
        elif kind != 'id' or not UUID.fullmatch(value): return fail('invalid_identity')
    if agent not in ('pi', 'claude', 'codex') or not cwd or not prompt or not isinstance(sent, (int, float)):
        return {'status': 'none'}
    home = os.path.expanduser('~')
    if agent == 'pi':
        agent_dir = os.environ.get('PI_CODING_AGENT_DIR') or os.path.join(home, '.pi', 'agent')
        setting = None
        settings = os.path.join(agent_dir, 'settings.json')
        if os.path.isfile(settings):
            with open(settings) as f: setting = json.load(f).get('sessionDir')
        store = q.get('store') or os.environ.get('PI_CODING_AGENT_SESSION_DIR') or setting or os.path.join(agent_dir, 'sessions')
        store = os.path.expanduser(store)
        if not os.path.isabs(store): return {'status': 'unavailable'}
        patterns = [os.path.join(store, '*.jsonl'), os.path.join(store, '*', '*.jsonl')]
    elif agent == 'claude':
        store = q.get('store') or os.environ.get('CLAUDE_CONFIG_DIR') or os.path.join(home, '.claude')
        patterns = [os.path.join(store, 'projects', '*', '*.jsonl')]
    else:
        store = q.get('store') or os.environ.get('CODEX_HOME') or os.path.join(home, '.codex')
        patterns = [os.path.join(store, 'sessions', '*', '*', '*', '*.jsonl'), os.path.join(store, 'archived_sessions', '*.jsonl')]
    # A live reported identity is already a candidate. Never search unrelated transcript
    # contents to prove it. Filenames only locate candidates; their contents must agree.
    if expected:
        value = expected['value']
        if expected['kind'] == 'path': patterns = []
        elif agent == 'codex': patterns = [os.path.join(store, 'sessions', '*', '*', '*', '*-' + value + '.jsonl'), os.path.join(store, 'archived_sessions', '*-' + value + '.jsonl')]
        elif agent == 'claude': patterns = [os.path.join(store, 'projects', '*', value + '.jsonl')]
        else: patterns = [os.path.join(store, '*_' + value + '.jsonl'), os.path.join(store, '*', '*_' + value + '.jsonl')]
    files, seen = [], set()
    if expected and expected['kind'] == 'path': files = [canonical(expected['value'])]
    deadline = time.monotonic() + 8
    for pattern in patterns:
        for file in glob.iglob(pattern):
            path = os.path.realpath(file)
            if path in seen: continue
            seen.add(path); files.append(path)
            if len(files) > MAX_FILES: return fail('read_limit')
            if time.monotonic() > deadline: return fail('read_timeout')
    matches, read = [], 0
    for path in files:
        if time.monotonic() > deadline: return fail('read_timeout')
        if expected and not os.path.isfile(path): return {'status': 'none'}
        session_id, session_cwd, matched = None, None, False
        with open(path, 'rb') as f:
            while True:
                line = f.readline(MAX_LINE + 1)
                if not line: break
                read += len(line)
                if len(line) > MAX_LINE or read > MAX_BYTES: return fail('read_limit')
                if time.monotonic() > deadline: return fail('read_timeout')
                if not line.strip(): continue
                # An unreadable/incomplete transcript prevents proving uniqueness.
                try: entry = json.loads(line)
                except (ValueError, UnicodeDecodeError): return fail('incomplete' if not line.endswith(b'\n') else 'unreadable')
                if not isinstance(entry, dict): return {'status': 'unavailable'}
                if agent == 'pi':
                    if entry.get('type') == 'session':
                        session_id, session_cwd = entry.get('id'), canonical(entry.get('cwd'))
                        if session_cwd != cwd: break
                    msg = entry.get('message', {}) if entry.get('type') == 'message' else {}
                    content = msg.get('content') if msg.get('role') == 'user' else None
                    when = timestamp(entry.get('timestamp')) or timestamp(msg.get('timestamp'))
                elif agent == 'claude':
                    if entry.get('isSidechain'): continue
                    msg = entry.get('message', {}) if entry.get('type') == 'user' else {}
                    content = msg.get('content') if msg.get('role') == 'user' else None
                    session_id, session_cwd = entry.get('sessionId'), canonical(entry.get('cwd'))
                    when = timestamp(entry.get('timestamp'))
                else:
                    payload = entry.get('payload', {})
                    if entry.get('type') == 'session_meta':
                        session_id, session_cwd = payload.get('id'), canonical(payload.get('cwd'))
                        if session_cwd != cwd: break
                    content = payload.get('content') if entry.get('type') == 'response_item' and payload.get('role') == 'user' else None
                    when = timestamp(entry.get('timestamp'))
                if expected and session_id is not None and expected['kind'] == 'id' and session_id != expected['value']: return fail('identity_mismatch')
                if session_cwd == cwd and isinstance(session_id, str) and UUID.fullmatch(session_id) and when is not None and abs(when - sent) <= 10000 and plain(content) == prompt:
                    matched = True
                    found_id = session_id
                    if expected: break # Later output cannot undo evidence of this input.
            if matched:
                matches.append(expected if expected else {'kind': 'path' if agent == 'pi' else 'id', 'value': path if agent == 'pi' else found_id})
                if len(matches) > 1: return {'status': 'ambiguous'}
    return {'status': 'found', 'session': matches[0]} if len(matches) == 1 else {'status': 'none'}

try:
    q = json.load(sys.stdin)
    print(json.dumps(scan(q)))
except Exception:
    print(json.dumps({'status': 'unavailable', **({'reason': 'unreadable'} if globals().get('q', {}).get('expected') else {})}))
`;

export function discoveryCommand(profile?: MachineProfile): string[] {
  if (!profile) return ["python3", "-c", sessionScanner];
  const target = parseTarget(profile.target);
  const quoted = `'${sessionScanner.replace(/'/g, `'\\''`)}'`;
  return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8",
    ...(target.port ? ["-p", String(target.port)] : []), "--", target.user ? `${target.user}@${target.host}` : target.host,
    `exec "${"${SHELL:-/bin/sh}"}" -lc ${shellQuote(`python3 -c ${quoted}`)}`];
}

export async function scanSessionHistory(query: SessionQuery, profile?: MachineProfile, env = process.env): Promise<SessionDiscovery> {
  let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    proc = Bun.spawn(discoveryCommand(profile), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    timer = setTimeout(() => { timedOut = true; proc?.kill(); }, 12_000);
    proc.stdin.write(JSON.stringify(query)); proc.stdin.end();
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (code !== 0) return { status: "unavailable", reason: timedOut ? "read_timeout" : "unreadable" };
    const result = JSON.parse(stdout) as SessionDiscovery;
    if (!["found", "none", "ambiguous", "unavailable"].includes(result.status)) return { status: "unavailable" };
    if (result.status === "found" && (!result.session || !["id", "path"].includes(result.session.kind) || typeof result.session.value !== "string")) return { status: "unavailable" };
    if (result.reason && !PROOF_FAILURES.includes(result.reason)) return { status: "unavailable", reason: "unreadable" };
    return result;
  } catch { return { status: "unavailable" }; }
  finally { clearTimeout(timer); }
}

/** Validate this live submission against its reported session, distinct from discovering unknown history. */
export async function verifyReportedSession(e: Execution, b: Broadcast, expected: DiscoveredSession): Promise<SessionDiscovery> {
  if (!canVerifySession(e.agent_kind)) return { status: "unavailable", reason: "unsupported_agent" };
  if (!nativeResumeArgs(e.agent_kind, expected.kind, expected.value)) return { status: "unavailable", reason: "invalid_identity" };
  if (!e.cwd || !e.sent_at || !e.agent_kind) return { status: "unavailable", reason: "unreadable" };
  try {
    const profile = e.machine_id === LOCAL ? undefined : (await machineList()).find(m => m.id === e.machine_id && m.enabled);
    if (e.machine_id !== LOCAL && !profile) return { status: "unavailable", reason: "unreadable" };
    return await scanSessionHistory({ agent: e.agent_kind, cwd: e.cwd, prompt: b.prompt, sentAt: e.sent_at, expected }, profile);
  } catch { return { status: "unavailable", reason: "unreadable" }; }
}

export async function discoverSession(e: Execution, b: Broadcast): Promise<SessionDiscovery> {
  if (!e.cwd || !e.sent_at || !e.agent_kind || !["pi", "claude", "codex"].includes(e.agent_kind)) return { status: "none" };
  try {
    const profile = e.machine_id === LOCAL ? undefined : (await machineList()).find((m) => m.id === e.machine_id && m.enabled);
    if (e.machine_id !== LOCAL && !profile) return { status: "unavailable" };
    return await scanSessionHistory({ agent: e.agent_kind, cwd: e.cwd, prompt: b.prompt, sentAt: e.sent_at }, profile);
  } catch { return { status: "unavailable" }; }
}
