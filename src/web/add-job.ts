/**
 * `herdr machine add` run in a terminal of its own (a PTY), so that what it can only ask a
 * terminal — install Herdr there, stop or restart the server already running there — is asked
 * on the page instead. Installing was approved before the job started (the page says what it
 * installs and where); every other question is put to the user as Herdr words it.
 */
import { herdrBin, routeArgs } from "../herdr.ts";
import { addArgs, type SshTarget } from "./ssh.ts";
import { herdrAsset, platformOf, versionOf, type Progress } from "./herdr-asset.ts";

export type AddJobState = "downloading" | "running" | "question" | "done" | "failed" | "cancelled";

export interface AddQuestion {
  /** Herdr's own words */
  text: string;
  /** what Herdr printed before asking, since the last answer: why it asks */
  context: string;
  /** "server": stopping or restarting the Herdr server there, which closes what runs in it */
  kind: "install" | "server" | "other";
  /** what Enter alone answers */
  defaultYes: boolean;
}

export interface AddJob {
  id: string;
  target: string;
  state: AddJobState;
  question: AddQuestion | null;
  /** what the terminal showed, without colors or redraws */
  output: string;
  code: number | null;
  /** why it stopped, in the page's words, when Herdr's own are not enough */
  reason: string | null;
  /** the Herdr build being downloaded here for the server */
  download: (Progress & { what: string }) | null;
}

type Live = AddJob & { raw: string; answered: number; write: ((text: string) => void) | null; kill: () => void; abort: AbortController };

export interface AddOptions {
  label: string | null;
  /** a named session there; null for the default one */
  session: string | null;
  /** the user chose to install Herdr there: that question is answered yes */
  install: boolean;
  /** `uname -sm` there, for the build to download */
  system: string | null;
}

/** how long a job may run, waiting on answers included */
const JOB_MS = 15 * 60_000;
const OUTPUT_CHARS = 16_000;

const PROMPT = /\[(y\/N|Y\/n)\]\s*$/;
const INSTALL = /^(install .*\bherdr\b|continue installing the remote herdr)/i;
/** a secret asked for: the page never takes one, a key has to do */
const SECRET = /(password|passphrase)[^\n]*:\s*$/i;

/** Terminal output as text: no escapes, and a line redrawn with \r keeps only its last state. */
export function terminalText(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** The question the output ends on, if it ends on one. */
export function questionIn(text: string): AddQuestion | null {
  const lines = text.trimEnd().split("\n");
  const last = lines.pop()?.trim() ?? "";
  const m = PROMPT.exec(last);
  if (!m) return null;
  return {
    text: last,
    context: lines.map((l) => l.trimEnd()).filter(Boolean).slice(-8).join("\n"),
    kind: INSTALL.test(last) ? "install" : /\bserver\b/i.test(last) ? "server" : "other",
    defaultYes: m[1] === "Y/n",
  };
}

export class AddJobs {
  private jobs = new Map<string, Live>();
  private pending = new Set<Promise<void>>();
  private next = 1;

  /**
   * `cacheDir`: where downloaded Herdr builds are kept. `localVersion`: this computer's Herdr,
   * the version `machine add` puts on a server.
   */
  constructor(
    private readonly onDone: (job: AddJob) => void | Promise<void>,
    private readonly cacheDir: string,
    private readonly localVersion: () => Promise<string | null>,
  ) {}

  start(t: SshTarget, o: AddOptions): AddJob {
    const id = `add-${this.next++}`;
    const job: Live = {
      id, target: t.text, state: "running", question: null, output: "", code: null, reason: null, download: null, raw: "", answered: 0, write: null, kill: () => undefined, abort: new AbortController(),
    };
    this.jobs.set(id, job);
    const work = this.run(job, t, o).catch(error => this.fail(job, error));
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
    return this.view(job);
  }

  private async finish(job: Live): Promise<void> {
    try { await this.onDone(this.view(job)); }
    catch (error) { console.error("herdr-broadcast: machine update failed", error); }
  }

  private async fail(job: Live, error: unknown): Promise<void> {
    if (job.state !== "cancelled") Object.assign(job, { state: "failed", reason: error instanceof Error ? error.message : String(error) });
    job.download = null;
    job.question = null;
    job.write = null;
    await this.finish(job);
  }

  private async run(job: Live, t: SshTarget, o: AddOptions): Promise<void> {
    const env: Record<string, string | undefined> = { ...process.env, TERM: "xterm-256color" };
    const platform = platformOf(o.system);
    const version = versionOf(await this.localVersion());
    if (job.abort.signal.aborted) return void (await this.finish(job));
    if (o.install && platform && version && !process.env.HERDR_REMOTE_BINARY) {
      Object.assign(job, { state: "downloading", download: { done: 0, total: null, what: `Herdr ${version}（${platform}）` } });
      try {
        env.HERDR_REMOTE_BINARY = await herdrAsset(this.cacheDir, version, platform, (p) => { job.download = { ...p, what: job.download!.what }; }, job.abort.signal);
      } catch (error) {
        if (job.state !== "cancelled") Object.assign(job, { state: "failed", reason: error instanceof Error ? error.message : String(error) });
        job.download = null;
        await this.finish(job);
        return;
      }
      job.download = null;
      if (job.state === "cancelled") return void (await this.finish(job));
      job.state = "running";
    }
    await this.spawn(job, t, o, env);
  }

  private spawn(job: Live, t: SshTarget, o: AddOptions, env: Record<string, string | undefined>): Promise<void> {
    const installApproved = o.install;
    // with a terminal Herdr would offer a session picker: the default one unless another was named
    const argv = [herdrBin(), ...routeArgs(undefined), ...addArgs(t, o.label, o.session ?? "default")];
    const decoder = new TextDecoder();
    const proc = Bun.spawn(argv, {
      env,
      terminal: {
        cols: 160,
        rows: 50,
        data: (terminal, data) => {
          const raw = job.raw + decoder.decode(data, { stream: true });
          const dropped = Math.max(0, raw.length - OUTPUT_CHARS * 2);
          job.raw = raw.slice(dropped);
          job.answered = Math.max(0, job.answered - dropped);
          job.output = terminalText(job.raw).slice(-OUTPUT_CHARS);
          // a question already answered stays on screen until its echo arrives
          if (job.state !== "running" || job.raw.length <= job.answered) return;
          if (SECRET.test(job.output)) {
            job.reason = "服务器在要密码：插件不接收密码。先在「免密登录」一步把公钥放到服务器上。";
            job.state = "cancelled";
            proc.kill();
            return;
          }
          // only what came after the last answer: an old question's lines are not this one's reasons
          const question = questionIn(terminalText(job.raw.slice(job.answered)));
          if (!question) return;
          job.answered = job.raw.length;
          if (question.kind === "install" && installApproved) terminal.write("y\r");
          else Object.assign(job, { state: "question", question });
        },
      },
    });
    job.write = (text) => proc.terminal?.write(text);
    job.kill = () => proc.kill();
    const timer = setTimeout(() => proc.kill(), JOB_MS);
    return proc.exited.then(async (code) => {
      clearTimeout(timer);
      job.write = null;
      job.code = code;
      if (job.state !== "cancelled") job.state = code === 0 ? "done" : "failed";
      if (job.state === "failed" && code === null) job.reason = "超过 15 分钟没有完成，已停止。";
      job.question = null;
      await this.finish(job);
    }).catch(error => this.fail(job, error));
  }

  get(id: string): AddJob | null {
    const job = this.jobs.get(id);
    return job ? this.view(job) : null;
  }

  answer(id: string, yes: boolean): AddJob {
    const job = this.jobs.get(id);
    if (!job) throw Object.assign(new Error("没有这个添加任务"), { status: 404 });
    if (job.state !== "question" || !job.write) throw new Error("现在没有要回答的问题");
    job.answered = job.raw.length;
    job.write(yes ? "y\r" : "n\r");
    Object.assign(job, { state: "running", question: null });
    return this.view(job);
  }

  cancel(id: string): AddJob {
    const job = this.jobs.get(id);
    if (!job) throw Object.assign(new Error("没有这个添加任务"), { status: 404 });
    if (["downloading", "running", "question"].includes(job.state)) {
      job.state = "cancelled";
      job.abort.abort();
      job.kill();
    }
    return this.view(job);
  }

  stopAll(): void {
    for (const job of this.jobs.values()) this.cancel(job.id);
  }

  async settle(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]); }

  private view(job: AddJob): AddJob {
    return { id: job.id, target: job.target, state: job.state, question: job.question, output: job.output, code: job.code, reason: job.reason, download: job.download };
  }
}
