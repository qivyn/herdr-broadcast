import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../src/web/terminal.js", import.meta.url), "utf8");
function harness(focused = true, hidden = false) {
  let onData: (text: string) => void;
  const writes: { text: unknown; done?: () => void }[] = [];
  const sockets: Socket[] = [];
  const input: string[] = [];
  const timers = new Map<number, { fn: () => void; delay: number }>();
  let timerSeq = 0;
  let focuses = 0;
  let scrolls = 0;
  const events = new Map<string, (event?: any) => void>();
  const win = { addEventListener: (type: string, fn: () => void) => events.set(type, fn), removeEventListener: (type: string) => events.delete(type) };
  const activationBody = { addEventListener: (type: string, fn: () => void) => events.set(`body:${type}`, fn), removeEventListener: (type: string) => events.delete(`body:${type}`) };
  const host = { parentElement: activationBody, clientWidth: 640, clientHeight: 380,
    addEventListener: (type: string, fn: (event?: any) => void) => events.set(`terminal:${type}`, fn),
    removeEventListener: (type: string) => events.delete(`terminal:${type}`),
    contains: (target: unknown): boolean => target === host, scrollIntoView() { scrolls++; } };
  const doc = { hidden, focused, hasFocus(): boolean { return this.focused; }, addEventListener: (type: string, fn: () => void) => events.set(type === "visibilitychange" ? "visibility" : type, fn), removeEventListener: (type: string) => events.delete(type === "visibilitychange" ? "visibility" : type) };
  class Socket {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    sent: any[] = [];
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    constructor(readonly url: URL) { sockets.push(this); }
    send(text: string) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; this.onclose?.(); }
    output(text: string, seq = 1) { this.onmessage?.({ data: JSON.stringify({ type: "output", seq, data: Buffer.from(text).toString("base64") }) }); }
    takeover() { this.onmessage?.({ data: JSON.stringify({ type: "error", canTakeover: true, message: "taken over" }) }); this.close(); }
  }
  class Terminal {
    cols = 80; rows = 24; options = {};
    parser = { registerCsiHandler: () => ({ dispose() {} }) };
    loadAddon() {} open() {} focus() { focuses++; } dispose() {} hasSelection() { return false; }
    write(text: unknown, done?: () => void) { writes.push({ text, done }); }
    onData(fn: (text: string) => void) { onData = fn; return { dispose() {} }; }
    attachCustomKeyEventHandler() {}
  }
  const create = runInNewContext(script + "\ncreateBroadcastTerminal", {
    Terminal, FitAddon: { FitAddon: class { fit() {} } },
    UnicodeGraphemesAddon: { UnicodeGraphemesAddon: class {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    location: { href: "http://localhost:7318/", protocol: "http:" }, URL, WebSocket: Socket,
    document: doc, window: win, atob, queueMicrotask: (fn: () => void) => queueMicrotask(fn),
    setTimeout: (fn: () => void, delay: number) => { const id = ++timerSeq; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  let terminal: any;
  terminal = create(host, 1, (text: string) => { input.push(text); terminal.send(text); }, () => {}, 14);
  terminal.available("local:w1:p1"); terminal.visible(true);
  return { terminal, sockets, writes, input, doc, events, host, timers, runTimer() { const [id, timer] = [...timers][0]!; timers.delete(id); timer.fn(); }, get focuses() { return focuses; }, get scrolls() { return scrolls; }, type(text: string) { onData(text); }, paint() { writes.splice(0).forEach((w) => w.done?.()); } };
}

describe("browser terminal stream", () => {
  test("input waits for the first rendered frame, then streams every chunk without an HTTP response gate", () => {
    const h = harness();
    h.type("too early");
    expect(h.input).toEqual([]);
    h.sockets[0]!.output("中文🙂");
    expect(h.terminal.ready).toBe(false);
    h.paint();
    expect(h.terminal.ready).toBe(true);
    for (const text of ["a", "b", "中文", "\x1b[200~paste\x1b[201~", "\r"]) h.type(text);
    expect(h.sockets[0]!.sent.filter((m) => m.type === "input").map((m) => m.text)).toEqual(["a", "b", "中文", "\x1b[200~paste\x1b[201~", "\r"]);
    expect(h.sockets[0]!.sent[0]).toEqual({ type: "ack", seq: 1 });
  });

  test("a reconnect resets xterm, ignores old writes and never replays disconnected keystrokes", () => {
    const h = harness();
    const old = h.sockets[0]!;
    old.output("old frame");
    old.close();
    h.type("not sent");
    h.runTimer();
    h.paint();
    expect(h.terminal.ready).toBe(false);
    h.sockets[1]!.output("fresh frame");
    expect(h.writes[0]!.text).toBe("\x1bc");
    h.paint();
    expect(h.terminal.ready).toBe(true);
    expect(h.sockets[1]!.sent.some((m) => m.type === "input")).toBe(false);
  });

  test("a long paste goes in pieces a server message can take, without cutting a character", () => {
    const h = harness();
    h.sockets[0]!.output("ready"); h.paint();
    h.terminal.agent(false);
    const paste = `${"x".repeat(8191)}🙂${"中".repeat(20_000)}`;
    h.type(paste);
    const pieces = h.sockets[0]!.sent.filter((m) => m.type === "input").map((m) => m.text as string);
    expect(pieces.length).toBeGreaterThan(2);
    expect(pieces.join("")).toBe(paste);
    expect(pieces[0]!.endsWith("x")).toBe(true);
    for (const piece of pieces) expect(Buffer.byteLength(JSON.stringify({ type: "input", text: piece }))).toBeLessThan(64 * 1024);
  });

  test("a multi-line paste into an agent goes as bracketed paste, so a newline never submits it early", async () => {
    const h = harness();
    h.sockets[0]!.output("ready"); h.paint();
    const inputs = () => h.sockets[0]!.sent.filter((m) => m.type === "input").map((m) => m.text as string);
    const settle = () => new Promise((resolve) => queueMicrotask(() => resolve(null)));
    // xterm without the program's mode sends a paste as lines ending in CR
    h.events.get("terminal:paste")!(); h.type("line one\rline two\rline three");
    await settle();
    expect(inputs()).toEqual(["\x1b[200~line one\rline two\rline three\x1b[201~"]);
    // a long one stays bracketed in every piece: none of its CRs can reach the agent as Enter
    h.events.get("terminal:paste")!(); h.type(`${"a".repeat(9000)}\r${"b".repeat(9000)}`);
    await settle();
    const long = inputs().slice(1);
    expect(long.length).toBeGreaterThan(1);
    for (const piece of long) expect(piece.startsWith("\x1b[200~") && piece.endsWith("\x1b[201~")).toBe(true);
    expect(long.map((p) => p.slice(6, -6)).join("")).toBe(`${"a".repeat(9000)}\r${"b".repeat(9000)}`);
    // typing is not a paste, and xterm's own bracketed paste is kept whole, not wrapped twice
    h.type("x\r"); h.type("\x1b[200~already\x1b[201~");
    expect(inputs().slice(-2)).toEqual(["x\r", "\x1b[200~already\x1b[201~"]);
    // a bare shell takes a paste as lines, as a terminal gives it
    h.terminal.agent(false);
    h.events.get("terminal:paste")!(); h.type("echo 1\recho 2");
    await settle();
    expect(inputs().at(-1)).toBe("echo 1\recho 2");
  });

  test("a paste still waiting on a busy socket is dropped on disconnect, never replayed", () => {
    const h = harness();
    h.sockets[0]!.output("ready"); h.paint();
    h.sockets[0]!.bufferedAmount = 40 * 1024;
    h.type("y".repeat(20_000));
    expect(h.sockets[0]!.sent.filter((m) => m.type === "input")).toEqual([]);
    h.sockets[0]!.close(); h.runTimer(); h.sockets[1]!.output("again"); h.paint();
    for (const [, timer] of [...h.timers]) timer.fn();
    expect(h.sockets[1]!.sent.filter((m) => m.type === "input")).toEqual([]);
  });

  test("explicitly pinned terminals remain connected while offscreen", () => {
    const h = harness();
    h.terminal.pinned(true);
    h.terminal.visible(false);
    expect(h.sockets[0]!.readyState).toBe(1);
    h.terminal.pinned(false);
    expect(h.sockets[0]!.readyState).toBe(3);
  });

  test("hidden panels and disposed views release their connections", () => {
    const h = harness();
    h.terminal.visible(false);
    expect(h.sockets[0]!.readyState).toBe(3);
    h.terminal.visible(true);
    expect(h.sockets.length).toBe(2);
    h.terminal.dispose();
    h.terminal.visible(true);
    expect(h.sockets.length).toBe(2);
    expect(h.sockets[1]!.readyState).toBe(3);
  });
});


test("foreground entry takes over once; ownership loss and retries never fight back", () => {
  const h = harness();
  expect(h.sockets[0]!.url.searchParams.get("takeover")).toBe("1");
  h.sockets[0]!.output("ready"); h.paint();
  h.sockets[0]!.takeover();
  h.terminal.ensureConnected(); h.terminal.visible(true);
  h.type("not sent");
  expect(h.input).toEqual([]); expect(h.sockets).toHaveLength(1); expect(h.timers.size).toBe(0);
  expect(h.terminal.handedOff).toBe(true); expect(h.terminal.hasScreen).toBe(true);
  h.events.get("terminal:pointerdown")!();
  expect(h.sockets[1]!.url.searchParams.get("takeover")).toBe("1");
  h.sockets[1]!.close(); h.runTimer();
  expect(h.sockets[2]!.url.searchParams.has("takeover")).toBe(false);
});

test("an external takeover releases control until returning to this page", () => {
  const h = harness();
  h.sockets[0]!.takeover();
  expect(h.sockets[0]!.readyState).toBe(3);
  h.terminal.visible(true); h.terminal.pinned(true);
  expect(h.sockets.length).toBe(1);
  h.events.get("focus")!();
  expect(h.sockets.length).toBe(2);
  expect(h.sockets[1]!.url.searchParams.get("takeover")).toBe("1");
  h.terminal.dispose();
  expect(h.events.has("focus")).toBe(false);
  expect(h.events.has("terminal:pointerdown")).toBe(false);
});


test("an explicitly opened terminal receives focus once its first screen is rendered", () => {
  const h = harness();
  h.terminal.focusWhenReady();
  expect(h.focuses).toBe(0);
  h.sockets[0]!.output("Choose a session");
  expect(h.focuses).toBe(0);
  h.paint();
  expect(h.focuses).toBe(1);
  expect(h.scrolls).toBe(1);
  h.sockets[0]!.output("Next frame", 2); h.paint();
  h.terminal.ensureConnected();
  expect(h.sockets.length).toBe(1);
  expect(h.focuses).toBe(1);
  h.type("\x1b[B\r");
  expect(h.input).toEqual(["\x1b[B\r"]);
});

test("a newer task keeps the socket and uses its execution on the next reconnect", () => {
  const h = harness();
  h.sockets[0]!.output("ready"); h.paint();
  h.terminal.execution(9);
  expect(h.sockets).toHaveLength(1);
  expect(h.sockets[0]!.readyState).toBe(1);
  expect(h.terminal.ready).toBe(true);
  h.sockets[0]!.close(); h.runTimer();
  expect(h.sockets[1]!.url.pathname).toBe("/api/executions/9/terminal");
});

test("normal connections do not steal focus, and another user action cancels pending focus", () => {
  for (const action of ["pointerdown", "focusin", "hidden", "cancel", "dispose"]) {
    const h = harness();
    h.terminal.focusWhenReady();
    if (action === "hidden") { h.doc.hidden = true; h.events.get("visibility")!(); }
    else if (action === "cancel") h.terminal.cancelFocus();
    else if (action === "dispose") h.terminal.dispose();
    else h.events.get(action)!({ target: {} });
    h.sockets[0]!.output("late screen"); h.paint();
    expect(h.focuses).toBe(0);
  }
  const h = harness();
  h.sockets[0]!.output("ordinary background connection"); h.paint();
  expect(h.focuses).toBe(0);
  h.terminal.focusWhenReady();
  expect(h.focuses).toBe(1);
  h.terminal.dispose();
  expect(h.events.has("pointerdown")).toBe(false);
  expect(h.events.has("focusin")).toBe(false);
});

const pageScript = readFileSync(new URL("../src/web/page.js", import.meta.url), "utf8");

for (const session of [
  { session_kind: "id", session_value: "B" },
  { session_kind: "path", session_value: "A" },
  { session_kind: null, session_value: null },
]) {
  test(`target rows refresh identity callbacks (${session.session_kind}:${session.session_value}) without silently rebinding checked targets`, () => {
    const setup = pageScript.slice(pageScript.indexOf("  const targetIdentities ="), pageScript.indexOf("  compose.picked.clear()"));
    const render = pageScript.slice(pageScript.indexOf("  function renderTargets()"), pageScript.indexOf("  function rowText("));
    const elements: any[] = [];
    const a = { pane_id: "w1:p1", terminal_id: "t1", workspace: "Project", name: "same", kind: "claude", cwd: "/src", title: "same", ready: true, session_kind: "id" as string | null, session_value: "A" as string | null };
    const compose = { picked: new Set<string>() };
    const data = { agents: [{ machine: { id: "local", label: "Local" }, loading: false, agents: [a] }] };
    const host = { replaceChildren() { elements.length = 0; }, append() {} };
    const ui = runInNewContext(`(function(){let targetsShape='';let filterRows=[];${setup}\n${render}\nreturn {renderTargets,identities:targetIdentities};})()`, {
      compose, data, loaded: true, targets: host, filter: { value: "" }, statusOf: () => ["ok", "idle"],
      key: (m: string, p: string) => `${m}\0${p}`, statusCells: new Map(), byWorkspace: (agents: any[]) => [["Project", agents]],
      applyFilter() {}, syncChecks() {}, updateComposer() {}, rowText: () => "", baseName: (s: string) => s, toast() {},
      h: (tag: string, attrs: any, ...children: any[]) => {
        const el = { tag, attrs: attrs || {}, children, append() {}, classList: { add() {} } }; elements.push(el); return el;
      },
    });
    const check = () => elements.find(e => e.tag === "input" && e.attrs.type === "checkbox");
    const chosen = () => ui.identities.get("local\0w1:p1");
    ui.renderTargets(); check().attrs.onchange({ target: { checked: true } });
    expect(chosen().session_value).toBe("A");
    data.agents[0]!.agents = [{ ...a, ...session }]; ui.renderTargets();
    expect(chosen().session_value).toBe("A"); // refreshing alone cannot replace the user's selection
    check().attrs.onchange({ target: { checked: false } });
    check().attrs.onchange({ target: { checked: true } });
    expect(chosen()).toMatchObject(session);
    // Bulk selection must also capture the new identity after a report appears again.
    data.agents[0]!.agents = [{ ...a, session_value: "C" }]; ui.renderTargets(); compose.picked.clear();
    const idle = elements.find(e => e.tag === "button" && e.children.includes("选中空闲的"));
    idle.attrs.onclick();
    expect(chosen().session_value).toBe("C");
  });
}

function pageFunction(name: string, end: string, globals: object = {}) {
  const start = pageScript.indexOf(`  function ${name}(`);
  return runInNewContext(pageScript.slice(start, pageScript.indexOf(end, start)) + `\n${name}`, globals);
}

/** Execute the real composer's selection, refresh and submission code at its API boundary. */
function composerHarness(post: (path: string, body: any) => Promise<any>) {
  const source = pageScript.slice(pageScript.indexOf("function newView(main)"), pageScript.indexOf("// ---- settings:"));
  const setup = source.slice(source.indexOf("  let submitting"), source.indexOf("  compose.picked.clear()"));
  const update = source.slice(source.indexOf("  function updateComposer()"), source.indexOf("  function refresh()"));
  const submit = source.slice(source.indexOf("  async function submit()"), source.lastIndexOf("\n  refresh();"));
  const finish = source.slice(source.lastIndexOf("\n  refresh();"), source.lastIndexOf("}"));
  const storage = new Map<string, string>([["draft", JSON.stringify({ title: "", prompt: "original instruction" })]]);
  const sent: any[] = [], navigation: string[] = [], notices: string[] = [];
  const prompt = { value: "original instruction", disabled: false }, title = { value: "", disabled: false }, send = { disabled: false, title: "" };
  const compose = { picked: new Set<string>(), newPicks: new Map(), freshCount: () => 0, total: () => compose.picked.size };
  const globals = {
    compose, prompt, title, send, DRAFT_KEY: "draft", stranded: () => 0, renderChips() {},
    tabs: Object.fromEntries(["new", "existing"].map(k => [k, { querySelector: () => ({ textContent: "", hidden: false }) }])),
    hint: { textContent: "", classList: { toggle() {} } },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, removeItem: (k: string) => storage.delete(k) },
    post: (path: string, body: any) => { sent.push({ path, body }); return post(path, body); },
    toast: (message: string) => notices.push(message), go: (hash: string) => navigation.push(hash),
  };
  const view = runInNewContext(`(function () { ${setup}\n${update}\n${submit}\nfunction refresh() { updateComposer(); }\n${finish.replace("update: refresh", "pickTarget, submit, update: refresh")} })()`, globals);
  view.pickTarget("local", { pane_id: "w1:p1", terminal_id: "terminal-original", kind: "claude", session_kind: "id", session_value: "original-session" });
  return { view, storage, sent, navigation, notices, prompt, title, send };
}

test("new broadcast submissions stay exclusive across Enter presses and state refreshes", async () => {
  let resolve!: (value: any) => void;
  const h = composerHarness(() => new Promise(r => { resolve = r; }));
  const first = h.view.submit();
  h.view.update();
  expect(h.send.disabled).toBe(true);
  expect(h.prompt.disabled).toBe(true);
  await h.view.submit();
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].body.targets).toEqual([{ machine: "local", pane: "w1:p1", terminal_id: "terminal-original", agent_kind: "claude", session_kind: "id", session_value: "original-session" }]);
  resolve({ id: 3, executions: 1 }); await first;
  expect(h.navigation).toEqual(["#/b/3"]);
  expect(h.storage.has("draft")).toBe(false);
  h.view.dispose();
});

test("a failed new submission releases its guard and retains the draft for a deliberate retry", async () => {
  let calls = 0;
  const h = composerHarness(async () => { if (++calls === 1) throw new Error("unavailable"); return { id: 4, executions: 1 }; });
  await h.view.submit();
  expect(h.storage.has("draft")).toBe(true);
  expect(h.send.disabled).toBe(false);
  expect(h.prompt.disabled).toBe(false);
  await h.view.submit();
  expect(h.sent).toHaveLength(2); expect(h.navigation).toEqual(["#/b/4"]);
  h.view.dispose();
});

for (const leave of [false, true]) {
  test(`an old new-broadcast response preserves a newer draft${leave ? " after leaving the page" : " in another window"}`, async () => {
    let resolve!: (value: any) => void;
    const h = composerHarness(() => new Promise(r => { resolve = r; }));
    const first = h.view.submit();
    if (leave) h.view.dispose();
    h.storage.set("draft", "a newer draft");
    resolve({ id: 5, executions: 1 }); await first;
    expect(h.storage.get("draft")).toBe("a newer draft");
    expect(h.navigation).toEqual(leave ? [] : ["#/b/5"]);
    if (!leave) h.view.dispose();
  });
}

test("terminal keystrokes never broadcast to other checked cards", () => {
  const received: [number, string][] = [];
  const panels = new Map([1, 2].map(id => [id, { terminal: { send(text: string) { received.push([id, text]); return true; } } }]));
  const send = pageFunction("sendTerminalInput", "  async function refreshConversation", { panels, picked: new Set([1, 2]), toast() {} });
  send(1, "hello\r");
  expect(received).toEqual([[1, "hello\r"]]);
});

test("round selection shows only that round, defaults to latest and follows execution deep links", () => {
  const start = pageScript.indexOf("function broadcastRound(");
  const end = pageScript.indexOf("/**\n * `id`:", start);
  const scope = runInNewContext(pageScript.slice(start, end) + "\nbroadcastRound");
  const b = { id: 7, title: "same broadcast", prompt: "first", executions: [
    { id: 10, round_id: 1 }, { id: 11, round_id: 1 }, { id: 12, round_id: 2 },
  ], rounds: [
    { id: 1, number: 1, prompt: "first", total: 2, counts: { completed: 2 }, created_at: 100 },
    { id: 2, number: 2, prompt: "second", total: 1, counts: { queued: 1 }, created_at: 200 },
  ] };
  expect(scope(b, null)).toMatchObject({ id: 7, prompt: "second", total: 1, counts: { queued: 1 }, executions: [{ id: 12, round_id: 2 }] });
  expect(scope(b, 1)).toMatchObject({ id: 7, prompt: "first", total: 2, executions: [{ id: 10, round_id: 1 }, { id: 11, round_id: 1 }] });
  expect(scope(b, null, 11).round.id).toBe(1);
  expect(scope(b, 2, 11).round.id).toBe(2);
  expect(scope(b, 999).round.id).toBe(2);
  expect(b.executions).toHaveLength(3);
});

// A small DOM stand-in runs the actual detail-view lifecycle without a browser or real terminals.
function detailHarness(options: { active?: boolean; setup?: (b: any) => void; post?: (path: string, body: any) => Promise<any>; api?: (path: string) => Promise<any>;
  /** opened as #/e/<id>, before the state has arrived */
  deepLink?: number } = {}) {
  class Element {
    children: Element[] = []; parent?: Element; className = ""; text = ""; value = "";
    checked = false; disabled = false; hidden = false; open = false; attrs: Record<string, any> = {};
    dataset: Record<string, any> = {}; events: Record<string, Function> = {};
    style = { setProperty() {} }; scrollHeight = 10; clientHeight = 10;
    classList = {
      contains: (name: string) => this.className.split(" ").includes(name),
      add: (name: string) => this.classList.toggle(name, true),
      remove: (name: string) => this.classList.toggle(name, false),
      toggle: (name: string, force = !this.classList.contains(name)) => {
        const names = new Set(this.className.split(" ").filter(Boolean));
        force ? names.add(name) : names.delete(name); this.className = [...names].join(" "); return force;
      },
    };
    constructor(readonly tag: string) {}
    get textContent(): string { return this.text + this.children.map(c => c.textContent).join(""); }
    set textContent(value: string) { this.text = value; this.children = []; }
    append(...children: any[]) { for (const c of children.flat()) { const child = c instanceof Element ? c : Object.assign(new Element("text"), { text: String(c) }); child.remove(); child.parent = this; this.children.push(child); } }
    prepend(child: Element) { child.parent = this; this.children.unshift(child); }
    replaceChildren(...children: any[]) { this.text = ""; this.children = []; this.append(...children); }
    contains(child: Element): boolean { return this === child || this.children.some(c => c.contains(child)); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
    setAttribute(k: string, v: any) { this.attrs[k] = v; if (k.startsWith("data-")) this.dataset[k.slice(5)] = v; }
    addEventListener(k: string, fn: Function) { this.events[k] = fn; }
    showModal() { this.attrs.open = true; }
    close() { if (this.attrs.open) { this.attrs.open = false; this.events.close?.(); } }
    focus() {} scrollIntoView() {} querySelectorAll() { return []; }
  }
  const h = (tag: string, attrs: any, ...children: any[]) => {
    const el = new Element(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = String(v);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v as Function);
      else { el.setAttribute(k, v); if (k in el) (el as any)[k] = v; }
    }
    el.append(...children.flat().filter(c => c != null && c !== false)); return el;
  };
  const all = (el: Element): Element[] => [el, ...el.children.flatMap(all)];
  const one = (cls: string) => all(main).find(e => e.classList.contains(cls))!;
  const entries = () => all(main).filter(e => e.classList.contains("round-option"));
  const round = (id: number, prompt: string) => ({ id, number: id, prompt, total: 1, counts: { completed: 1 }, created_at: 100 * id });
  const execution = (id: number): any => ({ id, round_id: id, state: "completed", pane_id: "w1:p1", terminal_id: "t1", machine_id: "local", machine_label: "Local", agent_kind: "pi", agent_name: "pi-one", terminal_state: "live", can_follow_up: true, can_rename: true });
  const b = { id: 7, title: "A single broadcast", prompt: "first", rounds: [round(1, "first"), round(2, "second")], executions: [execution(1), execution(2)] };
  options.setup?.(b);
  const data = { state: { broadcasts: [b] }, webUi: { running: false }, agents: [] };
  const operations: string[] = []; const requests: any[] = [];
  const main = new Element("main");
  const navigation: string[] = [], stored = new Map<string, string>();
  const terminals = new Map<number, any>();
  const timers = new Map<number, { fn: () => void; due: number }>();
  let now = 0, timerSeq = 0, arrived = options.deepLink === undefined;
  const globals = {
    h, data, loaded: true, config: { local: false }, SUMMARY: [], AGENT_STATUS: { working: "工作中", idle: "空闲", blocked: "等待确认" }, SHOWN: ["live", "restoring", "starting", "shell"], screenFont: { size: 14, normal: 14 }, GROW_ICON: "", SHRINK_ICON: "",
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    Date: { now: () => now },
    setInterval() {}, clearInterval() {},
    setTimeout(fn: () => void, ms: number) { const id = ++timerSeq; timers.set(id, { fn, due: now + ms }); return id; },
    clearTimeout(id: number) { timers.delete(id); }, matchMedia: () => ({ matches: true }),
    topbar: (...children: any[]) => h("div", {}, ...children),
    findBroadcast: (id: number | null) => (arrived && id === b.id ? b : null),
    findExec: (id: number) => (arrived ? { b, e: b.executions.find(e => e.id === id) } : null),
    machineDown: () => false, tone: () => "ok", label: (s: string) => s, ago: () => "刚刚", duration: () => "", baseName: (s: string) => s,
    confirmButton: (text: string, _confirm: string, act: () => Promise<void>) => h("button", { onclick: act }, text),
    PREFILL_KEY: "broadcast.prefill",
    sessionStorage: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
    renderSidebar() {}, toast() {},
    go(path: string) { navigation.push(path); },
    createBroadcastTerminal: (_host: any, id: number, _input: any, onReady: (ready: boolean) => void) => {
      operations.push(`open:${id}`);
      const terminal = { active: options.active ?? false, hasScreen: false, handedOff: false, activates: 0, pins: [] as boolean[], executionId: id, execution(value: number) { this.executionId = value; }, agent() {}, font() {}, available(key: string | null) { if (this.availableKey !== key) this.hasScreen = false; this.availableKey = key; }, availableKey: null as string | null, visible() {},
        activate() { this.activates++; }, pinned(value: boolean) { this.pins.push(value); }, focusWhenReady() {},
        emitReady(value: boolean) { if (value) this.hasScreen = true; onReady(value); }, dispose() { operations.push(`dispose:${id}`); } };
      terminals.set(id, terminal); return terminal;
    },
    post: async (path: string, body: any) => {
      requests.push({ path, body });
      if (options.post) return options.post(path, body);
      const next = Math.max(...b.rounds.map(r => r.id)) + 1;
      b.rounds.push(round(next, body.prompt)); b.executions.push(execution(next));
      return { id: 7, round_id: next, round_number: next, executions: 1 };
    },
    api: async (path: string) => options.api ? options.api(path) : data,
  };
  const start = pageScript.indexOf("function connectionPresentation(");
  const end = pageScript.indexOf("// ---- wiring", start);
  const create = runInNewContext(pageScript.slice(start, end) + "\nbroadcastView", globals);
  const view = options.deepLink === undefined ? create(main, 7, null) : create(main, null, options.deepLink);
  return { main, b, data, requests, operations, terminals, navigation, stored, one, all, entries, view, timers,
    arrive() { arrived = true; view.update(); },
    advance(ms: number) { now += ms; for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); } } };
}

test("delivery and live agent status are separate; queue cancellation is absent", () => {
  const h = detailHarness({ setup(b) { b.executions[0].state = "sent"; b.executions[1].state = "sent"; b.executions[1].agent_status = "working"; } });
  try {
    const state = h.one("state");
    expect(state.textContent).toContain("sent");
    expect(state.textContent).toContain("Agent 工作中");
    expect(h.all(h.main).some(el => el.textContent.startsWith("取消排队中的"))).toBe(false);
    const interrupt = () => h.all(h.main).some(el => el.tag === "button" && el.textContent === "中断 agent");
    expect(interrupt()).toBe(true);
    h.b.executions[1].agent_status = "idle"; h.view.update(); expect(interrupt()).toBe(false);
    h.b.executions[1].agent_status = "blocked"; h.view.update(); expect(interrupt()).toBe(true);
    expect(h.one("state").textContent).toContain("Agent 等待确认");
  } finally { h.view.dispose(); }
});

test("startup confirmation explains automatic sending and can cancel only its pending send", async () => {
  const h = detailHarness({ setup: b => Object.assign(b.executions[1], {
    state: "starting", terminal_state: "starting", agent_status: "blocked", needs_start_confirmation: true, can_cancel_start: false,
  }), post: async () => { Object.assign(h.b.executions[1], { state: "cancelled", can_cancel_start: false, needs_start_confirmation: false, terminal_state: "live" }); return { ok: true }; } });
  const cancel = () => h.all(h.main).find(e => e.tag === "button" && e.textContent === "取消本次发送");
  expect(h.one("terminal-status").textContent).toContain("等待启动确认，完成后自动发送");
  expect(cancel()).toBeUndefined();
  h.b.executions[1].can_cancel_start = true; h.view.update();
  await cancel()!.events.click!();
  expect(h.requests).toEqual([{ path: "/api/executions/2/cancel", body: undefined }]);
  expect(cancel()).toBeUndefined(); expect(h.b.rounds).toHaveLength(2);
  h.view.dispose();
});

test("round inputs and follow-ups reuse the live terminal, preserve selection and send against the latest task", async () => {
  const { main, b, data, requests, operations, terminals, one, all, entries, view } = detailHarness();
  const host = one("terminal-host");
  expect(one("round-prompt").textContent).toBe("second");
  expect(one("round-instruction").open).toBe(false);
  one("round-instruction").open = true;
  view.update();
  expect(one("round-instruction").open).toBe(true);
  expect(operations).toEqual(["open:2"]);
  const checkbox = one("pick");
  checkbox.checked = true; checkbox.events.change!();
  entries()[0]!.events.click!();
  expect(one("round-instruction").open).toBe(true);
  expect(one("round-prompt").textContent).toBe("first");
  expect(one("terminal-host")).toBe(host);
  expect(checkbox.checked).toBe(true);
  expect(operations).toEqual(["open:2"]);
  view.update();
  expect(one("round-prompt").textContent).toBe("first");
  expect(operations).toHaveLength(1);
  // A temporary unavailable state cannot disable or silently clear a user's selection.
  b.executions[1]!.can_follow_up = false;
  b.executions[1]!.terminal_state = "unreachable";
  view.update();
  expect(checkbox.disabled).toBe(false);
  checkbox.checked = true; checkbox.events.change!();
  expect(all(main).some(e => e.classList.contains("followup-blocked"))).toBe(false);
  expect(one("terminal-status").children[0]!.textContent).toBe("正在连接…");
  const blockedInput = all(main).find(e => e.tag === "textarea")!;
  blockedInput.value = "do not send yet";
  one("followup-composer").events.submit!({ preventDefault() {} });
  await Bun.sleep(0);
  expect(requests).toHaveLength(0);
  view.update();
  expect(checkbox.checked).toBe(true);
  b.executions[1]!.can_follow_up = true;
  b.executions[1]!.terminal_state = "live";
  view.update();
  expect(checkbox.checked).toBe(true);
  expect(all(main).some(e => e.classList.contains("followup-blocked"))).toBe(false);
  const input = all(main).find(e => e.tag === "textarea")!;
  input.value = "third instruction"; input.events.input!();
  one("followup-composer").events.submit!({ preventDefault() {} });
  await Bun.sleep(0);
  expect(requests).toEqual([{ path: "/api/broadcasts/7/follow-up", body: { prompt: "third instruction", targets: [{ execution_id: 2, terminal_id: "t1" }] } }]);
  expect(data.state.broadcasts).toHaveLength(1);
  expect(one("round-prompt").textContent).toBe("third instruction");
  expect(one("pick").checked).toBe(true);
  expect(one("followup-result").textContent).toContain("第 3 轮");
  expect(one("terminal-host")).toBe(host);
  expect(operations).toEqual(["open:2"]);
  expect(terminals.get(2)!.executionId).toBe(3);
  checkbox.checked = false; checkbox.events.change!();
  expect(one("followup-count").textContent).toBe("未选择 agent");
  checkbox.checked = true; checkbox.events.change!();
  input.value = "another task"; input.events.input!();
  one("followup-composer").events.submit!({ preventDefault() {} });
  await Bun.sleep(0);
  expect(requests.at(-1)!.body.targets).toEqual([{ execution_id: 3, terminal_id: "t1" }]);
  view.dispose();
  expect(operations.at(-1)).toBe("dispose:2");
});

test("a disposed follow-up request cannot clear the reopened broadcast's draft", async () => {
  let resolve!: (value: any) => void;
  const h = detailHarness({ post: () => new Promise(r => { resolve = r; }) });
  const checkbox = h.one("pick"); checkbox.checked = true; checkbox.events.change!();
  const input = h.all(h.main).find(e => e.tag === "textarea")!;
  input.value = "old follow-up"; input.events.input!();
  h.one("followup-composer").events.submit!({ preventDefault() {} });
  h.view.dispose();
  h.stored.set("broadcast.followup.7", "new follow-up after reopening");
  resolve({ id: 7, round_id: 3, round_number: 3, executions: 1 });
  await Bun.sleep(0);
  expect(h.stored.get("broadcast.followup.7")).toBe("new follow-up after reopening");
});

test("a broadcast opened from an agent's link keeps its own follow-up draft once the state arrives", () => {
  const h = detailHarness({ deepLink: 2 });
  h.stored.set("broadcast.followup.7", "this broadcast's draft");
  h.arrive();
  const input = h.all(h.main).find(e => e.tag === "textarea")!;
  expect(input.value).toBe("this broadcast's draft");
  input.value = "edited"; input.events.input!();
  expect(h.stored.get("broadcast.followup.7")).toBe("edited");
  expect([...h.stored.keys()].some(k => k.endsWith(".null"))).toBe(false);
  h.view.dispose();
});

test("input-only rounds retain all participating conversations, including agents absent from the latest round", () => {
  for (const other of [{ machine_id: "remote" }, { terminal_id: "t2" }]) {
    const h = detailHarness({ setup: b => {
      // A shared history or a terminal ID reused on another machine must not merge agents.
      for (const e of b.executions) e.session_value = "same-history";
      Object.assign(b.executions[1], other);
    } });
    const hosts = h.all(h.main).filter(e => e.classList.contains("terminal-host"));
    expect(h.operations).toEqual(["open:1", "open:2"]);
    const pick = h.one("pick"); pick.checked = true; pick.events.change!();
    h.entries()[0]!.events.click!();
    expect(h.one("round-prompt").textContent).toBe("first");
    expect(h.all(h.main).filter(e => e.classList.contains("terminal-host"))).toEqual(hosts);
    expect(pick.checked).toBe(true);
    expect(h.operations).toEqual(["open:1", "open:2"]);
    h.entries()[1]!.events.click!();
    expect(h.operations).toEqual(["open:1", "open:2"]);
    h.view.dispose();
  }
});

test("ordinary terminal drops reconnect automatically with backoff and never replay input or take over", () => {
  const h = harness(); h.sockets[0]!.output("live"); h.paint();
  h.sockets[0]!.close(); h.type("discarded");
  expect(h.timers.size).toBe(1);
  expect([...h.timers.values()][0]!.delay).toBe(500);
  h.terminal.available("local:w1:p1");
  h.runTimer();
  expect(h.sockets).toHaveLength(2);
  expect(h.sockets[1]!.url.searchParams.has("takeover")).toBe(false);
  h.sockets[1]!.close(); expect([...h.timers.values()][0]!.delay).toBe(1000);
  h.runTimer(); h.sockets[2]!.output("restored"); h.paint();
  expect(h.terminal.ready).toBe(true);
  expect(h.sockets[2]!.sent.filter(m => m.type === "input")).toEqual([]);
  h.sockets[2]!.close(); expect([...h.timers.values()][0]!.delay).toBe(500);
});

test("backgrounding, offscreen cards, unavailable targets and disposal cancel automatic retries", () => {
  for (const change of ["hidden", "blur", "offscreen", "unavailable", "dispose"]) {
    const h = harness(); h.sockets[0]!.close(); expect(h.timers.size).toBe(1);
    if (change === "hidden") { h.doc.hidden = true; h.events.get("visibility")!(); }
    else if (change === "offscreen") h.terminal.visible(false);
    else if (change === "blur") { h.doc.focused = false; h.events.get("blur")!(); }
    else if (change === "unavailable") h.terminal.available(null);
    else h.terminal.dispose();
    expect(h.timers.size).toBe(0); expect(h.sockets).toHaveLength(1);
  }
});

test("connection errors automatically recover without requiring a reconnect click", () => {
  const h = harness();
  (h.sockets[0] as any).onerror();
  expect(h.timers.size).toBe(1);
  h.runTimer(); expect(h.sockets).toHaveLength(2);
  h.sockets[1]!.output("ready"); h.paint(); expect(h.terminal.ready).toBe(true);
});

test("confirmed actions cannot submit again while the first request is pending", async () => {
  const start = pageScript.indexOf("function confirmButton(");
  const end = pageScript.indexOf("function webUiBase(", start);
  const events = new Map<string, () => Promise<void>>();
  const button = { disabled: false, textContent: "send", classList: { add() {}, remove() {} }, addEventListener: (key: string, fn: () => Promise<void>) => events.set(key, fn) };
  let release!: () => void, calls = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const create = runInNewContext(pageScript.slice(start, end) + "\nconfirmButton", { h: () => button, setTimeout: () => 1, clearTimeout() {}, toast() {} });
  create("send", "confirm", async () => { calls++; await pending; }, {});
  await events.get("click")!();
  const request = events.get("click")!();
  await events.get("click")!();
  expect(calls).toBe(1); expect(button.disabled).toBe(true);
  release(); await request; expect(button.disabled).toBe(false);
});

test("background windows keep an existing controller but never start a new attachment", () => {
  const h = harness(false);
  h.terminal.pinned(true); h.terminal.visible(true); h.terminal.ensureConnected();
  expect(h.sockets).toHaveLength(0);
  h.doc.focused = true; h.events.get("focus")!();
  expect(h.sockets).toHaveLength(1); expect(h.sockets[0]!.url.searchParams.get("takeover")).toBe("1");
  h.sockets[0]!.output("live"); h.paint();
  h.doc.focused = false; h.events.get("blur")!();
  expect(h.sockets[0]!.readyState).toBe(1); expect(h.timers.size).toBe(0);
  h.terminal.ensureConnected(); h.terminal.visible(true); h.events.get("terminal:pointerdown")!();
  expect(h.sockets).toHaveLength(1);
  h.doc.focused = true; h.events.get("focus")!(); h.events.get("focus")!();
  expect(h.sockets).toHaveLength(1); expect(h.terminal.ready).toBe(true);
});

for (const action of ["blur", "hidden"]) test(`${action} keeps rendering output, drops pending input and returns without reconnecting`, () => {
  const h = harness();
  const socket = h.sockets[0]!;
  socket.output("initial screen"); h.paint();
  socket.bufferedAmount = 40 * 1024;
  h.type("pending paste"); expect(h.timers.size).toBe(1);
  h.doc.focused = false;
  if (action === "hidden") { h.doc.hidden = true; h.events.get("visibility")!(); }
  else h.events.get("blur")!();
  expect(socket.readyState).toBe(1); expect(h.terminal.ready).toBe(true); expect(h.timers.size).toBe(0);
  h.type("background input"); expect(h.terminal.send("background send")).toBe(false);
  socket.bufferedAmount = 0;
  socket.output("output while away", 2);
  expect(h.writes.some(w => ArrayBuffer.isView(w.text) && Buffer.from(w.text as Uint8Array).toString() === "output while away")).toBe(true);
  h.paint();
  expect(socket.sent).toContainEqual({ type: "ack", seq: 2 });
  h.doc.hidden = false; h.doc.focused = true;
  h.events.get("visibility")!(); h.events.get("focus")!();
  expect(h.sockets).toHaveLength(1); expect(h.terminal.hasScreen).toBe(true);
  expect(socket.sent.filter(m => m.type === "input")).toEqual([]);
  h.type("foreground input");
  expect(socket.sent.filter(m => m.type === "input")).toEqual([{ type: "input", text: "foreground input" }]);
});

test("retained screens survive disconnects but cannot appear under a replacement terminal", () => {
  const h = harness();
  expect(h.terminal.hasScreen).toBe(false);
  h.sockets[0]!.output("original"); h.paint();
  h.sockets[0]!.close(); expect(h.terminal.hasScreen).toBe(true);
  h.terminal.available("local:replacement");
  expect(h.terminal.hasScreen).toBe(false);
  h.sockets[1]!.output("replacement"); h.paint();
  expect(h.terminal.hasScreen).toBe(true);
});

test("returning from a hidden tab after takeover grants one attempt despite duplicate activation events", () => {
  const h = harness();
  h.sockets[0]!.output("live"); h.paint();
  h.doc.hidden = true; h.doc.focused = false; h.events.get("visibility")!();
  expect(h.sockets[0]!.readyState).toBe(1);
  h.sockets[0]!.takeover();
  expect(h.timers.size).toBe(0);
  h.doc.hidden = false; h.events.get("visibility")!();
  expect(h.sockets).toHaveLength(1);
  h.doc.focused = true; h.events.get("focus")!(); h.events.get("visibility")!();
  expect(h.sockets).toHaveLength(2); expect(h.sockets[1]!.url.searchParams.get("takeover")).toBe("1");
  h.sockets[1]!.close(); h.runTimer();
  expect(h.sockets[2]!.url.searchParams.has("takeover")).toBe(false);
});

test("offscreen recovery and ordinary state updates cannot renew a takeover grant", () => {
  const h = harness(); h.sockets[0]!.output("live"); h.paint();
  h.terminal.visible(false); h.terminal.visible(true);
  expect(h.sockets[1]!.url.searchParams.has("takeover")).toBe(false);
  h.terminal.available("local:w1:p1"); h.terminal.ensureConnected();
  expect(h.sockets).toHaveLength(2);
});

test("switching between pages never makes the page that lost focus fight for control", () => {
  const first = harness(), second = harness(false);
  first.sockets[0]!.output("first"); first.paint();
  first.doc.focused = false; first.events.get("blur")!();
  second.doc.focused = true; second.events.get("focus")!();
  expect(first.sockets[0]!.readyState).toBe(1);
  first.sockets[0]!.takeover();
  expect(first.timers.size).toBe(0); expect(second.sockets[0]!.url.searchParams.get("takeover")).toBe("1");
  second.sockets[0]!.output("second"); second.paint();
  first.terminal.visible(true); first.terminal.ensureConnected(); expect(first.sockets).toHaveLength(1);
  second.doc.focused = false; second.events.get("blur")!();
  first.doc.focused = true; first.events.get("focus")!();
  second.sockets[0]!.takeover();
  expect(first.sockets[1]!.url.searchParams.get("takeover")).toBe("1"); expect(second.timers.size).toBe(0);
});

test("short drops are silent, longer drops have one delayed status and no reconnect button", () => {
  const h = detailHarness({ active: true }); const terminal = h.terminals.get(2)!;
  terminal.emitReady(true); expect(h.one("terminal-status").hidden).toBe(true);
  terminal.emitReady(false); h.advance(1999); expect(h.one("terminal-status").hidden).toBe(true);
  terminal.emitReady(true); h.advance(1); expect(h.one("terminal-status").hidden).toBe(true);
  terminal.emitReady(false); h.advance(2000);
  const bar = h.one("terminal-status"); expect(bar.hidden).toBe(false);
  expect(bar.children[0]!.textContent).toBe("正在连接…"); expect(bar.children[1]!.hidden).toBe(true);
  terminal.emitReady(true); expect(bar.hidden).toBe(true); h.view.dispose();
});

test("a takeover preserves the visible screen with a paused status until the terminal reconnects", () => {
  const h = detailHarness({ active: true }), terminal = h.terminals.get(2)!;
  const host = h.one("terminal-host"), bar = h.one("terminal-status");
  terminal.emitReady(true);
  expect(host.attrs["aria-hidden"]).toBe("false");
  terminal.handedOff = true; terminal.emitReady(false);
  expect(host.attrs["aria-hidden"]).toBe("false");
  expect(bar.hidden).toBe(false); expect(bar.textContent).toContain("画面已暂停");
  expect(bar.children.filter(c => c.tag === "button" && !c.hidden)).toEqual([]);
  terminal.handedOff = false; terminal.emitReady(true);
  expect(bar.hidden).toBe(true);
  h.b.executions[1].terminal_state = "closed"; h.view.update();
  expect(host.attrs["aria-hidden"]).toBe("true");
  h.view.dispose();
});

test("each human-action case has exactly one concise status and one button", () => {
  for (const [patch, text, button] of [
    [{ terminal_state: "unreachable", requires_action: true }, "设备连接需要设置", "打开连接设置"],
    [{ terminal_state: "restoring", restore_kind: "confirm" }, "需要你完成确认", "查看并确认"],
    [{ terminal_state: "restoring", restore_kind: "identity" }, "会话身份尚未核实", "核对会话"],
    [{ terminal_state: "restoring", restore_kind: "choose" }, "请选择要继续的对话", "选择对话"],
    [{ terminal_state: "conflict" }, "请选择要继续的对话", "选择对话"],
    [{ terminal_state: "closed", can_resume: true }, "对话已关闭", "继续对话"],
    [{ terminal_state: "closed", can_resume: false }, "原对话无法恢复", "新建对话"],
  ] as const) {
    const h = detailHarness({ setup: b => { Object.assign(b.executions[1], patch, { error: "raw SSH error", resume_reason: "raw session internal reason" }); } });
    const bar = h.one("terminal-status");
    expect(bar.hidden).toBe(false); expect(bar.children[0]!.textContent).toBe(text);
    expect(bar.children.filter(c => c.tag === "button" && !c.hidden).map(c => c.textContent)).toEqual([button]);
    expect(h.main.textContent).not.toContain("raw SSH error"); expect(h.main.textContent).not.toContain("raw session internal reason");
    for (const cls of ["session-state", "terminal-empty", "followup-blocked", "followup-attention"]) expect(h.all(h.main).some(e => e.classList.contains(cls))).toBe(false);
    h.view.dispose();
  }
});

test("opening connection settings is the sole card action for missing device configuration", async () => {
  const h = detailHarness({ setup: b => Object.assign(b.executions[1], { terminal_state: "unreachable", requires_action: true }) });
  await h.one("terminal-status").children[1]!.events.click!();
  expect(h.navigation).toEqual(["#/machines"]);
  expect(JSON.parse(h.stored.get("broadcast.connection-settings")!)).toMatchObject({ machine: "Local" });
  expect(h.requests).toEqual([]); h.view.dispose();
});

test("new conversation requires a deliberate choice and never preloads the old task prompt", async () => {
  const h = detailHarness({ setup: b => Object.assign(b.executions[1], { terminal_state: "closed", can_resume: false, cwd: "/repo" }) });
  await h.one("terminal-status").children[1]!.events.click!();
  let dialog = h.one("connection-dialog"); expect(dialog.textContent).toContain("新对话不包含原对话记录。");
  h.all(dialog).find(e => e.tag === "button" && e.textContent === "取消")!.events.click!();
  expect(h.navigation).toEqual([]); expect(h.requests).toEqual([]);
  await h.one("terminal-status").children[1]!.events.click!(); dialog = h.one("connection-dialog");
  await h.all(dialog).find(e => e.tag === "button" && e.textContent === "新建")!.events.click!();
  expect(h.navigation).toEqual(["#/new"]);
  expect(JSON.parse(h.stored.get("broadcast.prefill")!)).toMatchObject({ prompt: "", targets: [], fresh: [{ cwd: "/repo", count: 1 }] });
  expect(h.requests).toEqual([]); h.view.dispose();
});

test("native history selection is shown once and metadata confirmation closes it automatically", async () => {
  const h = detailHarness({ setup: b => Object.assign(b.executions[1], { terminal_state: "restoring", restore_kind: "choose" }) });
  await h.one("terminal-status").children[1]!.events.click!();
  expect(h.one("connection-dialog").textContent).toContain("选择要继续的对话");
  expect(h.terminals.get(2)!.pins).toEqual([true]);
  Object.assign(h.b.executions[1], { terminal_state: "live", can_follow_up: true }); h.view.update(); h.terminals.get(2)!.emitReady(true);
  expect(h.all(h.main).some(e => e.tag === "dialog")).toBe(false); expect(h.terminals.get(2)!.pins).toEqual([true, false]);
  expect(h.requests).toEqual([]); expect(h.one("terminal-status").hidden).toBe(true); h.view.dispose();
});

test("manual identity fallback explains the missing identity without claiming the agent is blocked", async () => {
  const h = detailHarness({ setup: b => Object.assign(b.executions[1], { state: "sent", agent_status: "done", terminal_state: "restoring", restore_kind: "identity", can_confirm_session: true }),
    post: async () => { Object.assign(h.b.executions[1], { terminal_state: "live", can_confirm_session: false }); return { ok: true }; } });
  await h.one("terminal-status").children[1]!.events.click!();
  const dialog = h.one("connection-dialog");
  expect(dialog.textContent).toContain("核对原会话"); expect(dialog.textContent).toContain("不会重新发送历史任务");
  expect(h.main.textContent).not.toContain("需要你完成确认");
  await h.all(dialog).find(e => e.tag === "button" && e.textContent === "继续此对话")!.events.click!();
  expect(h.requests).toEqual([{ path: "/api/executions/2/confirm-session", body: { terminal_id: "t1" } }]);
  expect(h.b.executions[1].state).toBe("sent"); expect(h.b.rounds).toHaveLength(2);
  expect(h.all(h.main).some(e => e.tag === "dialog")).toBe(false); h.view.dispose();
});

test("pending identity has its own status without an actionable startup confirmation", () => {
  const h = detailHarness({ setup: b => Object.assign(b.executions[1], { terminal_state: "identity_pending" }) });
  const bar = h.one("terminal-status");
  expect(bar.hidden).toBe(false); expect(bar.textContent).toContain("尚未获取会话标识");
  expect(bar.children.filter(c => c.tag === "button" && !c.hidden)).toEqual([]);
  expect(h.main.textContent).not.toContain("需要你完成确认");
  h.view.dispose();
});

test("foreground focus and the same click coalesce into one takeover attempt", () => {
  const h = harness(false); h.doc.focused = true; h.events.get("focus")!();
  h.events.get("terminal:pointerdown")!(); h.events.get("focus")!();
  expect(h.sockets).toHaveLength(1); expect(h.sockets[0]!.url.searchParams.get("takeover")).toBe("1");
  h.sockets[0]!.onmessage!({ data: JSON.stringify({ type: "status", state: "waiting", canTakeover: true }) });
  h.events.get("terminal:pointerdown")!();
  expect(h.sockets).toHaveLength(2); expect(h.sockets[1]!.url.searchParams.get("takeover")).toBe("1");
});

for (const state of ["sent", "uncertain", "lost", "completed"]) test(`closed ${state} history stays closed even with an old auto-resume flag`, async () => {
  const h = detailHarness({ active: true, setup: b => Object.assign(b.executions[1], { state, terminal_state: "closed", can_resume: true, can_auto_resume: true }) });
  h.advance(10000); h.view.update(); await Bun.sleep(0);
  expect(h.requests).toEqual([]); expect(h.one("terminal-status").children[1]!.textContent).toBe("继续对话"); h.view.dispose();
});

test("a closed conversation resumes only after a click without replaying a task", async () => {
  let record: any;
  const h = detailHarness({ active: true,
    setup: b => { record = b.executions[1]; Object.assign(record, { state: "lost", terminal_state: "closed", can_resume: true, can_auto_resume: true }); },
    post: async () => { Object.assign(record, { terminal_state: "live", can_auto_resume: false }); return { mode: "opened" }; } });
  await Bun.sleep(0); expect(h.requests).toEqual([]);
  await h.one("terminal-status").children[1]!.events.click!();
  expect(h.requests).toEqual([{ path: "/api/executions/2/continue", body: { choose_session: false } }]);
  expect(record.state).toBe("lost"); expect(h.b.rounds).toHaveLength(2);
  h.terminals.get(2)!.emitReady(true); expect(h.one("terminal-status").hidden).toBe(true); h.view.dispose();
});

test("activating a background card cannot restore a closed conversation", async () => {
  let record: any;
  const h = detailHarness({ setup: b => { record = b.executions[1]; Object.assign(record, { state: "lost", terminal_state: "closed", can_resume: true, can_auto_resume: true }); },
    post: async () => { Object.assign(record, { terminal_state: "live", can_auto_resume: false }); return { mode: "opened" }; } });
  h.view.update(); h.advance(10000); expect(h.requests).toEqual([]);
  h.terminals.get(2)!.active = true; h.terminals.get(2)!.emitReady(false); await Bun.sleep(0);
  expect(h.requests).toEqual([]); h.view.dispose();
});

test("unknown history opens a picker only after the user requests restoration", async () => {
  let record: any;
  const h = detailHarness({ active: true,
    setup: b => { record = b.executions[1]; Object.assign(record, { state: "sent", terminal_state: "closed", can_resume: true, resume_mode: "choose" }); },
    post: async () => { Object.assign(record, { terminal_state: "restoring", restore_kind: "choose" }); return { mode: "choose" }; } });
  await Bun.sleep(0); h.view.update(); h.advance(30000);
  expect(h.requests).toEqual([]); expect(h.all(h.main).some(e => e.tag === "dialog")).toBe(false);
  await h.one("terminal-status").children[1]!.events.click!();
  expect(h.requests).toEqual([{ path: "/api/executions/2/continue", body: { choose_session: true } }]);
  expect(h.one("connection-dialog").textContent).toContain("选择要继续的对话"); h.view.dispose();
});

test("a refused explicit restore stops retrying and offers one retry button", async () => {
  const h = detailHarness({ active: true, setup: b => Object.assign(b.executions[1], { state: "lost", terminal_state: "closed", can_resume: true, can_auto_resume: true }),
    post: async () => { throw Object.assign(new Error("没有这个目录：/repo"), { status: 400 }); } });
  await h.one("terminal-status").children[1]!.events.click!();
  await Bun.sleep(0); h.advance(60_000); h.view.update(); await Bun.sleep(0);
  expect(h.requests.map(x => x.path)).toEqual(["/api/executions/2/continue"]);
  const bar = h.one("terminal-status");
  expect(bar.children[0]!.textContent).toBe("未能恢复对话");
  expect((bar.children[0] as any).title).toBe("没有这个目录：/repo");
  expect(bar.children[1]!.textContent).toBe("重试");
  await bar.children[1]!.events.click!();
  expect(h.requests.map(x => x.path)).toEqual(["/api/executions/2/continue", "/api/executions/2/continue"]);
  h.view.dispose();
});

test("an unreachable server during an explicit restore is retried with backoff", async () => {
  const h = detailHarness({ active: true, setup: b => Object.assign(b.executions[1], { state: "lost", terminal_state: "closed", can_resume: true, can_auto_resume: true }),
    post: async () => { throw new Error("fetch failed"); } });
  await h.one("terminal-status").children[1]!.events.click!();
  await Bun.sleep(0);
  expect(h.requests).toHaveLength(1);
  h.advance(1_000); await Bun.sleep(0);
  expect(h.requests.map(x => x.path)).toEqual(["/api/executions/2/continue", "/api/executions/2/continue"]);
  h.view.dispose();
});

test("missing history does not enter an automatic restore loop", async () => {
  const h = detailHarness({ active: true, setup: b => Object.assign(b.executions[1], { state: "lost", terminal_state: "closed", can_resume: true, can_auto_resume: true }),
    post: async () => ({ mode: "unavailable" }) });
  await h.one("terminal-status").children[1]!.events.click!();
  await Bun.sleep(0); h.view.update(); h.advance(30000); h.view.update();
  expect(h.requests).toHaveLength(1); expect(h.one("terminal-status").children[0]!.textContent).toBe("原对话无法恢复");
  expect(h.one("terminal-status").children[1]!.textContent).toBe("新建对话"); h.view.dispose();
});

test("switching input rounds during recovery keeps the terminal and does not restart recovery", async () => {
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  const h = detailHarness({ active: true, setup: b => Object.assign(b.executions[1], { state: "lost", terminal_state: "closed", can_resume: true, can_auto_resume: true }),
    post: async () => { await pending; return { mode: "inspect" }; } });
  void h.one("terminal-status").children[1]!.events.click!();
  expect(h.requests).toHaveLength(1); h.entries()[0]!.events.click!(); release(); await Bun.sleep(0);
  expect(h.requests).toHaveLength(1); expect(h.one("round-prompt").textContent).toBe("first");
  expect(h.operations).toEqual(["open:2"]);
  expect(h.all(h.main).some(e => e.tag === "dialog")).toBe(true); h.view.dispose();
});

test("a duplicated live conversation is chosen explicitly instead of closing or guessing a terminal", async () => {
  const h = detailHarness({ setup: b => Object.assign(b.executions[1], { terminal_state: "conflict" }),
    api: async path => path.endsWith("conversation-options") ? { options: [{ terminal_id: "chosen", label: "original project" }] } : h.data,
    post: async () => { Object.assign(h.b.executions[1], { terminal_state: "live", terminal_id: "chosen" }); return { ok: true }; } });
  await h.one("terminal-status").children[1]!.events.click!();
  const dialog = h.one("connection-dialog");
  h.all(dialog).find(e => e.tag === "input")!.events.change!();
  await h.all(dialog).find(e => e.tag === "button" && e.textContent === "继续此对话")!.events.click!();
  expect(h.requests).toEqual([{ path: "/api/executions/2/select-conversation", body: { terminal_id: "chosen" } }]);
  expect(h.b.executions[1].state).toBe("completed"); expect(h.b.rounds).toHaveLength(2); h.view.dispose();
});

test("cancelling a native picker returns its terminal to the card without discarding the selection or relaunching", async () => {
  const h = detailHarness({ setup: b => Object.assign(b.executions[1], { terminal_state: "restoring", restore_kind: "choose" }) });
  const cardHost = h.one("terminal-host");
  await h.one("terminal-status").children[1]!.events.click!();
  const dialog = h.one("connection-dialog");
  expect(h.all(dialog)).toContain(cardHost);
  h.all(dialog).find(e => e.tag === "button" && e.textContent === "取消")!.events.click!();
  expect(h.one("terminal-body").children).toContain(cardHost); expect(h.requests).toEqual([]);
  expect(h.terminals.get(2)!.pins).toEqual([true, false]); h.view.dispose();
});

test("clicking the blank terminal body can recover ownership while the old screen is hidden", () => {
  const h = harness();
  h.sockets[0]!.onmessage!({ data: JSON.stringify({ type: "status", state: "waiting", canTakeover: true }) });
  h.events.get("body:pointerdown")!();
  expect(h.sockets).toHaveLength(2); expect(h.sockets[1]!.url.searchParams.get("takeover")).toBe("1");
  h.events.get("terminal:pointerdown")!(); h.events.get("body:pointerdown")!();
  expect(h.sockets).toHaveLength(2);
  h.terminal.dispose(); expect(h.events.has("body:pointerdown")).toBe(false);
});

/** The real machines page and sidebar update chip, on a small DOM stand-in. */
function machinesHarness(options: { webUi?: { installed: boolean; running: boolean }; local?: boolean; update?: any; machines?: any[]; settings?: boolean; newBroadcast?: boolean; storage?: Map<string, string>; post?: (path: string, body: any) => Promise<any>; hidden?: boolean } = {}) {
  class Element {
    children: Element[] = []; parent?: Element; className = ""; text = ""; value = "";
    disabled = false; hidden = false; attrs: Record<string, any> = {}; dataset: Record<string, any> = {}; events: Record<string, Function> = {};
    style = {}; title = "";
    classList = {
      contains: (name: string) => this.className.split(" ").includes(name),
      add: (name: string) => this.classList.toggle(name, true),
      remove: (name: string) => this.classList.toggle(name, false),
      toggle: (name: string, force = !this.classList.contains(name)) => {
        const names = new Set(this.className.split(" ").filter(Boolean)); force ? names.add(name) : names.delete(name); this.className = [...names].join(" "); return force;
      },
    };
    constructor(readonly tag: string) {}
    get textContent(): string { return this.text + this.children.map(c => c.textContent).join(""); }
    set textContent(value: string) { this.text = value; this.children = []; }
    append(...children: any[]) { for (const c of children.flat()) { if (c == null || c === false) continue; const child = c instanceof Element ? c : Object.assign(new Element("text"), { text: String(c) }); child.parent = this; this.children.push(child); } }
    replaceChildren(...children: any[]) { this.text = ""; this.children = []; this.append(...children); }
    contains(child: any): boolean { return this === child || this.children.some(c => c.contains(child)); }
    setAttribute(k: string, v: any) { this.attrs[k] = v; }
    addEventListener(k: string, fn: Function) { this.events[k] = fn; }
    focus() {} select() {} scrollIntoView() {}
    get firstChild() { return this.children[0]; }
    querySelector(selector: string): Element | null {
      return this.querySelectorAll(selector)[0] ?? null;
    }
    querySelectorAll(selector: string): Element[] {
      return this.children.flatMap(c => [c, ...c.querySelectorAll("*")]).filter(c => selector === "*" || (selector.startsWith(".") && c.classList.contains(selector.slice(1))));
    }
  }
  const h = (tag: string, attrs: any, ...children: any[]) => {
    const el = new Element(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = String(v);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v as Function);
      else { el.setAttribute(k, v); if (k in el) (el as any)[k] = v; }
    }
    el.append(...children); return el;
  };
  const all = (el: Element): Element[] => [el, ...el.children.flatMap(all)];
  const main = new Element("main"), updateBox = new Element("div"), body = new Element("body");
  const storage = options.storage ?? new Map<string, string>();
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const requests: { path: string; body: any }[] = [], toasts: string[] = [];
  const machines = options.machines ?? [
    { id: "local", label: "本机", enabled: true, target: null, web_link: "?ws=w1", web_link_reason: null },
    { id: "m-1", label: "gpu", enabled: true, target: "u@gpu", web_link: "?machine=x&ws=w2", web_link_reason: null },
    { id: "m-2", label: "empty", enabled: true, target: "u@empty", web_link: null, web_link_reason: "机器暂无工作区，请先在 Herdr 中创建工作区" },
  ];
  const data: any = { state: { machines, broadcasts: [] }, agents: [], webUi: options.webUi ?? { installed: false, running: false }, update: options.update ?? null };
  const reloads: number[] = [];
  const timers: (() => void)[] = [];
  let serverInstance = "old";
  const globals: any = {
    h, data, loaded: true, DRAFT_KEY: "draft", PREFILL_KEY: "prefill", config: { local: options.local ?? true, kinds: ["claude", "codex"] }, view: null, document: { activeElement: null, body, hidden: options.hidden ?? false },
    $: (id: string) => (id === "update-box" ? updateBox : null),
    sessionStorage: { getItem: () => null, removeItem() {} },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    autogrow: (el: Element) => el, sendButton: (attrs: any) => h("button", { class: "send", ...attrs }),
    topbar: (...children: any[]) => h("div", {}, ...children),
    machineDown: () => false, ago: () => "刚刚", toast: (t: string) => toasts.push(t), ACTIVE: [],
    api: async (path: string) => (path.includes("health") ? { health: {}, at: 1 } : { file: null, machines: [] }),
    post: async (path: string, body: any) => {
      requests.push({ path, body });
      if (options.post) return options.post(path, body);
      if (path === "/api/update/install" || path === "/api/update/apply") data.update = { ...data.update, available: false, phase: "restarting" };
      return path.endsWith("/focus") ? { message: "已切到" } : { update: data.update, instance: "old" };
    },
    location: { reload: () => reloads.push(1) }, fetch: async () => ({ ok: true, json: async () => ({ instance: serverInstance }) }),
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimeout() {}, Date: Clock,
    webUiLink: (q: string) => `http://localhost:7317/${q}`, openInWebUi() {},
    sameHerdr: () => true, splitAddress: (t: string) => ({ address: t, port: "", key: "" }), joinAddress: (a: string) => a, defaultKey: () => false, copyBlock: () => h("div", {}),
  };
  const run = (from: string, to: string) => pageScript.slice(pageScript.indexOf(from), pageScript.indexOf(to));
  const source = [run("function confirmButton(", "function webUiBase("), run("const WEB_UI_REPO", "/** Whether the reader has text selected"),
    run("const compose =", "// ---- settings:"), run("function settingsView(main)", "// ---- machines:"), run("function machinesView(main)", "// ---- a broadcast: its prompt")].join("\n");
  const scope = runInNewContext(`${source}\n({ machinesView, settingsView, newView, renderUpdate })`, globals);
  const view = options.newBroadcast ? scope.newView(main) : options.settings ? scope.settingsView(main) : scope.machinesView(main);
  return { main, body, updateBox, data, view, requests, toasts, reloads, all, storage, document: globals.document, renderUpdate: scope.renderUpdate,
    advance(ms: number) { now += ms; }, notice: () => body.children.find(e => e.classList.contains("update-notice")),
    restartServer() { serverInstance = "new"; }, async pollRestart() { const next = timers.shift(); next?.(); await Bun.sleep(0); },
    text: () => main.textContent, buttons: (label: string) => all(main).filter(e => e.tag === "button" && e.textContent === label) };
}

describe("machines page", () => {
  test("without herdr-web-ui no machine offers it, and the page says how to install it", () => {
    const h = machinesHarness();
    expect(h.text()).not.toContain("打开 herdr-web-ui");
    const tip = h.all(h.main).find(e => e.classList.contains("webui-tip"))!;
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toContain("herdr plugin install devswha/herdr-web-ui");
    expect(h.all(tip).find(e => e.tag === "a")!.attrs.href).toBe("https://github.com/devswha/herdr-web-ui");
  });

  test("installed but stopped, it asks to start it; running, every reachable machine links to it", () => {
    const stopped = machinesHarness({ webUi: { installed: true, running: false } });
    expect(stopped.all(stopped.main).find(e => e.classList.contains("webui-tip"))!.textContent).toContain("启动 herdr-web-ui");
    expect(stopped.text()).not.toContain("打开 herdr-web-ui");
    const running = machinesHarness({ webUi: { installed: true, running: true } });
    expect(running.all(running.main).find(e => e.classList.contains("webui-tip"))!.hidden).toBe(true);
    const links = running.all(running.main).filter(e => e.tag === "a" && e.textContent === "打开 herdr-web-ui ↗");
    expect(links.map(a => a.attrs.href)).toEqual(["http://localhost:7317/?ws=w1", "http://localhost:7317/?machine=x&ws=w2"]);
  });

  test("each machine opens in Herdr from this computer; one with no workspace says why", async () => {
    const h = machinesHarness();
    const open = h.buttons("在 Herdr 中打开");
    expect(open).toHaveLength(3);
    expect(open[2]!.disabled).toBe(true);
    expect(open[2]!.attrs.title).toContain("暂无工作区");
    await open[1]!.events.click!();
    expect(h.requests).toEqual([{ path: "/api/machines/m-1/focus", body: undefined }]);
    expect(h.toasts).toEqual(["已切到"]);
    // from a phone it would switch this computer's Herdr, which the phone cannot see
    expect(machinesHarness({ local: false }).buttons("在 Herdr 中打开")).toHaveLength(0);
  });

  test("the plugin's version is shown; a newer one is offered and installed on a second press", async () => {
    const update = { kind: "github", current_version: "0.3.0", current_revision: "a".repeat(40), latest_version: "0.3.1", latest_revision: "b".repeat(40), available: true, phase: "idle", blocked_reason: null, error: null, checked_at: 1 };
    const h = machinesHarness({ settings: true, update });
    expect(h.text()).toContain("v0.3.0 · aaaaaaa");
    expect(h.text()).toContain("有新版本 v0.3.1 · bbbbbbb");
    const install = h.buttons("更新并重启")[0]!;
    await install.events.click!();
    expect(h.requests).toEqual([]);
    await install.events.click!();
    expect(h.requests.map(r => r.path)).toEqual(["/api/update/install"]);
    // An old server still answering must not cause an early reload.
    await h.pollRestart();
    expect(h.reloads).toEqual([]);
    h.restartServer();
    await h.pollRestart();
    expect(h.reloads.length).toBeGreaterThan(0);
  });

  test("the version line prints no placeholder text for the buttons it leaves out", () => {
    // replaceChildren, unlike h(), would print a null as the text "null"
    for (const update of [
      { kind: "git", current_version: "0.3.0", current_revision: "c".repeat(40), available: false, phase: "idle", blocked_reason: null, checked_at: 1 },
      { kind: "git", current_version: "0.3.0", available: true, latest_version: "0.3.1", phase: "idle", blocked_reason: "插件仓库有未提交的改动", checked_at: 1 },
      { kind: "github", current_version: "0.3.0", available: true, latest_version: "0.3.1", phase: "idle", blocked_reason: null, checked_at: 1 },
      { kind: "git", current_version: "0.3.0", available: false, phase: "error", error: "无法读取 GitHub 上的最新版本", blocked_reason: null, checked_at: 1 },
      null,
    ]) {
      const h = machinesHarness({ settings: true, update });
      const about = h.all(h.main).find(e => e.classList.contains("about"))!;
      expect(about.textContent).not.toMatch(/null|undefined|NaN/);
      h.view.dispose?.();
    }
  });

  test("checking says it is up to date; a blocked update says why and offers no install", async () => {
    const h = machinesHarness({ settings: true, update: { kind: "github", current_version: "0.3.0", current_revision: "c".repeat(40), available: false, phase: "idle", blocked_reason: null, checked_at: 1 } });
    expect(h.text()).toContain("已是最新");
    await h.buttons("检查更新")[0]!.events.click!();
    expect(h.requests.map(r => r.path)).toEqual(["/api/update/check"]);
    const blocked = machinesHarness({ settings: true, update: { kind: "github", current_version: "0.3.0", available: true, latest_version: "0.3.1", phase: "idle", blocked_reason: "插件仓库有未提交的改动", checked_at: 1 } });
    expect(blocked.text()).toContain("未提交的改动");
    expect(blocked.buttons("更新并重启")).toHaveLength(0);
    // from another computer the version shows, but checking and installing are this computer's
    const remote = machinesHarness({ settings: true, local: false, update: { kind: "github", current_version: "0.3.0", available: true, latest_version: "0.3.1", phase: "idle", blocked_reason: null, checked_at: 1 } });
    expect(remote.buttons("检查更新")[0]!.disabled).toBe(true);
    expect(remote.buttons("更新并重启")).toHaveLength(0);
  });
});

describe("settings navigation", () => {
  test("local links show the runtime and restart, without development controls or stale edit/update notices", () => {
    for (const kind of ["local", "git", "unmanaged"]) {
      const h = machinesHarness({ settings: true, update: { kind, mode: "development", root: "/local/source", source_changed: true, available: true, latest_revision: "stale", current_version: "0.3.0", current_revision: "a".repeat(40), source_revision: "b".repeat(40), phase: "idle", blocked_reason: "dirty" } });
      expect(h.text()).toContain("v0.3.0 · aaaaaaa"); expect(h.buttons("重启服务")[0]!.disabled).toBe(false);
      expect(h.text()).not.toMatch(/本地开发|待应用|已应用|本地代码|源码|dirty/);
      expect(h.buttons("检查更新")).toHaveLength(0); expect(h.buttons("更新并重启")).toHaveLength(0);
      h.renderUpdate(); expect(h.notice()).toBeUndefined(); expect(h.updateBox.hidden).toBe(true);
    }
  });
  test("local edits still only offer restart and never submit an apply request", async () => {
    const h = machinesHarness({ settings: true, update: { kind: "local", source_changed: true, phase: "idle" } });
    await h.buttons("重启服务")[0]!.events.click!(); expect(h.requests.map(r => r.path)).toEqual(["/api/web/restart"]);
    await h.pollRestart(); expect(h.reloads).toEqual([]); h.restartServer(); await h.pollRestart(); expect(h.reloads).toEqual([1]);
    const remote = machinesHarness({ settings: true, local: false, update: { kind: "local", phase: "idle" } });
    expect(remote.buttons("重启服务")[0]!.disabled).toBe(true); expect(remote.buttons("应用本地代码")).toHaveLength(0);
  });
  test("manual update progress and failure remain visible without adding a development control", () => {
    const h = machinesHarness({ settings: true, update: { kind: "local", phase: "updating", action: "apply", step: "typecheck", available: true, latest_revision: "stale" } });
    expect(h.text()).toContain("正在验证代码"); expect(h.buttons("重启服务")[0]!.disabled).toBe(true);
    h.data.update = { ...h.data.update, phase: "error", error: "validation failed" }; h.view.update(); h.renderUpdate();
    expect(h.text()).toContain("更新失败：validation failed"); expect(h.buttons("重启服务")[0]!.disabled).toBe(false);
    expect(h.buttons("应用本地代码")).toHaveLength(0); expect(h.notice()).toBeUndefined();
  });
  test("page top bars contain only their own navigation and actions", () => {
    const source = pageScript.slice(pageScript.indexOf("function topbar("), pageScript.indexOf("// ---- sidebar, title and notifications"));
    const topbar = runInNewContext(`${source}\ntopbar`, {
      h: (tag: string, attrs: any, ...children: any[]) => ({ tag, attrs, children: children.flat() }), go() {},
    });
    expect(topbar("title", "actions").children).toHaveLength(3);
  });

  test("version management has one home in settings; navigation only signals changes", () => {
    const update = { kind: "github", available: false, phase: "idle", current_version: "0.3.0", checked_at: 1 };
    const machines = machinesHarness({ update });
    expect(machines.text()).not.toContain("Broadcast 插件");
    expect(machines.buttons("检查更新")).toHaveLength(0);
    machines.renderUpdate();
    expect(machines.updateBox.hidden).toBe(true);
    machines.data.update.available = true;
    machines.renderUpdate();
    expect(machines.updateBox.textContent).toBe("有更新");
    expect(machines.updateBox.hidden).toBe(false);
    machines.data.update.phase = "restarting";
    machines.renderUpdate();
    expect(machines.updateBox.textContent).toBe("重启中…");
  });

  test("restart is available without an update, waits for a new instance, and is local only", async () => {
    const h = machinesHarness({ settings: true });
    await h.buttons("重启服务")[0]!.events.click!();
    expect(h.requests.map(r => r.path)).toEqual(["/api/web/restart"]);
    await h.pollRestart();
    expect(h.reloads).toEqual([]);
    h.restartServer();
    await h.pollRestart();
    expect(h.reloads).toEqual([1]);
    expect(machinesHarness({ settings: true, local: false }).buttons("重启服务")[0]!.disabled).toBe(true);
  });
});


test("new broadcast keeps its composer above recipient choices and preserves the draft across type changes", () => {
  const h = machinesHarness({ newBroadcast: true });
  const column = h.all(h.main).find(e => e.classList.contains("new-column"))!;
  expect(column.children.map(e => e.className)).toEqual(["new-hero", "composer", "recipient-picker"]);
  const prompt = h.all(column).find(e => e.tag === "textarea")!;
  prompt.value = "检查这个项目";
  const type = h.all(column).find(e => e.tag === "select")!;
  expect(type.children.map(e => e.textContent)).toEqual(["claude", "codex"]);
  type.value = "codex"; type.events.change!(); h.view.update();
  expect(prompt.value).toBe("检查这个项目");
  expect(column.children[0]!.hidden).toBe(false);
  const existing = h.all(column).find(e => e.attrs.id === "tabbtn-existing")!;
  existing.events.click!();
  expect(h.all(column).find(e => e.attrs.id === "tab-existing")!.hidden).toBe(false);
  expect(h.all(column).find(e => e.attrs.id === "tab-new")!.hidden).toBe(true);
});


describe("new version notice", () => {
  const update = () => ({ kind: "github", mode: "installed", available: true, phase: "idle", current_version: "0.3.0", current_revision: "a".repeat(40), latest_version: "0.3.1", latest_revision: "b".repeat(40), blocked_reason: null });
  const button = (h: ReturnType<typeof machinesHarness>, text: string) => h.all(h.notice()!).find(e => e.tag === "button" && e.textContent === text)!;

  test("new versions appear without navigation, reuse one notice and leave focus alone", () => {
    const h = machinesHarness({ update: update() });
    const input = { draft: "do not interrupt" };
    h.document.activeElement = input;
    h.renderUpdate();
    const notice = h.notice()!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("发现新版本");
    expect(notice.textContent).toContain("v0.3.1 · bbbbbbb");
    expect(button(h, "更新并重启")).toBeDefined();
    expect(button(h, "暂时忽略")).toBeDefined();
    h.renderUpdate();
    expect(h.body.children).toHaveLength(1);
    expect(h.notice()).toBe(notice);
    expect(h.document.activeElement).toBe(input);
  });

  test("ignore persists across reloads, expires after 24 hours and never hides settings", () => {
    const storage = new Map<string, string>();
    const h = machinesHarness({ update: update(), storage }); h.renderUpdate();
    button(h, "暂时忽略").events.click!();
    h.renderUpdate();
    expect(h.notice()!.hidden).toBe(true);
    expect(h.updateBox.textContent).toBe("有更新");
    const reloaded = machinesHarness({ settings: true, update: update(), storage }); reloaded.renderUpdate();
    expect(reloaded.notice()).toBeUndefined();
    expect(reloaded.buttons("更新并重启")).toHaveLength(1);
    reloaded.advance(24 * 60 * 60_000 + 1); reloaded.renderUpdate();
    expect(reloaded.notice()!.hidden).toBe(false);
  });

  test("a failed storage write cannot replace a new in-memory dismissal with an old stored one", () => {
    const storage = new Map([["broadcast.updateDismissed", JSON.stringify({ revision: "old", until: Date.now() + 3600_000 })]]);
    const h = machinesHarness({ update: update(), storage }); h.renderUpdate();
    // Even a later ignore from a stale tab must not replace this release's in-memory choice.
    storage.set("broadcast.updateDismissed", JSON.stringify({ revision: "old", until: Date.now() + 48 * 3600_000 }));
    storage.set = () => { throw new Error("QuotaExceededError"); };
    button(h, "暂时忽略").events.click!();
    h.renderUpdate(); h.renderUpdate();
    expect(h.notice()!.hidden).toBe(true);
    expect(h.updateBox.textContent).toBe("有更新");
    h.advance(24 * 60 * 60_000 + 1); h.renderUpdate();
    expect(h.notice()!.hidden).toBe(false);
  });

  test("a later cross-tab dismissal is respected and a new release still appears after a failed write", () => {
    const storage = new Map<string, string>();
    const h = machinesHarness({ update: update(), storage }); h.renderUpdate();
    button(h, "暂时忽略").events.click!();
    const saved = JSON.parse(storage.get("broadcast.updateDismissed")!);
    storage.set("broadcast.updateDismissed", JSON.stringify({ ...saved, until: saved.until + 3600_000 }));
    h.advance(24 * 60 * 60_000 + 1); h.renderUpdate();
    expect(h.notice()!.hidden).toBe(true);
    storage.set = () => { throw new Error("QuotaExceededError"); };
    h.data.update.latest_revision = "c".repeat(40); h.renderUpdate();
    expect(h.notice()!.hidden).toBe(false);
    button(h, "暂时忽略").events.click!(); h.renderUpdate();
    expect(h.notice()!.hidden).toBe(true);
    h.data.update.latest_revision = "d".repeat(40); h.renderUpdate();
    expect(h.notice()!.hidden).toBe(false);
  });

  test("a different commit with the same version number is announced despite snoozing", () => {
    const h = machinesHarness({ update: update() }); h.renderUpdate();
    button(h, "暂时忽略").events.click!();
    h.data.update = { ...h.data.update, latest_revision: "c".repeat(40) }; h.renderUpdate();
    expect(h.notice()!.hidden).toBe(false);
    expect(h.notice()!.textContent).toContain("ccccccc");
    h.data.update.available = false; h.renderUpdate();
    expect(h.notice()!.hidden).toBe(true);
  });

  test("one click installs, state refreshes cannot duplicate it, then waits for the restarted server", async () => {
    let finish!: (result: any) => void;
    const h = machinesHarness({ update: update(), post: () => new Promise(resolve => { finish = resolve; }) }); h.renderUpdate();
    const install = button(h, "更新并重启");
    const pending = install.events.click!();
    expect(h.requests.map(r => r.path)).toEqual(["/api/update/install"]);
    h.renderUpdate();
    expect(h.all(h.notice()!).find(e => e.classList.contains("primary"))!.disabled).toBe(true);
    await install.events.click!();
    expect(h.requests).toHaveLength(1);
    finish({ update: { ...update(), available: false, phase: "restarting" }, instance: "old" }); await pending;
    expect(h.notice()!.hidden).toBe(true);
    await h.pollRestart(); expect(h.reloads).toEqual([]);
    h.restartServer(); await h.pollRestart(); expect(h.reloads).toEqual([1]);
  });

  test("install failure keeps the notice usable and a retry can find the server already current", async () => {
    let calls = 0;
    const h = machinesHarness({ update: update(), post: async () => {
      if (++calls === 1) throw new Error("无法下载更新");
      return { update: { ...update(), available: false }, instance: "old" };
    } }); h.renderUpdate();
    await button(h, "更新并重启").events.click!();
    expect(h.notice()!.textContent).toContain("无法下载更新");
    expect(button(h, "更新并重启").disabled).toBe(false);
    await button(h, "更新并重启").events.click!();
    expect(h.notice()!.hidden).toBe(true);
    expect(h.toasts).toContain("已是最新版本");
    await h.pollRestart(); expect(h.reloads).toEqual([]);
  });

  test("background pages wait until visible; blocked and remote clients explain how to update", () => {
    const h = machinesHarness({ update: update(), hidden: true }); h.renderUpdate();
    expect(h.notice()).toBeUndefined();
    h.document.hidden = false; h.renderUpdate(); expect(h.notice()!.hidden).toBe(false);
    for (const options of [{ local: false }, { update: { ...update(), blocked_reason: "仓库有未提交的改动" } }]) {
      const blocked = machinesHarness({ update: update(), ...options }); blocked.renderUpdate();
      expect(blocked.notice()!.textContent).toContain(options.local === false ? "服务的电脑" : "未提交的改动");
      expect(button(blocked, "更新并重启")).toBeUndefined();
      expect(button(blocked, "查看详情")).toBeDefined();
      button(blocked, "暂时忽略").events.click!(); expect(blocked.requests).toEqual([]);
    }
  });
});
