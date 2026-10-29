/** Read-only, bounded historical lookup. A unique exact prompt/time/cwd match is required. */
import type { Broadcast, Execution } from "./db.ts";
import { LOCAL, machineList, type MachineProfile } from "./herdr.ts";
import { parseTarget } from "./web/ssh.ts";

export interface DiscoveredSession { kind: "id" | "path"; value: string }
export interface SessionDiscovery { status: "found" | "none" | "ambiguous" | "unavailable"; session?: DiscoveredSession }
export interface SessionQuery { agent: string; cwd: string; prompt: string; sentAt: number; store?: string }

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
    files, seen = [], set()
    deadline = time.monotonic() + 8
    for pattern in patterns:
        for file in glob.iglob(pattern):
            path = os.path.realpath(file)
            if path in seen: continue
            seen.add(path); files.append(path)
            if len(files) > MAX_FILES or time.monotonic() > deadline: return {'status': 'unavailable'}
    matches, read = [], 0
    for path in files:
        if time.monotonic() > deadline: return {'status': 'unavailable'}
        session_id, session_cwd, matched = None, None, False
        with open(path, 'rb') as f:
            while True:
                line = f.readline(MAX_LINE + 1)
                if not line: break
                read += len(line)
                if len(line) > MAX_LINE or read > MAX_BYTES or time.monotonic() > deadline: return {'status': 'unavailable'}
                if not line.strip(): continue
                # An unreadable/incomplete transcript prevents proving uniqueness.
                entry = json.loads(line)
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
                if session_cwd == cwd and isinstance(session_id, str) and UUID.fullmatch(session_id) and when is not None and abs(when - sent) <= 10000 and plain(content) == prompt:
                    matched = True
                    found_id = session_id
            if matched:
                matches.append({'kind': 'path' if agent == 'pi' else 'id', 'value': path if agent == 'pi' else found_id})
                if len(matches) > 1: return {'status': 'ambiguous'}
    return {'status': 'found', 'session': matches[0]} if len(matches) == 1 else {'status': 'none'}

try:
    print(json.dumps(scan(json.load(sys.stdin))))
except Exception:
    print(json.dumps({'status': 'unavailable'}))
`;

export function discoveryCommand(profile?: MachineProfile): string[] {
  if (!profile) return ["python3", "-c", sessionScanner];
  const target = parseTarget(profile.target);
  const quoted = `'${sessionScanner.replace(/'/g, `'\\''`)}'`;
  return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8",
    ...(target.port ? ["-p", String(target.port)] : []), "--", target.user ? `${target.user}@${target.host}` : target.host,
    `python3 -c ${quoted}`];
}

export async function scanSessionHistory(query: SessionQuery, profile?: MachineProfile, env = process.env): Promise<SessionDiscovery> {
  let proc: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    proc = Bun.spawn(discoveryCommand(profile), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    timer = setTimeout(() => proc?.kill(), 12_000);
    proc.stdin.write(JSON.stringify(query)); proc.stdin.end();
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (code !== 0) return { status: "unavailable" };
    const result = JSON.parse(stdout) as SessionDiscovery;
    if (!["found", "none", "ambiguous", "unavailable"].includes(result.status)) return { status: "unavailable" };
    if (result.status === "found" && (!result.session || !["id", "path"].includes(result.session.kind) || typeof result.session.value !== "string")) return { status: "unavailable" };
    return result;
  } catch { return { status: "unavailable" }; }
  finally { clearTimeout(timer); }
}

export async function discoverSession(e: Execution, b: Broadcast): Promise<SessionDiscovery> {
  if (!e.cwd || !e.sent_at || !e.agent_kind || !["pi", "claude", "codex"].includes(e.agent_kind)) return { status: "none" };
  try {
    const profile = e.machine_id === LOCAL ? undefined : (await machineList()).find((m) => m.id === e.machine_id && m.enabled);
    if (e.machine_id !== LOCAL && !profile) return { status: "unavailable" };
    return await scanSessionHistory({ agent: e.agent_kind, cwd: e.cwd, prompt: b.prompt, sentAt: e.sent_at }, profile);
  } catch { return { status: "unavailable" }; }
}
