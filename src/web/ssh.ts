/**
 * Adding an SSH machine from the web page, one step at a time, without ever asking for a password:
 *
 * 1. the address, checked here before anything runs. It may be a Host from ~/.ssh/config: what
 *    it stands for (the real host, port, user, key) is read with `ssh -G`, as ssh itself would;
 *    a server that wants a .pem gets a Host entry written for it, after the user has seen it;
 * 2. the server's host key, shown as fingerprints for the user to trust (written to known_hosts
 *    only after a fresh scan matches what they saw);
 * 3. this Mac's public key, which the user puts on the server themselves (or the .pem the config
 *    names); then a login with `BatchMode=yes` — no prompt at all, as Herdr's own background
 *    connections make — says whether it took;
 * 4. `herdr machine add`, which saves the machine where Herdr's sidebar shows it. Herdr runs
 *    ssh, so a Host entry and its key serve it as they serve ssh.
 *
 * Every command runs as argv, never through a shell, and the address is validated first.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, appendFileSync, chmodSync, copyFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { promises as dnsPromises } from "node:dns";
import { Socket } from "node:net";
import { homedir, hostname, tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { herdrBin, runHerdr, workspaceCreate, workspaceFocus, LOCAL } from "../herdr.ts";

export interface SshTarget {
  user: string | null;
  host: string;
  port: number | null;
  /** as Herdr takes it: `user@host`, or `ssh://user@host:port` with a port */
  text: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * `host`, `user@host`, `user@host:2222`, `ssh://user@host:2222` or `user@[::1]:2222`. Anything
 * else — spaces, a leading dash, shell characters — is refused before it reaches a command.
 */
export function parseTarget(input: string): SshTarget {
  let text = input.trim().replace(/^ssh:\/\//, "").replace(/\/+$/, "");
  if (!text) throw new Error("请填写服务器地址");
  let user: string | null = null;
  const at = text.lastIndexOf("@");
  if (at >= 0) {
    user = text.slice(0, at);
    text = text.slice(at + 1);
    if (!USER.test(user)) throw new Error(`用户名不对：${user}`);
  }
  let host = text;
  let port: number | null = null;
  const bracket = /^\[([0-9A-Fa-f:.]+)\](?::(\d+))?$/.exec(text);
  if (bracket) {
    host = bracket[1]!;
    port = bracket[2] ? Number(bracket[2]) : null;
  } else {
    const colon = text.lastIndexOf(":");
    if (colon > 0 && text.indexOf(":") === colon) {
      host = text.slice(0, colon);
      port = Number(text.slice(colon + 1));
    }
    if (!NAME.test(host)) throw new Error(`地址不对：${host}`);
  }
  if (port !== null && !(Number.isInteger(port) && port > 0 && port < 65_536)) throw new Error("端口不对");
  if (port === 22) port = null;
  const who = user ? `${user}@` : "";
  const where = host.includes(":") ? `[${host}]` : host;
  return { user, host, port, text: port ? `ssh://${who}${where}:${port}` : `${who}${where}` };
}

/** How the host appears in known_hosts: by HostKeyAlias when the config sets one. */
function knownHostsName(t: SshTarget, alias: string | null = null): string {
  const name = alias ?? t.host;
  return t.port ? `[${name}]:${t.port}` : name;
}

// ---- what an address stands for ------------------------------------------------------------

export interface Resolved {
  /** the host ssh connects to, after ~/.ssh/config */
  host: string;
  port: number;
  user: string;
  /** what was typed is a Host from the config, standing for another address */
  alias: boolean;
  hostKeyAlias: string | null;
  /** a key the config names for this host (a .pem, say), rather than ssh's default ones */
  identity: KeyFile | null;
}

/** ssh's own default key files: a config naming only these names no key of its own. */
const DEFAULT_IDENTITY = /\/\.ssh\/id_(rsa|dsa|ecdsa|ecdsa_sk|ed25519|ed25519_sk|xmss)$/;

/** The address as ssh would connect to it, read with `ssh -G` (no connection is made). */
export async function resolveTarget(t: SshTarget): Promise<Resolved> {
  const ran = await run(["ssh", "-G", ...sshArgs(t)], { timeoutMs: 8_000 });
  const values = new Map<string, string[]>();
  for (const line of ran.stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const key = line.slice(0, space).toLowerCase();
    values.set(key, [...(values.get(key) ?? []), line.slice(space + 1).trim()]);
  }
  const one = (key: string) => values.get(key)?.[0] ?? null;
  let host = one("hostname") ?? t.host;
  // a config's HostName is used as an argument below: nothing that reads as an option
  if (host.startsWith("-") || /\s/.test(host)) host = t.host;
  const port = Number(one("port") ?? t.port ?? 22) || 22;
  const user = one("user") ?? t.user ?? "";
  const files = (values.get("identityfile") ?? []).map(expandHome);
  const own = files.filter((f) => !DEFAULT_IDENTITY.test(f) && existsSync(f));
  const identityFile = one("identitiesonly") === "yes" ? files.find((f) => existsSync(f)) ?? own[0] : own[0];
  return {
    host, port, user,
    alias: host.toLowerCase() !== t.host.toLowerCase(),
    hostKeyAlias: one("hostkeyalias"),
    identity: identityFile ? await inspectKey(identityFile) : null,
  };
}

/** The address ssh really reaches, for the tools that do not read ~/.ssh/config. */
function realTarget(t: SshTarget, r: Resolved): SshTarget {
  const port = r.port === 22 ? null : r.port;
  const where = r.host.includes(":") ? `[${r.host}]` : r.host;
  return { user: r.user || null, host: r.host, port, text: port ? `ssh://${r.user ? `${r.user}@` : ""}${where}:${port}` : `${r.user ? `${r.user}@` : ""}${where}` };
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function tildePath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

// ---- a key file (a .pem) -------------------------------------------------------------------

export interface KeyFile {
  /** absolute */
  path: string;
  /** as a person would write it, ~ for the home folder */
  display: string;
  /** readable by others: ssh refuses such a key */
  loose: boolean;
  /** a passphrase guards it: Herdr's background connections need it in the agent (ssh-add) */
  passphrase: boolean;
  /** not a private key ssh can read */
  invalid: boolean;
}

/** What a private key file is like, as ssh will find it. */
export async function inspectKey(input: string): Promise<KeyFile> {
  const raw = input.trim();
  if (!raw) throw new Error("请填写私钥文件的路径");
  if (/[\n\r"]/.test(raw)) throw new Error("私钥路径里不能有引号或换行");
  const path = resolvePath(expandHome(raw));
  if (!isAbsolute(path)) throw new Error("私钥路径要写完整，例如 ~/.ssh/server.pem");
  let mode: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error(`${tildePath(path)} 不是文件`);
    mode = st.mode;
  } catch (error) {
    if (error instanceof Error && /不是文件/.test(error.message)) throw error;
    throw new Error(`找不到私钥文件：${tildePath(path)}`);
  }
  // reading the public half with an empty passphrase: works, asks for one, or is not a key. ssh-keygen
  // refuses a key others can read before looking at it, so it reads a private copy
  const probeDir = mkdtempSync(join(tmpdir(), "herdr-broadcast-key-"));
  let ran: Ran;
  try {
    const copy = join(probeDir, "key");
    copyFileSync(path, copy);
    chmodSync(copy, 0o600);
    ran = await run(["ssh-keygen", "-y", "-P", "", "-f", copy]);
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
  const passphrase = ran.code !== 0 && /passphrase|incorrect/i.test(ran.stderr);
  const invalid = ran.code !== 0 && !passphrase;
  return { path, display: tildePath(path), loose: (mode & 0o077) !== 0, passphrase, invalid };
}

/** chmod 600: what ssh wants of a private key. */
export async function tightenKey(input: string): Promise<KeyFile> {
  const key = await inspectKey(input);
  chmodSync(key.path, 0o600);
  return inspectKey(key.path);
}

// ---- a Host entry in ~/.ssh/config ---------------------------------------------------------

export interface ConfigEntry {
  name: string;
  text: string;
  file: string;
}

/** A name for the entry: the label if it makes one, else the host. */
export function suggestEntryName(t: SshTarget, label: string | null): string {
  const fromLabel = (label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return fromLabel || t.host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}

const configFile = () => join(homedir(), ".ssh", "config");

/** The Host names ~/.ssh/config already has. */
function configHosts(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const m = /^\s*Host\s+(.+)$/i.exec(line);
    if (m) for (const name of m[1]!.split(/\s+/)) names.add(name.toLowerCase());
  }
  return names;
}

/** The entry a server with its own key needs; nothing is written. */
export async function configEntry(t: SshTarget, keyInput: string, nameInput: string): Promise<ConfigEntry & { key: KeyFile; taken: boolean }> {
  if (!t.user) throw new Error("用 pem 登录的服务器要写用户名：user@地址（常见的是 ubuntu、ec2-user 或 root）");
  const name = nameInput.trim();
  if (!NAME.test(name)) throw new Error("配置名只能用字母、数字、点、横线和下划线");
  const key = await inspectKey(keyInput);
  if (key.invalid) throw new Error(`${key.display} 不是 ssh 能用的私钥`);
  const quoted = /\s/.test(key.display) ? `"${key.display}"` : key.display;
  const lines = [`Host ${name}`, `  HostName ${t.host}`, `  User ${t.user}`, ...(t.port ? [`  Port ${t.port}`] : []), `  IdentityFile ${quoted}`, "  IdentitiesOnly yes"];
  const existing = existsSync(configFile()) ? readFileSync(configFile(), "utf8") : "";
  return { name, text: `${lines.join("\n")}\n`, file: tildePath(configFile()), key, taken: configHosts(existing).has(name.toLowerCase()) };
}

/**
 * A config with the entry put before its first Host or Match block, or after everything when it
 * has none: ssh takes the first value it finds, so an entry after a `Host *` would lose to it,
 * and global options at the top stay global.
 */
export function insertEntry(before: string | null, entry: string): string {
  const block = `# added by herdr-broadcast\n${entry.replace(/\n*$/, "\n")}`;
  if (before === null || before.trim() === "") return block;
  const lines = before.split("\n");
  const at = lines.findIndex((l) => /^\s*(Host|Match)\s/i.test(l));
  if (at === -1) return `${before.replace(/\n*$/, "\n")}\n${block}`;
  return [...lines.slice(0, at), ...block.split("\n"), ...lines.slice(at)].join("\n");
}

/**
 * Writes the entry into ~/.ssh/config, before the first Host or Match block: ssh takes the first
 * value it finds, so an entry after a `Host *` would lose to it, and global options at the top stay
 * global. The file as it was is kept beside it. Returns where ssh then resolves the name, to show
 * if anything else in the config still overrides it.
 */
export async function writeConfigEntry(t: SshTarget, keyInput: string, nameInput: string): Promise<{ name: string; backup: string | null; resolved: Resolved }> {
  const entry = await configEntry(t, keyInput, nameInput);
  if (entry.taken) throw new Error(`~/.ssh/config 里已经有 Host ${entry.name}：换一个配置名`);
  mkdirSync(join(homedir(), ".ssh"), { recursive: true, mode: 0o700 });
  const file = configFile();
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  let backup: string | null = null;
  if (before !== null) {
    backup = `${file}.herdr-broadcast.bak`;
    copyFileSync(file, backup);
  }
  writeFileSync(file, insertEntry(before, entry.text), { mode: 0o600 });
  if (before === null) chmodSync(file, 0o600);
  const resolved = await resolveTarget(parseTarget(entry.name));
  return { name: entry.name, backup: backup ? tildePath(backup) : null, resolved };
}

/** ssh's destination and port, for ssh itself. */
function sshArgs(t: SshTarget): string[] {
  return [...(t.port ? ["-p", String(t.port)] : []), t.user ? `${t.user}@${t.host}` : t.host];
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: string[], { timeoutMs = 15_000, input }: { timeoutMs?: number; input?: string } = {}): Promise<Ran> {
  const proc = Bun.spawn(argv, { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (input !== undefined && proc.stdin) {
    proc.stdin.write(input);
    proc.stdin.end();
  }
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

// ---- reaching the server -------------------------------------------------------------------

export type Reach = "ok" | "dns" | "refused" | "timeout" | "reset" | "not-ssh";

export interface Diagnosis {
  reach: Reach;
  /** what went wrong, in a sentence */
  message: string;
  /** what to check, most likely first */
  hints: string[];
  /** the address the name resolved to, when it did */
  address: string | null;
}

const lookup = (host: string) => dnsPromises.lookup(host);

/**
 * Why ssh got nowhere, found step by step: the name, then the port, then whether an SSH server
 * answers on it. "The port opens but the connection is cut" is told apart from "nothing listens",
 * since the two are fixed in different places.
 */
export async function diagnose(t: SshTarget): Promise<Diagnosis> {
  const port = t.port ?? 22;
  const where = `${t.host}:${port}`;
  let address: string | null = null;
  try {
    address = (await lookup(t.host)).address;
  } catch {
    return { reach: "dns", address: null, message: `找不到主机 ${t.host}`, hints: ["检查地址有没有写错", "域名要能在这台 Mac 上解析：试试 ping 它"] };
  }
  const opened = await new Promise<"open" | "refused" | "timeout" | "other">((resolve) => {
    const socket = new Socket();
    const done = (how: "open" | "refused" | "timeout" | "other") => { socket.destroy(); resolve(how); };
    socket.setTimeout(6_000, () => done("timeout"));
    socket.once("connect", () => done("open"));
    socket.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED" ? "refused" : error.code === "ETIMEDOUT" ? "timeout" : "other"));
    socket.connect(port, address!);
  });
  if (opened === "refused") return { reach: "refused", address, message: `${where} 拒绝连接：这个端口上没有服务在监听`, hints: ["检查端口：SSH 不在 22 时，地址写成 user@地址:端口", "检查服务器上的 sshd 有没有运行（systemctl status sshd）"] };
  if (opened !== "open") return { reach: "timeout", address, message: `连接 ${where} 超时`, hints: ["检查地址和网络：这台 Mac 能不能 ping 通它", "服务器或中间的防火墙、安全组有没有放行这个端口", "需要 VPN 才能访问的内网地址，先连上 VPN"] };
  // the port opens: does an SSH server greet on it, or is the connection cut, or does nothing answer?
  const greeting = await new Promise<{ text: string; how: "data" | "cut" | "silent" }>((resolve) => {
    const socket = new Socket();
    let got = "";
    const done = (how: "data" | "cut" | "silent") => { socket.destroy(); resolve({ text: got, how }); };
    socket.setTimeout(6_000, () => done(got ? "data" : "silent"));
    socket.on("data", (chunk: Buffer) => { got += chunk.toString("latin1"); if (got.includes("\n")) done("data"); });
    socket.once("error", () => done(got ? "data" : "cut"));
    socket.once("close", () => done(got ? "data" : "cut"));
    socket.connect(port, address!);
  });
  if (greeting.how === "cut") {
    return {
      reach: "reset", address,
      message: `${where} 的端口是通的，但连接一建立就被断开了，SSH 服务没有应答`,
      hints: [
        "服务器限制了来源 IP：看 /etc/hosts.allow、/etc/hosts.deny，或 fail2ban 有没有封了你的 IP",
        "服务器的 SSH 连接数满了（sshd_config 里的 MaxStartups）",
        "这台 Mac 开着代理或 VPN（如 Clash 的 TUN 模式）时，流量可能被它接管：让这个地址直连再试",
      ],
    };
  }
  if (greeting.how === "silent") {
    return { reach: "not-ssh", address, message: `${where} 的端口是通的，但没有 SSH 服务应答`, hints: ["检查端口：这个端口上可能是别的服务", "代理或 VPN 接管了这个连接时也会这样：让这个地址直连再试"] };
  }
  if (!/^SSH-/m.test(greeting.text)) return { reach: "not-ssh", address, message: `${where} 上应答的不是 SSH 服务`, hints: ["检查端口：这个端口上跑的是别的服务"] };
  return { reach: "ok", address, message: "", hints: [] };
}

// ---- host keys -----------------------------------------------------------------------------

export interface HostKey {
  type: string;
  fingerprint: string;
}

/**
 * The server's host keys as it presents them now: the known_hosts lines, and their fingerprints.
 * `t` is the real address (ssh-keyscan reads no config); lines are named as ssh will look them up.
 */
async function scanHostKeys(t: SshTarget, alias: string | null = null): Promise<{ lines: string[]; keys: HostKey[]; error: string | null; diagnosis: Diagnosis | null }> {
  const scan = await run(["ssh-keyscan", "-T", "6", ...(t.port ? ["-p", String(t.port)] : []), t.host], { timeoutMs: 15_000 });
  const name = knownHostsName(t, alias);
  const lines = scan.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => `${name} ${l.split(/\s+/).slice(1).join(" ")}`);
  if (lines.length === 0) {
    // ssh-keyscan's own words are terse: find out where it stopped
    const diagnosis = await diagnose(t);
    const why = scan.stderr.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).pop() ?? "";
    return { lines, keys: [], error: diagnosis.reach === "ok" ? why || "没能取得服务器的主机指纹" : diagnosis.message, diagnosis: diagnosis.reach === "ok" ? null : diagnosis };
  }
  const prints = await run(["ssh-keygen", "-l", "-f", "-"], { input: `${lines.join("\n")}\n` });
  const keys = prints.stdout.split("\n").map((l) => /^\d+\s+(\S+)\s+.*\(([^)]+)\)\s*$/.exec(l.trim())).filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ fingerprint: m[1]!, type: m[2]! }));
  return { lines, keys, error: null, diagnosis: null };
}

async function hostKnown(t: SshTarget, alias: string | null = null): Promise<boolean> {
  return (await run(["ssh-keygen", "-F", knownHostsName(t, alias)])).code === 0;
}

/**
 * Trusts the server's host keys: scanned again, and written only if they are the very ones the
 * user was shown, so a key that changed in between is not trusted unseen.
 */
export async function trustHostKey(typed: SshTarget, fingerprints: string[]): Promise<void> {
  const r = await resolveTarget(typed);
  const scan = await scanHostKeys(realTarget(typed, r), r.hostKeyAlias);
  if (scan.error) throw new Error(scan.error);
  const now = scan.keys.map((k) => k.fingerprint).sort().join(",");
  if (now !== [...fingerprints].sort().join(",")) throw new Error("服务器的指纹和刚才显示的不一样了，请重新检查");
  const dir = join(homedir(), ".ssh");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "known_hosts");
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  appendFileSync(file, `${before && !before.endsWith("\n") ? "\n" : ""}${scan.lines.join("\n")}\n`);
  chmodSync(file, 0o600);
}

// ---- this Mac's key ------------------------------------------------------------------------

export interface LocalKey {
  path: string;
  publicKey: string;
  /** a passphrase guards it: Herdr's background connections need it in the agent (ssh-add) */
  passphrase: boolean;
}

/** The keys ssh offers by default, newest kind first. */
const DEFAULT_KEYS = ["id_ed25519", "id_ecdsa", "id_rsa"];

export async function localKey(): Promise<LocalKey | null> {
  for (const name of DEFAULT_KEYS) {
    const priv = join(homedir(), ".ssh", name);
    if (!existsSync(priv) || !existsSync(`${priv}.pub`)) continue;
    const publicKey = readFileSync(`${priv}.pub`, "utf8").trim();
    // reading the public half with an empty passphrase fails when there is one
    const passphrase = (await run(["ssh-keygen", "-y", "-P", "", "-f", priv])).code !== 0;
    return { path: `${priv}.pub`, publicKey, passphrase };
  }
  return null;
}

/** Makes ~/.ssh/id_ed25519 when this Mac has no key at all. Never replaces one. */
export async function generateKey(): Promise<LocalKey> {
  if (await localKey()) throw new Error("本机已经有密钥了");
  const priv = join(homedir(), ".ssh", "id_ed25519");
  if (existsSync(priv) || existsSync(`${priv}.pub`)) throw new Error(`${priv} 已经存在`);
  mkdirSync(join(homedir(), ".ssh"), { recursive: true, mode: 0o700 });
  const made = await run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", `herdr-broadcast@${hostname()}`, "-f", priv]);
  if (made.code !== 0) throw new Error(made.stderr.trim() || "生成密钥失败");
  return (await localKey())!;
}

// ---- logging in ----------------------------------------------------------------------------

export type LoginProblem = "host-key" | "host-key-changed" | "auth" | "dns" | "refused" | "timeout" | "reset" | "other";

export interface Login {
  ok: boolean;
  problem: LoginProblem | null;
  /** ssh's own words when it failed */
  error: string | null;
  /** `uname -sm` on the server */
  system: string | null;
  /** whether Herdr runs on that system */
  supported: boolean | null;
  /** `herdr --version` there, or null when it is not installed */
  herdr: string | null;
  /** the private Herdr herdr-web-ui installed there for its own bridge, which Herdr does not use */
  webUiHerdr: string | null;
  /** this computer's Herdr version: the one `herdr machine add` installs there when it differs */
  localHerdr: string | null;
  /** where the connection stopped, when it did not get as far as logging in */
  diagnosis: Diagnosis | null;
  /** the command that forgets an old host key, when the server's has changed */
  forget: string | null;
}

export function classifySshError(stderr: string): LoginProblem {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i.test(stderr)) return "host-key-changed";
  if (/kex_exchange_identification|Connection reset by peer|Connection closed by remote host/i.test(stderr)) return "reset";
  if (/Host key verification failed|No .* host key is known/i.test(stderr)) return "host-key";
  if (/Permission denied|Too many authentication failures/i.test(stderr)) return "auth";
  if (/Could not resolve hostname|nodename nor servname|Name or service not known/i.test(stderr)) return "dns";
  if (/Connection refused/i.test(stderr)) return "refused";
  if (/timed out|Connection timeout/i.test(stderr)) return "timeout";
  return "other";
}

/**
 * What the server says about itself; Herdr may be outside a non-login shell's PATH. herdr-web-ui
 * keeps a private Herdr of its own there, which Herdr itself does not use: told apart.
 */
const PROBE = 'uname -sm; v=; for h in "$(command -v herdr 2>/dev/null)" "$HOME/.local/bin/herdr"; do if [ -n "$h" ] && [ -x "$h" ]; then v=$("$h" --version 2>/dev/null); break; fi; done; echo "herdr=$v"; '
  + 'w=$(ls -d "$HOME"/.local/share/herdr-web-ui/remote-v*/bin/herdr 2>/dev/null | tail -n 1); if [ -n "$w" ]; then echo "webui=$("$w" --version 2>/dev/null)"; fi; true';

/** Logs in with no prompt allowed at all, as Herdr will: a key and a known host, or nothing. */
export async function verifyLogin(t: SshTarget, resolved?: Resolved): Promise<Login> {
  const ran = await run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes", ...sshArgs(t), PROBE], { timeoutMs: 25_000 });
  if (ran.code !== 0 || !ran.stdout.trim()) {
    const error = ran.stderr.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("@") && !/^Warning: Permanently/i.test(l)).slice(-2).join(" ") || `ssh 退出码 ${ran.code}`;
    const problem = classifySshError(ran.stderr);
    // a connection that never reached logging in: find out where it stopped
    const r = resolved ?? await resolveTarget(t);
    const real = realTarget(t, r);
    const network = ["dns", "refused", "timeout", "reset", "other"].includes(problem) ? await diagnose(real) : null;
    return {
      ok: false, problem, error, system: null, supported: null, herdr: null, webUiHerdr: null, localHerdr: null,
      diagnosis: network && network.reach !== "ok" ? network : null,
      forget: problem === "host-key-changed" ? forgetCommand(real, r.hostKeyAlias) : null,
    };
  }
  const [system = "", ...rest] = ran.stdout.trim().split("\n").map((l) => l.trim());
  const said = (name: string) => rest.find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1).trim() || null;
  const version = said("herdr");
  const supported = /^(Linux|Darwin)\s+(x86_64|amd64|aarch64|arm64)$/i.test(system);
  return { ok: true, problem: null, error: null, system: system || null, supported, herdr: version, webUiHerdr: said("webui"), localHerdr: await localHerdrVersion(), diagnosis: null, forget: null };
}

/** `herdr --version` here, as `herdr 0.9.5`. */
export async function localHerdrVersion(): Promise<string | null> {
  const ran = await runHerdr(["--version"], { timeoutMs: 5_000 }).catch(() => null);
  const line = ran && ran.code === 0 ? ran.stdout.trim().split("\n")[0]!.trim() : "";
  return line || null;
}

/** The two say the same version (`herdr 0.9.5`), or nothing is known to tell them apart. */
export function sameHerdr(remote: string | null, local: string | null): boolean {
  const v = (s: string | null) => (s ? /\d+\.\d+\.\d+[\w.-]*/.exec(s)?.[0] ?? s : null);
  return !!remote && (!local || v(remote) === v(local));
}

/** `ssh-keygen -R` for this host as known_hosts names it, quoted for a shell. */
export function forgetCommand(t: SshTarget, alias: string | null = null): string {
  const name = knownHostsName(t, alias);
  return t.port ? `ssh-keygen -R '${name}'` : `ssh-keygen -R ${name}`;
}

/**
 * The first look at an address: what it stands for, its host key, this Mac's key, and a login if
 * the host is known.
 */
export async function checkTarget(t: SshTarget): Promise<{ target: string; resolved: Resolved; known: boolean; keys: HostKey[]; scanError: string | null; diagnosis: Diagnosis | null; key: LocalKey | null; login: Login | null }> {
  const resolved = await resolveTarget(t);
  const real = realTarget(t, resolved);
  const [known, key] = await Promise.all([hostKnown(real, resolved.hostKeyAlias), localKey()]);
  if (known) return { target: t.text, resolved, known, keys: [], scanError: null, diagnosis: null, key, login: await verifyLogin(t, resolved) };
  const scan = await scanHostKeys(real, resolved.hostKeyAlias);
  return { target: t.text, resolved, known, keys: scan.keys, scanError: scan.error, diagnosis: scan.diagnosis, key, login: null };
}

// ---- adding --------------------------------------------------------------------------------

/** `machine add` for an address, a label, and a named session there (null: the default one). */
export function addArgs(t: SshTarget, label: string | null, session: string | null): string[] {
  return ["machine", "add", t.text, ...(label ? ["--label", label] : []), ...(session ? ["--remote-session", session] : [])];
}

/** A session name from a request: refused unless it is a plain name. */
export function parseSession(input: unknown): string | null {
  const session = typeof input === "string" ? input.trim() : "";
  if (!session || session === "default") return null;
  if (!NAME.test(session)) throw new Error(`会话名不对：${session}`);
  return session;
}

/** The add command as a terminal would take it, quoted. */
export function addCommand(t: SshTarget, label: string | null, session: string | null = null): string {
  const quote = (s: string) => (/^[\w@%+=:,./~[\]-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  return [herdrBin(), ...addArgs(t, label, session)].map(quote).join(" ");
}

/**
 * Opens a Herdr workspace on this machine with `herdr machine add` typed into it, for the
 * questions only a terminal can answer: a session to pick, installing or updating Herdr there.
 */
export async function openAddTerminal(t: SshTarget, label: string | null, session: string | null = null): Promise<{ workspaceId: string | null; workspaceLabel: string | null; paneId: string | null }> {
  const created = await workspaceCreate(LOCAL, { cwd: homedir(), label: Array.from(`添加机器 ${label || t.host}`).slice(0, 36).join("") });
  const pane = created.root_pane?.pane_id ?? null;
  const workspaceId = created.workspace?.workspace_id ?? created.root_pane?.workspace_id ?? null;
  if (pane) {
    const typed = await runHerdr(["pane", "run", pane, addCommand(t, label, session)]);
    if (typed.code !== 0) throw new Error(typed.stderr.trim() || "没能在新标签页里运行命令");
  }
  if (workspaceId) await workspaceFocus(LOCAL, workspaceId).catch(() => undefined);
  return { workspaceId, workspaceLabel: created.workspace?.label ?? null, paneId: pane };
}

// ---- machines saved in herdr-web-ui ---------------------------------------------------------
//
// herdr-web-ui reads Herdr's machines, but a PC added there ("Add PC") stays in its own
// machines.json and reaches the PC through its own bridge: Herdr, its CLI and this plugin never
// see it. Such a PC is offered here so the wizard can add it to Herdr too.

/** herdr-web-ui's state directory, as it finds it itself. */
export function webUiStateDir(): string {
  return process.env.HERDR_WEB_STATE_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr-web-ui");
}

export interface WebUiMachine {
  id: string;
  name: string;
  /** the address as the wizard takes it, port included */
  target: string;
  /** the key herdr-web-ui logs in with, when ssh would not find it by itself (shown as ~/…) */
  key: string | null;
  /** that key is one herdr-web-ui generated, and it deletes it with the PC */
  appKey: boolean;
  /** a named Herdr session there; null for the default one */
  session: string | null;
  enabled: boolean;
  /** an address the wizard cannot take */
  error: string | null;
}

/** The SSH PCs in herdr-web-ui's machines.json (not its local one, nor rows it inherited from Herdr). */
export function parseWebUiMachines(text: string, stateDir: string = webUiStateDir()): WebUiMachine[] {
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    throw new Error("herdr-web-ui 的 machines.json 不是有效的 JSON");
  }
  if (!Array.isArray(rows)) return [];
  const appKeys = join(stateDir, "ssh") + "/";
  return rows.flatMap((row): WebUiMachine[] => {
    if (!row || typeof row !== "object") return [];
    const m = row as { id?: unknown; name?: unknown; enabled?: unknown; herdr_profile_id?: unknown; target?: { destination?: unknown; port?: unknown; identity_file?: unknown; session?: unknown } };
    const destination = typeof m.target?.destination === "string" ? m.target.destination.trim() : "";
    if (typeof m.id !== "string" || !destination || m.herdr_profile_id) return [];
    const port = typeof m.target?.port === "number" ? m.target.port : null;
    // `user@host` and a port beside it, written as one address: `user@[::1]:2222` for IPv6
    const at = destination.lastIndexOf("@");
    const host = destination.slice(at + 1);
    const address = `${destination.slice(0, at + 1)}${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}`;
    let target = port && port !== 22 ? `${address}:${port}` : address;
    let error: string | null = null;
    try {
      target = parseTarget(target).text;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const file = typeof m.target?.identity_file === "string" && m.target.identity_file ? expandHome(m.target.identity_file) : null;
    const session = typeof m.target?.session === "string" && m.target.session && m.target.session !== "default" ? m.target.session : null;
    if (session && !NAME.test(session)) error ??= `会话名不对：${session}`;
    return [{
      id: m.id,
      name: typeof m.name === "string" && m.name ? m.name : destination,
      target,
      key: file && !DEFAULT_IDENTITY.test(file) ? tildePath(file) : null,
      appKey: !!file && file.startsWith(appKeys),
      session,
      enabled: m.enabled !== false,
      error,
    }];
  });
}

/** Where an address really goes, after ~/.ssh/config, and in which session: two addresses alike here are one machine. */
async function machineKey(target: string, session: string | null): Promise<string | null> {
  try {
    const r = await resolveTarget(parseTarget(target));
    return `${r.user}@${r.host.toLowerCase()}:${r.port}#${session && session !== "default" ? session : ""}`;
  } catch {
    return null;
  }
}

/**
 * herdr-web-ui's own PCs that Herdr has no machine for yet. A Herdr machine saved under a Host
 * name still matches the address it stands for. `file` is null when herdr-web-ui saved none.
 */
export async function webUiMachines(herdr: { target: string; session: string }[], dir: string = webUiStateDir()): Promise<{ file: string | null; machines: WebUiMachine[] }> {
  const file = join(dir, "machines.json");
  if (!existsSync(file)) return { file: null, machines: [] };
  const saved = parseWebUiMachines(readFileSync(file, "utf8"), dir);
  const known = new Set((await Promise.all(herdr.map((m) => machineKey(m.target, m.session)))).filter(Boolean));
  const keys = await Promise.all(saved.map((m) => (m.error ? null : machineKey(m.target, m.session))));
  return { file: tildePath(file), machines: saved.filter((_, i) => !keys[i] || !known.has(keys[i])) };
}

// ---- machine status ------------------------------------------------------------------------

export interface MachineHealth {
  /** true reachable, false needs attention, null not known */
  ok: boolean | null;
  text: string;
}

/**
 * `herdr machine status --json` → a state per machine id. The shape is read defensively: an
 * array of entries, or an object holding one, matched by id or label.
 */
export function parseMachineStatus(parsed: unknown, machines: { id: string; label: string }[]): Record<string, MachineHealth> {
  const result: Record<string, MachineHealth> = {};
  const root = parsed && typeof parsed === "object" && "result" in parsed ? (parsed as { result: unknown }).result : parsed;
  const entries: Record<string, unknown>[] = [];
  const collect = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.id === "string" || typeof record.profile_id === "string" || typeof record.label === "string") entries.push(record);
      else for (const nested of Object.values(record)) if (Array.isArray(nested)) collect(nested);
    }
  };
  collect(root);
  for (const entry of entries) {
    const id = (entry.profile_id ?? entry.id) as string | undefined;
    const machine = machines.find((m) => m.id === id) ?? machines.find((m) => m.label === entry.label);
    if (!machine) continue;
    const pick = (...keys: string[]) => keys.map((k) => entry[k]).find((v) => typeof v === "string" && v.length > 0) as string | undefined;
    const state = pick("state", "status", "health", "connection");
    const error = pick("error", "message", "detail");
    const reachable = entry.reachable;
    const ok = reachable === true || /^(ok|online|reachable|connected|ready)$/i.test(state ?? "") ? true : reachable === false || state ? false : null;
    const head = state ?? (reachable === true ? "reachable" : reachable === false ? "unreachable" : "unknown");
    result[machine.id] = { ok, text: error && ok !== true ? `${head}: ${error}` : head };
  }
  return result;
}
