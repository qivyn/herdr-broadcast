// The broadcast web page: a board of broadcasts and the agents running them. Each agent's screen
// accepts keyboard input when focused; selection is only for the follow-up composer.
// State arrives from /api/events (server-sent); changes go through the JSON API. Views are
// addressed by the hash so Back works: #/new, #/b/<broadcast>, and #/e/<execution>, which is
// its broadcast scrolled to that agent.
// A view is built once when it opens and then only patched, so typing and focus are never lost.
// Text from agents and prompts reaches the page only through textContent.
"use strict";

const STATES = {
  submitting: ["run", "发送中"], starting: ["run", "启动中"], sending: ["run", "发送中"], sent: ["ok", "已发送"],
  uncertain: ["ask", "发送结果不确定"], failed: ["bad", "发送失败"], cancelled: ["dim", "未发送"],
  // Old history remains readable; these labels do not describe current agent activity.
  completed: ["ok", "旧版已结束"], working: ["ok", "已发送"], blocked: ["ok", "已发送"],
  queued: ["dim", "旧版未发送"], lost: ["ask", "旧版结果未确认"], interrupting: ["dim", "旧版中断记录"], interrupted: ["dim", "旧版已中断"],
};
const ACTIVE = ["submitting", "starting", "sending"];
const AGENT_STATUS = { idle: "空闲", done: "空闲", working: "工作中", blocked: "等待确认", unknown: "状态未知" };
/** terminal states whose pane is there to show: a conversation, one being restored, or the shell an agent starts in */
const SHOWN = ["live", "restoring", "starting", "shell"];
const SEND_ICON = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const GROW_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SHRINK_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const DRAFT_KEY = "broadcast.draft";
/** a broadcast to send again, handed from its page to the new-broadcast form */
const PREFILL_KEY = "broadcast.prefill";
/** the detail page's counts, in the order they matter: who needs you first */
const SUMMARY = [
  ["sending", ["submitting", "starting", "sending"], "run", "发送中"],
  ["uncertain", ["uncertain", "lost"], "ask", "结果不确定"],
  ["failed", ["failed"], "bad", "发送失败"],
  ["sent", ["sent", "working", "blocked", "completed"], "ok", "已发送"],
  ["cancelled", ["cancelled", "queued"], "dim", "未发送"],
  ["interrupted", ["interrupting", "interrupted"], "dim", "旧版中断记录"],
];

let data = { state: { machines: [], broadcasts: [] }, agents: [], webUi: { installed: false, running: false }, update: null };
let loaded = false;
let config = { webUiUrl: null, kinds: ["claude"], local: false };
let view = null; // { update(), dispose?() }

// ---- helpers ----------------------------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "html") el.innerHTML = value; // fixed markup only (icons)
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const $ = (id) => document.getElementById(id);

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "刚刚";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const hr = Math.round(m / 60);
  return hr < 48 ? `${hr} 小时前` : `${Math.round(hr / 24)} 天前`;
}

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

const tone = (state) => (STATES[state] || ["dim", state])[0];
const label = (state) => (STATES[state] || ["dim", state])[1];
const baseName = (path) => path.replace(/\/+$/, "").split("/").pop() || path;

function broadcastTone(b) {
  const c = b.counts;
  if (c.uncertain || c.lost) return "ask";
  if (ACTIVE.some((s) => c[s])) return "run";
  if ((c.failed || 0) + (c.lost || 0)) return "bad";
  if ((c.sent || 0) + (c.completed || 0) === b.total && b.total > 0) return "ok";
  return "dim";
}

function toast(text, error) {
  const el = h("div", { class: `toast${error ? " error" : ""}`, role: "status" }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), error ? 6000 : 2600);
}

async function api(path, options) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options && options.headers) } });
  const body = await response.json().catch(() => ({}));
  // the status tells a refusal (that asking again will not change) from a server out of reach
  if (!response.ok) throw Object.assign(new Error((body.error && body.error.message) || `请求失败（${response.status}）`), { status: response.status });
  return body;
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body || {}) });

/**
 * A button that acts on its second press: the first turns it into "再点一次…" for three
 * seconds. For actions that cannot be taken back, in place of the browser's confirm(). With
 * `ask`, it asks only when that says there is something to lose, and acts at once otherwise.
 */
function confirmButton(text, confirmText, act, attrs, ask) {
  let timer = null;
  let busy = false;
  const button = h("button", { type: "button", ...attrs }, text);
  const disarm = () => { clearTimeout(timer); timer = null; button.classList.remove("armed"); button.textContent = text; };
  button.addEventListener("click", async () => {
    if (busy) return;
    if (!timer && (!ask || ask())) {
      button.classList.add("armed");
      button.textContent = confirmText;
      timer = setTimeout(disarm, 3000);
      return;
    }
    disarm();
    busy = true; button.disabled = true;
    try { await act(); } catch (error) { toast(error.message, true); }
    finally { busy = false; button.disabled = false; }
  });
  button.addEventListener("blur", disarm);
  return button;
}

function webUiBase() {
  if (config.webUiUrl) return config.webUiUrl.replace(/\/?$/, "/");
  return `${location.protocol}//${location.hostname}:7317/`;
}

/** herdr-web-ui on a pane, always in the same browser tab. */
function webUiLink(query, mode) {
  const q = new URLSearchParams(query.replace(/^\?/, ""));
  if (mode) q.set("view", mode);
  return `${webUiBase()}?${q}`;
}

function openInWebUi(query, mode) {
  window.open(webUiLink(query, mode), "herdr-web-ui");
}

function findBroadcast(id) {
  return data.state.broadcasts.find((b) => b.id === id) || null;
}

function findExec(id) {
  for (const b of data.state.broadcasts) for (const e of b.executions) if (e.id === id) return { b, e };
  return null;
}

/**
 * Each machine as the page knows it: "up", "down" (its Herdr does not answer), "off" (turned
 * off in Herdr) or "loading". A machine that is down keeps the agents it had last.
 */
function machineState(id) {
  const m = data.state.machines.find((x) => x.id === id);
  if (m && !m.enabled) return { state: "off", error: null };
  const group = data.agents.find((g) => g.machine.id === id);
  if (!group) return { state: m ? "loading" : "down", error: null };
  if (group.error) return { state: "down", error: group.error };
  return { state: group.loading ? "loading" : "up", error: null };
}

const machineDown = (id) => machineState(id).state === "down";

/** what to do about a machine that does not answer */
function downReason(id) {
  return id === "local" ? "Herdr 没在运行，启动 herdr 后会自动恢复" : "连不上这台机器：检查 SSH，或在 Herdr 里重连它";
}

/** under a machine that does not answer: what to do, and Herdr's own words */
function downNote(id, error) {
  return h("div", { class: "down-note", role: "alert" }, h("span", null, downReason(id)), error ? h("span", { class: "why" }, error) : null);
}

/** Machine navigation stays quiet; connection diagnostics belong in connection settings. */
function renderMachines() {
  $("machines-list").replaceChildren(...data.state.machines.map(m => h("span", { class: "m", title: m.label }, m.label)));
}

// ---- updating this plugin ---------------------------------------------------------------

const WEB_UI_REPO = "https://github.com/devswha/herdr-web-ui";
const WEB_UI_INSTALL = "herdr plugin install devswha/herdr-web-ui";

const shortRev = (rev) => (rev ? rev.slice(0, 7) : "");
const canUpdatePlugin = (u) => u?.kind === "github";
/** a version as people read it: its number, or its commit when the number did not change */
function versionText(version, revision) {
  return version ? `v${version}${revision ? ` · ${shortRev(revision)}` : ""}` : shortRev(revision) || "未知版本";
}

/** what the update is doing, in a few words; null while there is nothing to say */
function updateLine(u) {
  if (!u) return null;
  if (u.phase === "updating") return ({ download: "正在准备新版…", dependencies: "正在安装依赖…", typecheck: "正在验证代码…", resources: "正在检查运行资源…", register: "正在登记插件…" })[u.step] || "正在更新服务…";
  if (u.phase === "restarting") return "正在重启服务…";
  if (u.phase === "checking") return "正在检查更新…";
  if (u.phase === "error") return `${u.action === "restart" ? "重启失败" : "更新失败"}：${u.error}`;
  if (canUpdatePlugin(u) && u.available) return `有新版本 ${versionText(u.latest_version, u.latest_revision)}`;
  return null;
}

let updateInstalling = false;
let updateInstallError = null;

/** All update controls share one request, including while state events are arriving. */
async function installUpdate() {
  if (updateInstalling) return;
  updateInstalling = true;
  updateInstallError = null;
  renderUpdate();
  if (view) view.update();
  try {
    const result = await post("/api/update/install");
    data.update = result.update;
    if (result.operationId) {
      watchUpdateOperation(result.operationId, result.instance);
    } else if (result.update.phase === "restarting") {
      toast("网页正在重启，完成后会自动刷新");
      waitForRestart(result.instance);
    } else {
      updateInstalling = false;
      toast("已是最新版本");
    }
  } catch (error) {
    updateInstalling = false;
    updateInstallError = { revision: data.update?.latest_revision || data.update?.latest_version, message: error.message };
    throw error;
  } finally {
    renderUpdate();
    if (view) view.update();
  }
}

/** Follow the durable operation, including preparation, manager handover and rollback. */
function watchUpdateOperation(operationId, previousInstance, started = Date.now()) {
  setTimeout(async () => {
    try {
      const r = await fetch("/api/config", { cache: "no-store" });
      if (r.ok) {
        const configNow = await r.json(), u = configNow.update;
        if (u?.operation_id === operationId) {
          data.update = u;
          if (u.outcome === "failed" || u.outcome === "succeeded") {
            updateInstalling = false;
            if (configNow.instance && configNow.instance !== previousInstance) return location.reload();
            renderUpdate(); if (view) view.update();
            toast(u.outcome === "failed" ? u.error || "更新失败，服务仍可使用" : "操作已完成", u.outcome === "failed");
            return;
          }
          renderUpdate(); if (view) view.update();
        }
      }
    } catch { /* the old service may have stopped; the manager continues without this page */ }
    if (Date.now() - started < 30 * 60_000) watchUpdateOperation(operationId, previousInstance, started);
    else { updateInstalling = false; toast("操作仍可能在后台运行，请在设置中查看进度"); }
  }, 1500);
}

/** The server restarts on the new version: the page reloads once it answers again. */
function waitForRestart(previousInstance, started = Date.now()) {
  setTimeout(async () => {
    try {
      const r = await fetch("/api/config", { cache: "no-store" });
      if (r.ok) {
        const { instance } = await r.json();
        if (instance && instance !== previousInstance) return location.reload();
      }
    } catch { /* still restarting */ }
    if (Date.now() - started < 180_000) waitForRestart(previousInstance, started);
    else toast("网页没有在三分钟内重启：请在 Herdr 中运行「Broadcast: 重启服务」，或查看服务日志", true);
  }, 1500);
}

/** The settings entry only signals actionable changes; version management lives in settings. */
function renderUpdate() {
  const box = $("update-box");
  const u = data.update;
  const state = u && ({ checking: "检查中…", updating: "更新中…", restarting: "重启中…", error: "操作失败" })[u.phase]
    || (canUpdatePlugin(u) && u.available ? "有更新" : "");
  box.textContent = state;
  box.hidden = !state;
  renderUpdateNotice();
}

const UPDATE_DISMISS_KEY = "broadcast.updateDismissed";
const UPDATE_SNOOZE_MS = 24 * 60 * 60_000;
let updateNoticeEl = null;
let updateDismissal = null;

/** A persistent, non-modal notice: never steals focus from a draft or an agent's terminal. */
function renderUpdateNotice() {
  const u = data.update;
  const revision = u?.latest_revision || u?.latest_version;
  // Merge stored dismissals instead of replacing a newer in-memory choice when a write failed.
  try {
    const saved = JSON.parse(localStorage.getItem(UPDATE_DISMISS_KEY) || "null");
    if (saved?.revision && Number.isFinite(saved.until)
      && (!updateDismissal || (saved.revision === revision && (updateDismissal.revision !== revision || saved.until > updateDismissal.until)))) updateDismissal = saved;
  } catch { /* storage may be unavailable */ }
  const dismissed = updateDismissal?.revision === revision && updateDismissal?.until > Date.now();
  if (!canUpdatePlugin(u) || !u?.available || !revision || dismissed || document.hidden) {
    if (updateNoticeEl) updateNoticeEl.hidden = true;
    return;
  }
  if (!updateNoticeEl) {
    updateNoticeEl = h("section", { class: "update-notice", "aria-labelledby": "update-notice-title", "aria-live": "polite" });
    document.body.append(updateNoticeEl);
  }
  updateNoticeEl.hidden = false;
  const busy = updateInstalling || ["checking", "updating", "restarting"].includes(u.phase);
  const error = (updateInstallError?.revision === revision ? updateInstallError?.message : null) || (u.phase === "error" ? u.error : null);
  const shape = JSON.stringify([revision, u.latest_version, u.current_version, u.current_revision, busy, u.phase, u.blocked_reason, error, config.local]);
  if (updateNoticeEl.dataset.shape === shape) return;
  updateNoticeEl.dataset.shape = shape;
  const reason = !config.local ? "请在运行广播服务的电脑上打开此页更新。" : u.blocked_reason;
  const dismiss = () => {
    updateDismissal = { revision, until: Date.now() + UPDATE_SNOOZE_MS };
    try { localStorage.setItem(UPDATE_DISMISS_KEY, JSON.stringify(updateDismissal)); } catch { /* keep the in-memory dismissal */ }
    updateNoticeEl.hidden = true;
  };
  updateNoticeEl.replaceChildren(
    h("div", { class: "update-notice-head" },
      h("strong", { id: "update-notice-title" }, "发现新版本"),
      h("button", { class: "icon-btn", type: "button", "aria-label": "暂时忽略新版本提醒", onclick: dismiss }, "×")),
    h("p", { class: "update-notice-version" }, versionText(u.current_version, u.current_revision), " → ", versionText(u.latest_version, u.latest_revision)),
    h("p", { class: "update-notice-copy" }, reason || "更新后网页会自动重启，agent 的对话会保留。"),
    ...(error ? [h("p", { class: "update-notice-error", role: "status" }, `更新失败：${error}`)] : []),
    h("div", { class: "update-notice-actions" },
      h("button", { class: "btn quiet", type: "button", title: "这个版本 24 小时内不再提醒，仍可在设置里更新", onclick: dismiss }, "暂时忽略"),
      reason ? h("button", { class: "btn", type: "button", onclick: () => go("#/settings") }, "查看详情")
        : h("button", { class: "btn primary", type: "button", disabled: busy, onclick: async () => {
          try { await installUpdate(); } catch (error) { toast(error.message, true); }
        } }, busy ? (updateLine(u) || "正在更新插件…") : "更新并重启")));
}

/** Whether the reader has text selected inside an element (and so is copying from it). */
function selecting(el) {
  const s = getSelection();
  return !!s && !s.isCollapsed && (el.contains(s.anchorNode) || el.contains(s.focusNode));
}

/** A textarea that grows with its text, up to the CSS max-height. */
function autogrow(area) {
  const fit = () => { area.style.height = "auto"; area.style.height = `${area.scrollHeight}px`; };
  area.addEventListener("input", fit);
  requestAnimationFrame(fit);
  return area;
}

function sendButton(attrs) {
  return h("button", { class: "send", type: "submit", title: "发送", "aria-label": "发送", html: SEND_ICON, ...attrs });
}

/** The screens' type size, the reader's choice, kept in this browser. */
const screenFont = {
  min: 8,
  max: 24,
  normal: 14,
  get size() {
    const saved = Number(localStorage.getItem("broadcast.screenFont"));
    return saved >= this.min && saved <= this.max ? saved : this.normal;
  },
  set size(v) {
    localStorage.setItem("broadcast.screenFont", String(Math.max(this.min, Math.min(this.max, v))));
  },
};

// ---- routing ----------------------------------------------------------------------------

function parseRoute() {
  if (location.hash === "#/settings") return { name: "settings" };
  if (location.hash === "#/machines") return { name: "machines" };
  const match = /^#\/(new|b|e)(?:\/(\d+))?$/.exec(location.hash);
  if (!match) return { name: "home" };
  if (match[1] === "new") return { name: "new" };
  return { name: match[1] === "b" ? "broadcast" : "exec", id: Number(match[2]) };
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route() {
  const r = parseRoute();
  const narrow = matchMedia("(max-width: 820px)").matches;
  // on a phone the list is the home screen; on a desktop the home screen is a new broadcast
  const name = r.name === "home" ? (narrow ? "list" : "new") : r.name;
  document.body.classList.toggle("in-main", name !== "list");
  if (view && view.dispose) view.dispose();
  const main = $("main");
  main.replaceChildren();
  view = name === "new" ? newView(main) : name === "settings" ? settingsView(main) : name === "machines" ? machinesView(main) : name === "broadcast" ? broadcastView(main, r.id, null) : name === "exec" ? broadcastView(main, null, r.id) : null;
  $("new").classList.toggle("current", name === "new");
  $("machines").classList.toggle("current", name === "machines");
  $("settings").classList.toggle("current", name === "settings");
  renderSidebar();
}

function topbar(...children) {
  return h("div", { class: "topbar" }, h("button", { class: "back", onclick: () => go(""), "aria-label": "返回列表" }, "‹ 广播"), ...children);
}

// ---- sidebar, title and notifications ---------------------------------------------------

/** The sidebar's groups, in order: what is running, then what finished, by day. */
function sidebarGroups() {
  const query = $("search").value.trim().toLowerCase();
  const shown = query ? data.state.broadcasts.filter((b) => `${b.title}\n${(b.rounds || []).map(r => r.prompt).join("\n") || b.prompt}`.toLowerCase().includes(query)) : data.state.broadcasts;
  const today = new Date().setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const groups = [["进行中", []], ["今天", []], ["昨天", []], ["7 天内", []], ["更早", []]];
  for (const b of shown) {
    const at = b.latest_at || b.created_at;
    const index = ACTIVE.some((s) => b.counts[s]) ? 0 : at >= today ? 1 : at >= today - day ? 2 : at >= today - 7 * day ? 3 : 4;
    groups[index][1].push(b);
  }
  return { query, shown, groups: groups.filter(([, items]) => items.length) };
}

/** The broadcast the page shows, if any: an agent's link opens its broadcast. */
function currentBroadcastId() {
  const r = parseRoute();
  return r.name === "broadcast" ? r.id : r.name === "exec" ? (findExec(r.id) || { b: {} }).b.id ?? null : null;
}

function renderSidebar() {
  const list = $("list");
  const scroll = list.scrollTop;
  const currentId = currentBroadcastId();
  const { query, shown, groups } = sidebarGroups();
  list.replaceChildren();
  if (loaded && data.state.broadcasts.length === 0) list.append(h("div", { class: "group" }, "还没有广播任务"));
  else if (query && shown.length === 0) list.append(h("div", { class: "group" }, "没有匹配的广播"));
  for (const [title, items] of groups) {
    list.append(h("div", { class: "group" }, title));
    for (const b of items) {
      const waiting = b.counts.uncertain || 0;
      list.append(h("div", { class: "task" },
        h("button", { class: `task-row${currentId === b.id ? " current" : ""}`, onclick: () => go(`#/b/${b.id}`), title: b.title },
          h("span", { class: `dot ${broadcastTone(b)}` }),
          h("span", { class: "t" }, b.title),
          waiting
            ? h("span", { class: "n ask" }, `${b.round_count || 1} 轮 · ${waiting} 个发送结果不确定`)
            : h("span", { class: "n" }, `${b.round_count || 1} 轮 · 已发送 ${(b.counts.sent || 0) + (b.counts.completed || 0)}/${b.total}　${ago(b.latest_at || b.created_at)}`))));
    }
  }
  list.scrollTop = scroll;
  // after J or K: the row moved to stays in sight
  if (revealCurrent) {
    revealCurrent = false;
    const row = list.querySelector(".task-row.current");
    if (row) row.scrollIntoView({ block: "nearest" });
  }
}

/** set by J and K, for the next sidebar drawing */
let revealCurrent = false;
/** Agents waiting for an answer: in the tab's title, and as a notification when the page is not in front. */
const waitingSeen = new Set();
let waitingPrimed = false;

function noticeWaiting() {
  const waiting = [];
  for (const b of data.state.broadcasts) for (const e of b.executions) if (e.state === "blocked") waiting.push({ b, e });
  document.title = waiting.length ? `(${waiting.length}) Herdr 广播` : "Herdr 广播";
  for (const { b, e } of waiting) {
    if (waitingSeen.has(e.id)) continue;
    waitingSeen.add(e.id);
    // the first load is not news
    if (!waitingPrimed || !document.hidden || !("Notification" in window) || Notification.permission !== "granted" || !notifySwitch.on) continue;
    const n = new Notification(`${e.agent_kind || "agent"} 在等你处理`, { body: b.title, tag: `exec-${e.id}` });
    n.onclick = () => { window.focus(); go(`#/e/${e.id}`); n.close(); };
  }
  for (const id of [...waitingSeen]) if (!waiting.some((w) => w.e.id === id)) waitingSeen.delete(id);
  waitingPrimed = true;
}

/**
 * Notifications: the browser's permission, asked once, and on top of it this page's own switch,
 * since a page cannot take a permission back. A whole row while the permission is still to be
 * asked; after that, a bell by the title that turns them off and on.
 */
const notifySwitch = {
  get on() { return localStorage.getItem("broadcast.notify") !== "0"; },
  set on(v) { localStorage.setItem("broadcast.notify", v ? "1" : "0"); },
};

function renderNotify() {
  const button = $("notify");
  const bell = $("bell");
  if (!("Notification" in window)) return;
  const state = Notification.permission;
  const ask = async () => {
    const answer = await Notification.requestPermission();
    if (answer === "granted") { notifySwitch.on = true; toast("已开启通知：agent 等待输入时提醒你"); }
    renderNotify();
  };
  button.hidden = state !== "default";
  button.parentElement.hidden = button.hidden;
  button.textContent = "🔔 开启通知：agent 等待输入时提醒";
  button.onclick = ask;
  bell.hidden = state === "default";
  const on = state === "granted" && notifySwitch.on;
  bell.textContent = on ? "🔔" : "🔕";
  bell.classList.toggle("off", !on);
  bell.setAttribute("aria-pressed", String(on));
  bell.title = state === "denied" ? "浏览器禁止了这个页面的通知" : on ? "通知已开启，点一下关闭" : "通知已关闭，点一下打开";
  bell.setAttribute("aria-label", bell.title);
  bell.onclick = () => {
    if (state === "denied") return toast("浏览器禁止了这个页面的通知：在地址栏左边的网站设置里允许通知，再刷新页面", true);
    notifySwitch.on = !notifySwitch.on;
    toast(notifySwitch.on ? "已开启通知" : "已关闭通知");
    renderNotify();
  };
}

// ---- a new broadcast: centered prompt, then recipient choices ----------------------------

function loadDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}"); } catch { return {}; }
}

/** A broadcast handed over by "再发一次", taken once. */
function takePrefill() {
  const raw = sessionStorage.getItem(PREFILL_KEY);
  sessionStorage.removeItem(PREFILL_KEY);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/** Shared direct-choice picker. Startup commands stay in this view's memory only. */
function newAgentPicker(onChange = () => {}) {
  let disposed = false, locked = false, adding = false, query = 0;
  let machineId = "local", kindId = config.kinds[0];
  let typeShape = "", machineShape = "", folderShape = "";
  const picks = [], directories = new Map(), typeButtons = new Map(), machineButtons = new Map();
  const names = { claude: "Claude Code", codex: "Codex", pi: "Pi", omp: "OMP", opencode: "OpenCode", kimi: "Kimi", agy: "Antigravity", grok: "Grok", qwen: "Qwen", custom: "自定义命令" };
  const marks = { claude: ["✳", "#bb7255"], codex: ["›_", "#557c72"], pi: ["π", "#a87746"], omp: ["o", "#8571a5"], opencode: ["oc", "#627588"], kimi: ["K", "#587bb2"], agy: ["A", "#8c72b1"], grok: ["G", "#706c65"], qwen: ["Q", "#8071b7"], custom: [">_", "#847766"] };
  const nameOf = k => (config.capabilities || []).find(a => a.kind === k)?.name || names[k] || k;
  const machines = () => (data.state?.machines || [{ id: "local", label: "本机", enabled: true }]).filter(m => m.enabled !== false);
  const machineName = id => machines().find(m => m.id === id)?.label || id;
  const types = h("div", { class: "ap-types", role: "group", "aria-label": "Agent 类型" });
  const machineBar = h("div", { class: "ap-machines", role: "group", "aria-label": "运行机器" });
  const folders = h("div", { class: "ap-folders", "aria-label": "常用工作目录" });
  const cwd = h("input", { class: "ap-path-input", placeholder: "输入工作目录，例如 ~/Code/my-project", "aria-label": "新 Agent 工作目录", autocomplete: "off", spellcheck: "false" });
  const suggestions = h("div", { class: "dir-suggestions", hidden: true });
  const count = h("input", { class: "ap-count-input", type: "number", min: "1", max: "20", value: "1", "aria-label": "新增 Agent 数量" });
  const decrease = h("button", { type: "button", "aria-label": "减少新增数量", onclick: () => stepCount(-1) }, "−");
  const increase = h("button", { type: "button", "aria-label": "增加新增数量", onclick: () => stepCount(1) }, "+");
  const label = h("input", { placeholder: "给它起个名字（可选）", "aria-label": "自定义 Agent 名称", maxlength: "120" });
  const command = h("input", { class: "ap-command-input", placeholder: "例如 my-agent --interactive", "aria-label": "自定义启动命令", autocomplete: "off", spellcheck: "false" });
  const custom = h("div", { class: "custom-launch", hidden: true },
    h("div", { class: "ap-custom-fields" }, label, command),
    h("p", { class: "ap-note" }, "自定义命令不提供一键安装会话组件。请在目标机器准备好程序，启动后手动确认，恢复时手动选择历史。启动命令不保存到历史。"));
  const chosen = h("div", { class: "ap-chosen", hidden: true });
  const chosenList = h("div", { class: "ap-chosen-list" });
  const chosenCount = h("span", { class: "ap-chosen-count" });
  chosen.append(h("div", { class: "ap-heading" }, h("span", null, "本轮新增"), chosenCount), chosenList);
  const add = h("button", { class: "btn ap-add", type: "button", onclick: () => addSpec(cwd.value) }, "添加 Agent");

  // Per-machine observations are reused across selection changes; scans never install anything.
  const environments = new Map(), checks = new Map(), observed = new Set(), statusNodes = new Map();
  const selectedInfo = h("div", { class: "ap-agent-context", role: "status" });
  const environmentNote = h("span", { class: "ap-environment-note" });
  const componentSettings = h("button", { class: "ap-environment-action", type: "button", onclick: () => { void openSettings(kindId); } }, "会话组件");
  const inspect = h("button", { class: "ap-environment-action ap-inspect", type: "button", onclick: () => loadEnvironment(machineId, true) }, "重新检查");
  const manage = h("button", { class: "ap-environment-action", type: "button", onclick: () => { void openSettings(); } }, "管理全部 Agent");
  function acceptEnvironment(id, value) {
    if (!value || !Array.isArray(value.agents) || (value.machine && value.machine !== id)) throw new Error("没有收到这台机器的环境检查结果");
    const previous = environments.get(id);
    if (!previous || !value.checkedAt || !previous.checkedAt || value.checkedAt >= previous.checkedAt) environments.set(id, value);
  }
  function loadEnvironment(id, force = false) {
    if (checks.has(id)) return checks.get(id);
    if (!force && environments.has(id)) return Promise.resolve(environments.get(id));
    const work = (async () => {
      try {
        const result = await api(`/api/machines/${encodeURIComponent(id)}/environment`);
        if (!disposed) acceptEnvironment(id, result);
        return result;
      } catch (error) {
        const result = { machine: id, checkedAt: Date.now(), agents: [], error: error.message };
        if (!disposed) environments.set(id, result);
        return result;
      } finally {
        checks.delete(id); if (!disposed) refresh();
      }
    })();
    checks.set(id, work); syncControls();
    return work;
  }
  function statusOf(k) {
    if (k === "custom") return { text: "手动启动与恢复", tone: "manual" };
    if (checks.has(machineId)) return { text: "检查中…", tone: "checking" };
    const snapshot = environments.get(machineId);
    if (!snapshot) return { text: "待检查", tone: "checking" };
    if (snapshot.error) return { text: "无法检查", tone: "unknown" };
    const agent = snapshot.agents.find(a => a.kind === k);
    if (!agent) return { text: "无法检查", tone: "unknown" };
    if (!agent.cli) return { text: "未安装", tone: "missing", agent };
    if (!agent.cliReady) return { text: "无法运行", tone: "missing", agent };
    return { text: agent.ready ? "可用 · 自动识别会话" : "可用 · 手动恢复会话", tone: agent.ready ? "ready" : "manual", agent };
  }
  function openSettings(kind = null, addition = false) {
    const id = machineId;
    return showAgentPreparation({ ...machines().find(m => m.id === id), id, label: machineName(id) }, environments.get(id) || null, {
      kind, addition, onUpdate: snapshot => { if (!disposed) { acceptEnvironment(id, snapshot); refresh(); } },
    });
  }
  function renderEnvironment() {
    for (const [k, node] of statusNodes) {
      const status = statusOf(k);
      node.textContent = status.text; node.className = `ap-type-status ${status.tone}`;
      typeButtons.get(k)?.setAttribute("aria-description", `${machineName(machineId)} · ${status.text}`);
    }
    const status = statusOf(kindId), current = environments.get(machineId);
    inspect.disabled = locked || adding || checks.has(machineId);
    inspect.textContent = checks.has(machineId) ? "检查中…" : "重新检查";
    manage.disabled = locked || adding;
    environmentNote.textContent = checks.has(machineId) ? "正在检查程序…" : current?.error ? "检查失败，请重试" : "";
    environmentNote.hidden = !environmentNote.textContent;
    componentSettings.hidden = kindId === "custom" || !status.agent?.cliReady || status.agent.ready;
    componentSettings.disabled = locked || adding;
    componentSettings.textContent = `设置 ${nameOf(kindId)}`;
    componentSettings.setAttribute("aria-label", `设置 ${nameOf(kindId)} 的会话组件`);
    const message = status.tone === "unknown" ? `暂时无法检查 ${nameOf(kindId)}，请重新检查。`
      : status.agent && !status.agent.cli ? `${machineName(machineId)} 尚未安装 ${nameOf(kindId)}。`
      : status.agent && !status.agent.cliReady ? `${nameOf(kindId)} 暂时无法运行，请检查运行环境。` : "";
    const action = status.agent && !status.agent.cliReady
      ? h("button", { class: "ap-environment-action", type: "button", disabled: locked || adding, onclick: () => { void openSettings(kindId); } }, "查看安装步骤") : null;
    selectedInfo.hidden = !message;
    selectedInfo.replaceChildren(...[message ? h("p", null, message) : null, action].filter(Boolean));
    // Known missing programs stay inspectable, but cannot be added accidentally.
    if (kindId !== "custom" && (status.tone === "checking" || status.tone === "unknown" || !status.agent?.cliReady)) add.disabled = true;
  }

  function syncControls() {
    const disabled = locked || adding;
    for (const input of [cwd, count, label, command, add]) input.disabled = disabled;
    decrease.disabled = disabled || Number(count.value) <= 1;
    increase.disabled = disabled || Number(count.value) >= 20;
    for (const [k, button] of typeButtons) { button.disabled = disabled; button.setAttribute("aria-pressed", String(k === kindId)); button.classList.toggle("selected", k === kindId); }
    for (const [id, button] of machineButtons) { button.disabled = disabled; button.setAttribute("aria-pressed", String(id === machineId)); button.classList.toggle("selected", id === machineId); }
    custom.hidden = kindId !== "custom";
    for (const button of folders.querySelectorAll("button")) button.disabled = disabled || (kindId !== "custom" && !statusOf(kindId).agent?.cliReady);
    renderEnvironment();
  }
  function stepCount(delta) {
    if (locked || adding) return;
    count.value = String(Math.max(1, Math.min(20, (Number(count.value) || 1) + delta))); syncControls();
  }
  count.addEventListener("input", syncControls);
  function hideSuggestions() { ++query; suggestions.replaceChildren(); suggestions.hidden = true; }
  function chooseFolder(path) {
    if (locked || adding) return;
    cwd.value = path; directories.set(machineId, path); hideSuggestions(); renderFolders();
  }
  cwd.addEventListener("input", async () => {
    directories.set(machineId, cwd.value); hideSuggestions(); renderFolders();
    const seq = query, machine = machineId;
    if (machine !== "local" || !cwd.value.trim()) return;
    try {
      const result = await api(`/api/dirs?machine=local&q=${encodeURIComponent(cwd.value)}`);
      if (disposed || locked || seq !== query || machine !== machineId) return;
      const items = (result.suggestions || []).slice(0, 6);
      suggestions.replaceChildren(...items.map(dir => h("button", { class: "ap-suggestion", type: "button", onclick: () => chooseFolder(dir.value) }, dir.value)));
      suggestions.hidden = !items.length;
    } catch { /* A typed path remains usable without suggestions. */ }
  });
  function renderFolders() {
    const group = data.agents.find(g => g.machine.id === machineId);
    const items = (group?.folders || []).slice(0, 5);
    const shape = JSON.stringify([machineId, kindId, cwd.value, items]);
    if (shape === folderShape) return;
    folderShape = shape;
    folders.replaceChildren(...items.map(f => h("div", { class: "ap-folder" },
      h("button", { class: `ap-folder-choice${cwd.value === f.path ? " selected" : ""}`, type: "button", title: f.path, "aria-label": `选择目录 ${f.path}`, "aria-pressed": String(cwd.value === f.path), onclick: () => chooseFolder(f.path) },
        h("span", { class: "ap-folder-icon", "aria-hidden": "true" }, "↳"), h("span", { class: "ap-folder-name" }, f.name || baseName(f.path)), h("span", { class: "ap-folder-path" }, f.display || f.path)),
      h("button", { class: "ap-folder-add", type: "button", "aria-label": `在 ${f.path} 添加 ${nameOf(kindId)}`, title: `添加 ${nameOf(kindId)}`, onclick: () => addSpec(f.path) }, "+"))));
    folders.hidden = !items.length; syncControls();
  }
  function renderChosen() {
    chosen.hidden = !picks.length;
    chosenCount.textContent = `${picks.reduce((n, p) => n + p.count, 0)} 个 Agent`;
    chosenList.replaceChildren(...picks.map((p, i) => h("div", { class: "ap-pick" },
      h("span", { class: "ap-pick-mark", "aria-hidden": "true" }, marks[p.kind]?.[0] || p.kind[0]),
      h("div", { class: "ap-pick-info" }, h("strong", null, p.label || nameOf(p.kind)), h("span", { title: p.cwd }, `${machineName(p.machine)} / ${p.cwd}`)),
      h("div", { class: "ap-stepper ap-pick-stepper" },
        h("button", { type: "button", disabled: locked || p.count <= 1, "aria-label": `减少 ${p.label || nameOf(p.kind)}`, onclick: () => { if (!locked && p.count > 1) { p.count--; renderChosen(); } } }, "−"),
        h("span", { class: "ap-pick-number" }, String(p.count)),
        h("button", { type: "button", disabled: locked || p.count >= 20, "aria-label": `增加 ${p.label || nameOf(p.kind)}`, onclick: () => { if (!locked && p.count < 20) { p.count++; renderChosen(); } } }, "+")),
      h("button", { class: "ap-pick-remove", type: "button", disabled: locked, "aria-label": "移除新增 Agent", onclick: () => { if (!locked) { picks.splice(i, 1); renderChosen(); } } }, "×"))));
    onChange();
  }
  async function addSpec(path) {
    if (locked || adding || disposed) return;
    const spec = { machine: machineId, kind: kindId, cwd: path.trim(), count: Number(count.value) };
    if (!spec.cwd) { cwd.focus(); return toast("请先填写工作目录", true); }
    if (!Number.isInteger(spec.count) || spec.count < 1 || spec.count > 20) { count.focus(); return toast("数量必须是 1 到 20 的整数", true); }
    if (spec.kind === "custom") {
      if (!command.value.trim() || /[\x00\r\n]/.test(command.value)) { command.focus(); return toast("请填写单行启动命令", true); }
      spec.command = command.value; if (label.value.trim()) spec.label = label.value.trim();
    }
    adding = true; syncControls();
    try {
      if (spec.kind !== "custom") {
        const environment = await loadEnvironment(spec.machine, true);
        if (disposed || locked) return;
        if (environment.error) return toast("无法确认程序是否可用，请重新检查", true);
        const agent = environment.agents.find(a => a.kind === spec.kind);
        if (!agent?.cliReady) { openSettings(spec.kind); return; }
        if (!agent.ready && !await openSettings(spec.kind, true)) return;
      }
      if (disposed || locked) return;
      const same = picks.find(p => p.machine === spec.machine && p.kind === spec.kind && p.cwd === spec.cwd && p.command === spec.command && p.label === spec.label);
      if (same && same.count + spec.count > 20) return toast("同一组最多添加 20 个 Agent", true);
      if (same) same.count += spec.count; else picks.push(spec);
      command.value = ""; renderChosen();
    } catch (error) { if (!disposed) toast(error.message, true); }
    finally { adding = false; syncControls(); }
  }
  const stepTitle = (number, title) => h("span", { class: "ap-step-title" }, h("span", { class: "ap-step-number", "aria-hidden": "true" }, number), title);
  const el = h("section", { class: "new-agent-picker", "aria-label": "新增 Agent", onkeydown: event => { if (event.key === "Enter" && event.target.tagName === "INPUT") event.preventDefault(); } },
    h("div", { class: "ap-target" }, h("div", { class: "ap-heading" }, stepTitle("1", "运行机器"), h("div", { class: "ap-environment-actions" }, inspect, manage)), machineBar, environmentNote),
    h("div", { class: "ap-heading" }, stepTitle("2", "选择 Agent"), componentSettings), types, selectedInfo, custom,
    h("div", { class: "ap-destination" }, h("div", { class: "ap-heading" }, stepTitle("3", "设置启动位置与数量")), folders,
      h("div", { class: "ap-launch-fields" },
        h("div", { class: "ap-directory-field" }, h("label", { class: "ap-field-label" }, "工作目录", cwd), suggestions),
        h("div", { class: "ap-quantity-field" }, h("span", { class: "ap-field-label" }, "数量"),
          h("div", { class: "ap-stepper", "aria-label": "本次添加数量" }, decrease, count, increase)), add)), chosen);
  function refresh() {
    for (const snapshot of data.environments || []) { if (snapshot.machine) acceptEnvironment(snapshot.machine, snapshot); }
    const catalog = [...config.kinds, "custom"];
    if (!catalog.includes(kindId)) kindId = catalog[0];
    const nextTypes = JSON.stringify(catalog.map(k => [k, nameOf(k)]));
    if (nextTypes !== typeShape) {
      typeShape = nextTypes; typeButtons.clear(); statusNodes.clear();
      types.replaceChildren(...catalog.map(k => {
        const status = h("span", { class: "ap-type-status" }); statusNodes.set(k, status);
        const button = h("button", { class: "ap-type", type: "button", "aria-label": k === "custom" ? "选择自定义命令" : `选择 ${nameOf(k)}`, onclick: () => { if (locked || adding) return; kindId = k; syncControls(); renderFolders(); } },
          h("span", { class: "ap-type-mark", style: `--agent-color:${marks[k]?.[1] || "#777"}`, "aria-hidden": "true" }, marks[k]?.[0] || k[0]), h("span", { class: "ap-type-copy" }, h("span", null, nameOf(k)), status));
        typeButtons.set(k, button); return button;
      }));
    }
    const available = machines();
    if (!available.some(m => m.id === machineId)) { machineId = available[0]?.id || "local"; cwd.value = directories.get(machineId) || ""; hideSuggestions(); }
    const nextMachines = JSON.stringify(available.map(m => [m.id, m.label]));
    if (nextMachines !== machineShape) {
      machineShape = nextMachines; machineButtons.clear();
      machineBar.replaceChildren(...available.map(m => {
        const button = h("button", { class: "ap-machine", type: "button", "aria-label": `选择机器 ${m.label}`, onclick: () => {
          if (locked || adding || machineId === m.id) return;
          directories.set(machineId, cwd.value); machineId = m.id; cwd.value = directories.get(m.id) || "";
          hideSuggestions(); syncControls(); renderFolders(); observed.add(machineId); void loadEnvironment(machineId, true);
        } }, h("span", { class: "ap-machine-icon", "aria-hidden": "true" }, m.id === "local" ? "▣" : "↗"), m.label);
        machineButtons.set(m.id, button); return button;
      }));
    }
    syncControls(); renderFolders();
    if (!observed.has(machineId)) { observed.add(machineId); void loadEnvironment(machineId, true); }
  }
  refresh();
  return { el, specs: () => picks.map(p => ({ ...p })), count: () => picks.reduce((n, p) => n + p.count, 0), refresh,
    clear() { picks.length = 0; renderChosen(); },
    prefill(specs) { picks.push(...specs.filter(p => p.kind !== "custom").map(p => ({ ...p }))); renderChosen(); },
    lock(value) { locked = value; syncControls(); renderChosen(); },
    dispose() { disposed = true; ++query; picks.length = 0; command.value = ""; } };
}

function newView(main) {
  let submitting = false, disposed = false;
  const prefill = takePrefill();
  const draft = prefill || loadDraft();
  let picker;
  const title = h("input", { class: "title-input", value: draft.title || "", placeholder: "标题（默认取输入第一行）", "aria-label": "广播标题", oninput: () => saveDraft() });
  const prompt = h("textarea", { class: "prompt", rows: "4", "aria-label": "广播内容", placeholder: "要广播什么？", oninput: () => { saveDraft(); updateComposer(); }, onkeydown: e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); }
  } });
  prompt.value = draft.prompt || "";
  const send = sendButton({ type: "button", onclick: () => submit() });
  const hint = h("span", { class: "hint" });
  picker = newAgentPicker(updateComposer);
  if (prefill?.fresh) picker.prefill(prefill.fresh);
  function saveDraft() { localStorage.setItem(DRAFT_KEY, JSON.stringify({ title: title.value, prompt: prompt.value })); }
  function updateComposer() {
    send.disabled = submitting || !picker?.count() || !prompt.value.trim();
    hint.textContent = picker?.count() ? `新建 ${picker.count()} 个 Agent · Enter 发送，Shift+Enter 换行` : "添加要新建的 Agent";
  }
  async function submit() {
    if (submitting || disposed || !picker.count() || !prompt.value.trim()) return;
    submitting = true; prompt.disabled = title.disabled = true; picker.lock(true); updateComposer();
    const submittedDraft = localStorage.getItem(DRAFT_KEY);
    try {
      const result = await post("/api/broadcasts", { title: title.value, prompt: prompt.value, new: picker.specs() });
      if (disposed) return;
      if (localStorage.getItem(DRAFT_KEY) === submittedDraft) localStorage.removeItem(DRAFT_KEY);
      go(`#/b/${result.id}`);
    } catch (error) { if (!disposed) toast(error.message, true); }
    finally { submitting = false; if (!disposed) { prompt.disabled = title.disabled = false; picker.lock(false); updateComposer(); } }
  }
  main.append(topbar(h("span", { class: "title" }, "新建广播")), h("div", { class: "scroll new-scroll" }, h("div", { class: "column new-column" },
    h("div", { class: "new-hero" }, h("h1", { class: "hero" }, "要广播什么？"), h("p", { class: "hero-sub" }, "一个任务，多轮协作。新建 Agent 开始第一轮。")),
    h("div", { class: "composer" }, title, prompt, h("div", { class: "composer-foot" }, hint, send)), picker.el)));
  updateComposer(); prompt.focus();
  return { update() { picker.refresh(); updateComposer(); }, dispose() { disposed = true; picker.dispose(); } };
}


// ---- settings: one home for plugin updates and the web service ---------------------------

function settingsView(main) {
  const about = h("section", { class: "about", "aria-label": "插件版本" });
  const restart = h("button", { class: "btn", type: "button", disabled: !config.local, onclick: async () => {
    restart.disabled = true;
    try {
      const result = await post("/api/web/restart");
      data.update = result.update;
      if (result.operationId) watchUpdateOperation(result.operationId, result.instance);
      else waitForRestart(result.instance);
    } catch (error) { toast(error.message, true); restart.disabled = false; }
  } }, "重启服务");
  main.append(topbar(h("span", { class: "title" }, "设置")),
    h("div", { class: "scroll" }, h("div", { class: "column settings-column" },
      h("h1", { class: "settings-title" }, "设置"),
      h("p", { class: "sub" }, "管理广播插件的版本和网页服务。"),
      h("h2", { class: "settings-heading" }, "插件版本"), about,
      h("h2", { class: "settings-heading" }, "网页服务"),
      h("section", { class: "service-panel" },
        h("div", null, h("strong", null, "重启广播服务"),
          h("p", { class: "sub" }, "使用当前运行版本重启。页面会自动恢复连接，agent 的任务继续执行。")), restart),
      !config.local ? h("p", { class: "sub" }, "检查、更新和重启请在运行广播服务的电脑上操作。") : null,
      h("details", { class: "service-help" }, h("summary", null, "网页打不开时如何重启？"),
        h("p", null, "在 Herdr 的动作菜单中选择「Broadcast: 重启服务」，或在服务所在电脑的终端运行："),
        h("code", null, `herdr plugin action invoke ${config.pluginId || "herdr-broadcast"}.web-restart`)))));
  /** the plugin's own version, and updating it */
  let checkingUpdate = false;
  function renderAbout() {
    const u = data.update;
    const shape = JSON.stringify([u, checkingUpdate, updateInstalling, config.local]);
    if (about.dataset.shape === shape) return;
    about.dataset.shape = shape;
    if (!u) { about.replaceChildren(h("span", null, "Broadcast 插件"), h("span", { class: "about-state" }, "正在读取版本…")); return; }
    const line = updateLine(u);
    const state = u.phase === "checking" || checkingUpdate ? ["", "正在检查更新…"]
      : ["updating", "restarting"].includes(u.phase) ? ["", line]
      : u.phase === "error" ? ["bad", line]
      : !canUpdatePlugin(u) ? ["", ""]
      : u.available ? ["new", u.blocked_reason ? `${line}：${u.blocked_reason}` : line]
      : u.blocked_reason ? ["", u.blocked_reason]
      : u.checked_at ? ["", `暂无可升级的正式版本（${ago(u.checked_at)}检查）`] : ["", "还没有检查过更新"];
    const busy = checkingUpdate || updateInstalling || ["checking", "updating", "restarting"].includes(u.phase);
    restart.disabled = busy || !config.local;
    const where = !config.local ? "在这台电脑本机的浏览器里打开本页即可检查和更新" : null;
    const check = canUpdatePlugin(u) ? h("button", { class: "btn quiet", type: "button", disabled: busy || !config.local, title: where, onclick: async () => {
      checkingUpdate = true; renderAbout();
      try { data.update = (await post("/api/update/check")).update; } catch (error) { toast(error.message, true); }
      finally { checkingUpdate = false; renderAbout(); renderUpdate(); }
    } }, "检查更新") : null;
    const install = canUpdatePlugin(u) && u.available && !u.blocked_reason && config.local
      ? confirmButton("更新并重启", "再点一次：更新并重启网页", installUpdate, { class: "btn primary", disabled: busy })
      : null;
    // replaceChildren keeps no `null`, as `h()` does: absent children are left out, not printed
    about.replaceChildren(...[h("span", null, "Broadcast 运行版本"), h("span", { class: "about-version" }, versionText(u.current_version, u.current_revision)),
      canUpdatePlugin(u) && u.source_revision && u.source_revision !== u.current_revision ? h("span", { class: "sub" }, `已安装版本：${versionText(u.source_version, u.source_revision)}`) : null,
      state[1] ? h("span", { class: `about-state${state[0] ? ` ${state[0]}` : ""}`, title: u.error || u.blocked_reason || null }, state[1]) : null,
      h("span", { class: "spacer" }), check, install].filter(Boolean));
  }

  renderAbout();
  return { update: renderAbout };
}

// ---- machines: Herdr's saved SSH machines, and adding one ---------------------------------

function showAgentPreparation(machine, initial = null, options = {}) {
  const scopeKind = options.kind || null;
  const addition = !!options.addition && !!scopeKind;
  let acceptAddition = false, finish;
  const result = new Promise(resolve => { finish = resolve; });
  const scopeName = initial?.agents?.find(a => a.kind === scopeKind)?.name || (config.capabilities || []).find(a => a.kind === scopeKind)?.name || scopeKind;
  const dialog = h("dialog", { class: `agent-preparation${addition ? " prep-addition" : !scopeKind ? " prep-manager" : ""}`, "aria-label": `${addition ? `添加 ${scopeName}` : scopeKind ? `设置 ${scopeName}` : "准备 Agent"} · ${machine.label}` });
  const content = h("div", { class: "prep-content" });
  const footer = h("footer", { class: "prep-footer" });
  let snapshot = initial, operation = (data.environmentOperations || []).filter(o => o.machine === machine.id).at(-1);
  let busy = false, closed = false, prerequisitesOpen = !!scopeKind, readyOpen = false, pollError = "", timer;
  const selected = new Set();
  let selectionInitialized = false;
  const visibleAgents = () => (snapshot?.agents || []).filter(a => !scopeKind || a.kind === scopeKind);
  const close = () => dialog.close();
  const installable = a => !a.ready && a.cliReady && a.configReady && ["missing", "outdated"].includes(a.integrationState);
  const check = async () => {
    busy = true; render();
    try { snapshot = await api(`/api/machines/${encodeURIComponent(machine.id)}/environment`); if (!closed) options.onUpdate?.(snapshot); }
    catch (error) { snapshot = { agents: [], error: error.message }; }
    finally { busy = false; if (!closed) render(); }
  };
  const poll = async () => {
    if (closed || !operation || operation.state !== "running") return;
    clearTimeout(timer);
    try { operation = (await api(`/api/environment-operations/${operation.id}`)).operation; pollError = ""; }
    catch (error) { pollError = error.message; if (!closed) render(); return; }
    if (closed) return;
    if (operation.state === "running") { render(); timer = setTimeout(poll, 1000); }
    else await check();
  };
  const prepare = async () => {
    if (busy || operation?.state === "running" || !selected.size || !config.local) return;
    busy = true; render();
    try { operation = (await post(`/api/machines/${encodeURIComponent(machine.id)}/prepare-agents`, { integrations: [...selected] })).operation; }
    catch (error) { if (!closed) toast(error.message, true); }
    finally { busy = false; if (!closed) { render(); void poll(); } }
  };
  const recheck = h("button", { class: "btn prep-recheck", type: "button", onclick: check }, "重新检查");
  function syncFooter() {
    const running = operation?.state === "running";
    const hint = !config.local ? "请在运行广播服务的电脑上安装组件。" : running ? "关闭窗口后，安装会在后台继续。"
      : busy ? "正在检查，请稍候…" : selected.size ? `将在 ${machine.label} 为 ${selected.size} 个 Agent 安装或更新会话组件。`
      : visibleAgents().some(installable) ? `选择要在 ${machine.label} 安装或更新的会话组件。`
      : scopeKind && !visibleAgents().some(a => a.cliReady) ? "请先按指引准备好程序，再重新检查。" : `${machine.label} · 会话组件按机器独立配置`;
    if (addition) {
      const agent = visibleAgents()[0];
      const canContinue = !busy && !running && !snapshot?.error && !!agent?.cliReady;
      const proceed = () => { if (canContinue) { acceptAddition = true; close(); } };
      footer.replaceChildren(...[
        !config.local || running || busy ? h("p", { class: "prep-footer-hint", role: "status" }, hint) : null,
        h("div", { class: "prep-footer-actions" },
          h("button", { class: `btn${agent?.ready ? " primary" : ""}`, type: "button", disabled: !canContinue, onclick: proceed }, agent?.ready ? "添加 Agent" : "暂不安装，继续添加"),
          !agent?.ready ? h("button", { class: "btn primary", type: "button", disabled: busy || running || !selected.size || !config.local, onclick: prepare }, agent?.integrationState === "outdated" ? "更新会话组件" : "安装会话组件") : null),
      ].filter(Boolean));
    } else footer.replaceChildren(h("p", { class: "prep-footer-hint", role: "status" }, hint),
      h("div", { class: "prep-footer-actions" },
        h("button", { class: "btn", type: "button", onclick: close }, running ? "关闭，后台继续" : "关闭"),
        ...(visibleAgents().some(installable) || running ? [h("button", { class: "btn primary", type: "button", disabled: busy || running || !selected.size || !config.local, onclick: prepare }, selected.size ? `安装所选组件（${selected.size}）` : "安装所选组件")] : [])));
    recheck.disabled = busy || running;
    recheck.textContent = busy ? "检查中…" : "重新检查";
  }
  function agentRow(a, mode) {
    const pending = mode === "installable";
    const state = pending ? a.integrationState === "outdated" ? "组件待更新" : "组件待安装"
      : a.ready ? "已就绪" : !a.cli ? "未安装程序" : !a.cliReady ? "程序需处理" : !a.configReady ? "需要初始化" : "需要检查";
    const hint = pending ? a.integrationState === "outdated" ? "程序可用，可按需更新会话识别组件。" : "程序可用。配置会话识别可帮助找回原对话；未配置也能发送广播。"
      : a.ready ? "程序可用，会话识别已配置，无需重复设置。"
      : !a.cli ? `先在这台机器安装 ${a.name}，然后重新检查。`
      : !a.cliReady ? (a.reason || "程序无法运行，请检查安装和运行环境。").replace(/\bCLI\b/g, "程序")
      : !a.configReady ? `先在这台机器启动一次 ${a.name}，完成初始化后重新检查。`
      : "无法确认会话组件状态，请重新检查 Herdr 版本与配置。";
    const name = h("strong", null, a.name);
    const identity = pending ? h("label", { class: "prep-agent-choice" },
      h("input", { type: "checkbox", "aria-label": `选择 ${a.name}`, checked: selected.has(a.integration), disabled: busy || operation?.state === "running" || !config.local,
        onchange: event => { if (event.target.checked) selected.add(a.integration); else selected.delete(a.integration); syncFooter(); } }), name) : name;
    return h("article", { class: `prep-agent ${pending ? "actionable" : a.ready ? "ready" : "prerequisite"}` },
      h("div", { class: "prep-agent-top" }, identity, h("span", { class: `prep-badge ${pending ? "pending" : a.ready ? "ready" : "muted"}` }, state)),
      scopeKind || mode === "prerequisite" ? h("p", { class: "prep-agent-hint" }, hint) : null,
      mode === "prerequisite" ? h("a", { class: "prep-guide-link", href: a.guide, target: "_blank", rel: "noopener noreferrer" }, !a.cli ? `安装 ${a.name} ↗` : "查看设置指引 ↗") : null,
      a.configDir || a.version ? h("details", { class: "prep-agent-details" }, h("summary", { "aria-label": `查看 ${a.name} 的版本与配置` }, !scopeKind && a.version ? `${a.version} · 版本与配置` : "版本与配置"),
        a.version ? h("div", null, h("span", null, "程序版本"), h("code", null, a.version)) : null,
        a.configDir ? h("div", null, h("span", null, "配置目录"), h("code", null, a.configDir)) : null) : null);
  }
  function render() {
    const agents = visibleAgents();
    const actionable = agents.filter(installable), ready = agents.filter(a => a.ready), prerequisites = agents.filter(a => !a.ready && !installable(a));
    if (scopeKind && snapshot && !selectionInitialized) {
      selectionInitialized = true; for (const a of actionable) selected.add(a.integration);
    }
    for (const name of selected) if (!actionable.some(a => a.integration === name)) selected.delete(name);
    content.replaceChildren();
    if (snapshot?.error) content.append(h("div", { class: "prep-error", role: "alert" }, h("strong", null, "检查失败"), h("p", null, snapshot.error), h("p", null, "请确认机器连接正常，再点击右上角重新检查。")));
    else if (!snapshot) content.append(h("p", { class: "prep-loading", role: "status" }, "正在检查这台机器上的 Agent…"));
    else {
      if (addition) content.append(h("div", { class: "prep-add-benefits" },
        h("p", null, ready.length ? "会话组件已就绪，可以添加 Agent。" : "不安装也能添加；之后恢复原对话时，需要手动选择历史。"),
        h("p", { class: "prep-add-alternative" }, "仅安装 Herdr 会话组件，不安装 Agent 程序、依赖或模型账号。")));
      if (actionable.length && !addition) content.append(h("section", { class: "prep-installable" }, h("div", { class: "prep-section-heading" }, h("h3", null, scopeKind ? "配置会话识别" : `可安装或更新 · ${actionable.length}`),
        !scopeKind ? h("button", { class: "ap-environment-action", type: "button", disabled: busy || operation?.state === "running" || !config.local, onclick: () => {
          const all = actionable.every(a => selected.has(a.integration));
          for (const a of actionable) { if (all) selected.delete(a.integration); else selected.add(a.integration); } render();
        } }, actionable.every(a => selected.has(a.integration)) ? "取消全选" : "全选可配置项") : null), h("div", { class: "prep-list" }, actionable.map(a => agentRow(a, "installable")))));
      if (ready.length && !addition) content.append(scopeKind
        ? h("section", { class: "prep-ready" }, h("div", { class: "prep-section-heading" }, h("h3", null, "已就绪"), h("span", null, "无需操作")), ready.map(a => agentRow(a, "ready")))
        : h("details", { class: "prep-ready prep-group", open: readyOpen, ontoggle: event => { readyOpen = event.target.open; } },
          h("summary", null, h("strong", null, `已就绪 · ${ready.length}`), h("span", null, "无需重复安装")), h("div", { class: "prep-list" }, ready.map(a => agentRow(a, "ready")))));
      if (prerequisites.length) content.append(h("details", { class: "prep-prerequisites prep-group", open: prerequisitesOpen, ontoggle: event => { prerequisitesOpen = event.target.open; } },
        h("summary", null, h("strong", null, `需先处理 · ${prerequisites.length}`), h("span", null, "先安装程序或完成初始化")), h("div", { class: "prep-list" }, prerequisites.map(a => agentRow(a, "prerequisite")))));
      if (!agents.length) content.append(h("p", { class: "prep-loading" }, "暂无检查结果，请重新检查。"));
    }
    if (addition && (snapshot?.error || agents.some(a => !a.ready && !installable(a)))) content.append(recheck);
    if (!scopeKind) content.append(h("details", { class: "prep-custom-note" }, h("summary", null, "自定义命令如何配置？"),
      h("p", null, "自定义命令不提供一键安装会话组件；请自行准备程序，启动后手动确认，恢复时手动选择历史。")));
    const items = (operation?.items || []).filter(i => (!scopeKind || agents.some(a => a.integration === i.integration))
      && (operation.state === "running" || i.state !== "ready"));
    if (operation && operation.state !== "done" && (operation.state === "running" || items.length)) {
      const labels = { pending: "等待安装", checking: "检查中", installing: "安装中", ready: "已完成", failed: "安装失败", cancelled: "已取消" };
      const title = { running: "正在安装会话组件", failed: "部分组件安装失败", cancelled: "安装已取消", interrupted: "上次安装中断，请重新检查" }[operation.state] || "安装进度";
      content.prepend(h("section", { class: "environment-progress", role: "status" },
        h("strong", null, items.length ? `${machine.label} · ${title}` : "这台机器正在处理其他 Agent，请在全部管理中查看进度。"),
        items.map(i => h("div", { class: "prep-progress-item" }, h("span", null, agents.find(a => a.integration === i.integration)?.name || i.integration), h("span", null, labels[i.state] || i.state), i.reason ? h("p", null, i.reason) : null)),
        pollError ? h("p", { class: "prep-error", role: "alert" }, `暂时无法获取进度：${pollError}`, h("button", { class: "btn", type: "button", onclick: poll }, "重试获取进度")) : null,
        operation.state === "running" && (!scopeKind || items.length) ? h("button", { class: "btn", type: "button", disabled: busy || !config.local, onclick: async () => {
          busy = true; render();
          try { await api(`/api/environment-operations/${operation.id}`, { method: "DELETE" }); }
          catch (error) { if (!closed) toast(error.message, true); }
          finally { busy = false; if (!closed) render(); }
        } }, "取消安装") : null));
    }
    syncFooter();
  }
  dialog.append(h("header", { class: "prep-header" },
    h("div", { class: "prep-title-row" }, h("div", { class: "prep-title" }, h("span", { class: "prep-machine" }, "会话组件 · 按机器配置"),
      h("h2", null, scopeKind ? `${machine.label} · ${scopeName}` : `${machine.label} 的 Agent 组件`),
      machine.target ? h("code", { class: "prep-machine-address" }, machine.target) : null),
      h("button", { class: "prep-close", type: "button", "aria-label": "关闭准备 Agent", onclick: close }, "×")),
    h("div", { class: "prep-toolbar" }, h("p", { class: "prep-intro" }, addition ? `组件将安装在 ${machine.label}，用于自动识别会话、找回原对话。`
      : "每台机器独立配置，组件用于自动识别并找回原对话。"), !addition ? recheck : null),
    scopeKind && !addition ? h("button", { class: "ap-environment-action prep-show-all", type: "button", onclick: () => { close(); showAgentPreparation(machine, snapshot, { onUpdate: options.onUpdate }); } }, "查看全部 Agent") : null), content, footer);
  document.body.append(dialog);
  dialog.addEventListener("close", () => { closed = true; clearTimeout(timer); dialog.remove(); finish(acceptAddition); });
  render(); dialog.showModal(); if (!initial) void check(); if (operation?.state === "running") void poll();
  return result;
}

/** Two Herdr versions alike (`herdr 0.9.5`): what `herdr machine add` asks of a server. */
function sameHerdr(remote, local) {
  const v = (s) => (s ? (/\d+\.\d+\.\d+[\w.-]*/.exec(s) || [s])[0] : null);
  return !!remote && (!local || v(remote) === v(local));
}

/**
 * An address as typed or pasted, in the form's three fields: `user@host` (or a Host from
 * ~/.ssh/config), the port, and a key. Takes `user@host:2222`, `ssh://user@host:2222`,
 * `user@[::1]:2222` and a whole command, `ssh -p 2222 -i ~/.ssh/x.pem user@host`.
 */
function splitAddress(input) {
  let text = String(input || "").trim();
  let port = "";
  let key = "";
  if (/^ssh\s/.test(text)) {
    const words = text.split(/\s+/).slice(1);
    let dest = "";
    let user = "";
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (word === "-p" || word === "-i" || word === "-l") {
        const value = words[++i] || "";
        if (word === "-p") port = value;
        else if (word === "-i") key = value;
        else user = value;
      } else if (/^-p\d+$/.test(word)) port = word.slice(2);
      else if (/^-[oFJLRDWwbcemOQSB]$/.test(word)) i++; // an option and its value: not the address
      else if (!word.startsWith("-") && !dest) dest = word;
    }
    text = dest && user && !dest.includes("@") ? `${user}@${dest}` : dest;
  }
  text = text.replace(/^ssh:\/\//, "").replace(/\/+$/, "");
  const at = text.lastIndexOf("@");
  const who = text.slice(0, at + 1);
  let host = text.slice(at + 1);
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
  if (bracket) {
    host = bracket[1];
    port = bracket[2] || port;
  } else if (host.indexOf(":") > 0 && host.indexOf(":") === host.lastIndexOf(":")) {
    port = host.slice(host.indexOf(":") + 1) || port;
    host = host.slice(0, host.indexOf(":"));
  }
  return { address: who + host, port: port === "22" ? "" : port, key };
}

/** One of ssh's own keys (~/.ssh/id_rsa, id_ed25519…): ssh tries it by itself, no Host entry needed. */
const defaultKey = (path) => /^(~|\/(Users|home)\/[^/]+)\/\.ssh\/id_(rsa|ecdsa|ecdsa_sk|ed25519|ed25519_sk|dsa)$/.test(String(path || "").trim());

/** The address the server takes, from the form's fields: an IPv6 host in brackets. */
function joinAddress(address, port) {
  const parts = splitAddress(address);
  const p = String(port || "").trim() || parts.port;
  const at = parts.address.lastIndexOf("@");
  const host = parts.address.slice(at + 1);
  const where = host.includes(":") ? `[${host}]` : host;
  return `${parts.address.slice(0, at + 1)}${where}${p && p !== "22" ? `:${p}` : ""}`;
}

/** Text with a copy button beside it: a public key, a command to run elsewhere. */
function copyBlock(text, label) {
  return h("div", { class: "copy-block" },
    h("pre", null, text),
    h("button", { class: "btn", type: "button", onclick: async () => {
      try { await navigator.clipboard.writeText(text); toast(`已复制${label}`); } catch { toast("复制失败：请手动选中复制", true); }
    } }, "复制"));
}

/**
 * The machines Herdr knows, with how each is doing, and a wizard that adds one without ever
 * asking for a password: address, host key, this computer's public key put on the server by
 * the user, a check that logging in needs nothing more, then `herdr machine add`.
 */
function machinesView(main) {
  let connectionHelp = null;
  try { connectionHelp = JSON.parse(sessionStorage.getItem("broadcast.connection-settings") || "null"); } catch { /* no saved context */ }
  sessionStorage.removeItem("broadcast.connection-settings");
  // the machines first: what Herdr has and whether it answers. Adding one is a small form
  // above the list, folded away once there are machines.
  const list = h("div", { class: "panel mlist" });
  const healthNote = h("span", { class: "health-note" });
  const wizardBox = h("div");
  const importBox = h("div", { class: "import-note", hidden: true });
  // herdr-web-ui is optional: without it each machine opens in Herdr only, and this says how to get it
  const webUiTip = h("p", { class: "webui-tip", hidden: true });
  let adding = false;
  const addBtn = h("button", { class: "btn quiet", type: "button", onclick: () => showAdd(!adding) }, "+ 添加");
  const addPanel = h("section", { class: "add-panel", hidden: true },
    h("div", { class: "add-head" }, h("span", null, "添加 SSH 机器"), h("span", { class: "spacer" }),
      h("button", { class: "btn quiet", type: "button", title: "收起（Esc）", onclick: () => showAdd(false) }, "关闭")),
    wizardBox);
  main.append(topbar(h("span", { class: "title" }, connectionHelp ? "连接设置" : "机器"), healthNote, h("span", { class: "spacer" }),
    h("button", { class: "btn quiet", type: "button", onclick: () => loadHealth(true) }, "检查连接"), addBtn),
  h("div", { class: "scroll" }, h("div", { class: "column" },
    connectionHelp ? h("p", { class: "wnote" }, `${connectionHelp.machine}：${connectionHelp.reason}`) : null,
    addPanel, importBox, webUiTip,
    list)));
  function showAdd(on) {
    adding = on;
    addPanel.hidden = !on;
    addBtn.classList.toggle("on", on);
    if (on) {
      renderWizard();
      addPanel.scrollIntoView({ block: "nearest" });
      const field = wizardBox.querySelector("input[aria-label='服务器地址']");
      if (field && !field.disabled) field.focus();
    }
  }
  const syncAdd = () => { importBox.hidden = !imports.machines.length; };

  let health = {};
  let healthError = null;
  let healthAt = 0;
  let listShape = "";
  let renaming = null;

  async function loadHealth(fresh) {
    healthNote.textContent = "正在检查连接…";
    try {
      const r = await api(`/api/machines/health${fresh ? "?fresh=1" : ""}`);
      health = r.health || {};
      healthError = r.error;
      healthAt = r.at || Date.now();
      healthNote.textContent = healthError ? `检查失败：${healthError}` : "";
    } catch (error) {
      healthNote.textContent = `检查失败：${error.message}`;
    }
    listShape = "";
    renderList();
  }

  /** broadcasts with an execution still under way on this machine */
  const activeOn = (id) => data.state.broadcasts.filter((b) => b.executions.some((e) => e.machine_id === id && ACTIVE.includes(e.state))).length;

  const agentCount = (id) => ((data.agents.find((g) => g.machine.id === id) || { agents: [] }).agents || []).length;

  function stateOf(m) {
    if (m.id === "local") return machineDown("local") ? ["bad", "连不上：Herdr 没在运行"] : ["ok", "运行中"];
    if (!m.enabled) return ["dim", "已停用"];
    const h1 = health[m.id];
    if (machineDown(m.id)) return ["bad", `连不上${h1 && h1.text ? `：${h1.text}` : ""}`];
    if (h1 && h1.ok === false) return ["bad", h1.text];
    if (h1 && h1.ok === true) return ["ok", "连接正常"];
    return ["dim", healthAt ? "没有状态" : "未检查"];
  }

  function machineRow(m) {
    const [t, text] = stateOf(m);
    const local = m.id === "local";
    const count = agentCount(m.id);
    const active = activeOn(m.id);
    // herdr-web-ui only when it runs; not installed or not started, the tip above the list says so
    const webUnavailable = m.web_link_reason;
    const openWebUi = !data.webUi.running ? null : m.web_link && !webUnavailable
      ? h("a", { class: "machine-webui", href: webUiLink(m.web_link), target: "herdr-web-ui", title: `在 herdr-web-ui 中使用 ${m.label}` }, "打开 herdr-web-ui ↗")
      : h("button", { class: "machine-webui", type: "button", disabled: true, title: webUnavailable || "正在读取工作区" }, "打开 herdr-web-ui ↗");
    // switches what this computer's Herdr shows: useless from a phone or another computer
    const openHerdr = !config.local ? null : h("button", { class: "machine-webui", type: "button", disabled: !!m.web_link_reason,
      title: m.web_link_reason || `让这台电脑上的 Herdr 切到 ${m.label} 的工作区`, onclick: async () => {
        try { toast((await post(`/api/machines/${encodeURIComponent(m.id)}/focus`)).message); } catch (error) { toast(error.message, true); }
      } }, "在 Herdr 中打开");
    const opens = openHerdr || openWebUi ? h("span", { class: "mopen" }, openHerdr, openWebUi) : null;
    const checked = !local && healthAt && health[m.id] ? `${ago(healthAt)}检查` : null;
    const stopRename = () => { renaming = null; listShape = ""; renderList(); };
    const name = renaming === m.id
      ? h("form", { class: "rename", onsubmit: async (event) => {
        event.preventDefault();
        const label = event.target.elements.label.value.trim();
        try {
          await post(`/api/machines/${encodeURIComponent(m.id)}/rename`, { label });
          renaming = null;
          document.activeElement.blur();
          listShape = "";
          renderList();
          toast(`已重命名为 ${label}`);
        } catch (error) { toast(error.message, true); }
      } }, h("input", { name: "label", value: m.label, "aria-label": "新名称", maxlength: "60",
        onkeydown: (event) => { if (event.key === "Escape") { event.stopPropagation(); stopRename(); } } }),
      h("button", { class: "btn primary", type: "submit" }, "保存"),
      h("button", { class: "btn quiet", type: "button", onclick: stopRename }, "取消"))
      : h("span", { class: "mname", title: m.label }, m.label);
    const actions = local ? [] : [
      h("button", { class: "btn quiet", type: "button", onclick: () => { renaming = m.id; listShape = ""; renderList(); } }, "重命名"),
      h("button", { class: "btn quiet", type: "button", title: m.enabled ? "暂时不连接这台机器，记录保留" : "重新连接这台机器", onclick: async () => {
        try { await post(`/api/machines/${encodeURIComponent(m.id)}/${m.enabled ? "disable" : "enable"}`); toast(m.enabled ? `已停用 ${m.label}` : `已启用 ${m.label}`); } catch (error) { toast(error.message, true); }
      } }, m.enabled ? "停用" : "启用"),
      confirmButton("删除", active ? `还有 ${active} 个进行中的广播，确认删除` : "再点一次删除", async () => {
        await api(`/api/machines/${encodeURIComponent(m.id)}`, { method: "DELETE" });
        toast(`已删除 ${m.label}`);
      }, { class: "btn quiet danger", title: active
        ? `这台机器上还有 ${active} 个进行中的广播：删除后它们连不上这台机器，会停在原地。远程的 agent 本身照常运行`
        : "只让本机忘记这个连接，远程的会话和 agent 照常运行" }),
    ];
    actions.unshift(h("button", { class: "btn quiet", type: "button", disabled: !m.enabled, onclick: () => showAgentPreparation(m) }, "准备 Agent"));
    return h("div", { class: `mrow${!m.enabled ? " off" : ""}` },
      h("span", { class: `dot ${t}` }),
      h("div", { class: "mmain" }, name,
        h("span", { class: "maddr" }, local ? "这台电脑" : m.target),
        h("span", { class: "mmeta" }, [count ? `${count} 个 agent` : "没有 agent", active ? `${active} 个进行中的广播` : null, checked].filter(Boolean).join("　·　")), opens),
      h("span", { class: "mstate" }, h("span", { class: `state-pill c-${t}`, title: text }, text)),
      h("span", { class: "mactions" }, actions));
  }

  /** herdr-web-ui is optional: when it is missing or stopped, how to have it, once above the list */
  function renderWebUiTip() {
    const shape = `${data.webUi.installed}|${data.webUi.running}`;
    if (webUiTip.dataset.shape === shape) return;
    webUiTip.dataset.shape = shape;
    webUiTip.hidden = data.webUi.running;
    webUiTip.replaceChildren(...(data.webUi.installed
      ? ["启动 herdr-web-ui 后，这里每台机器都能直接在浏览器里打开对话和终端。"]
      : ["安装 ", h("a", { href: WEB_UI_REPO, target: "_blank", rel: "noopener" }, "herdr-web-ui"),
        " 后，这里每台机器都能直接在浏览器里打开对话和终端：在终端运行 ", h("code", null, WEB_UI_INSTALL), "。"]));
  }

  /** one line above the list: how many machines, how many answer */
  function renderSummary() {
    const remotes = data.state.machines.filter((m) => m.id !== "local");
    const bad = remotes.filter((m) => stateOf(m)[0] === "bad").length;
    const off = remotes.filter((m) => !m.enabled).length;
    const parts = [remotes.length ? `${remotes.length} 台 SSH 机器` : "只有这台电脑"];
    if (bad) parts.push(`${bad} 台连不上`);
    if (off) parts.push(`${off} 台已停用`);
    healthNote.textContent = parts.join("　·　");
    healthNote.className = `health-note${bad ? " bad" : ""}`;
  }

  function renderList() {
    renderSummary();
    renderWebUiTip();
    const shape = JSON.stringify([data.state.machines, data.webUi, config.local, health, renaming, data.agents.map((g) => [g.machine.id, !!g.error, g.agents.length]),
      data.state.machines.map((m) => activeOn(m.id)), healthAt && Math.floor((Date.now() - healthAt) / 60_000)]);
    if (shape === listShape) return;
    // not while a name is being typed; once it is saved or dropped, the list follows again
    if (renaming !== null && list.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
    listShape = shape;
    list.replaceChildren(...data.state.machines.map(machineRow));
    if (data.state.machines.length <= 1) list.append(h("div", { class: "empty-note" }, "还没有 SSH 机器：在上面添加一台。"));
    const input = list.querySelector(".rename input");
    if (input) { input.focus(); input.select(); }
  }

  // ---- PCs added in herdr-web-ui, which Herdr does not have ----

  let imports = { file: null, machines: [] };
  let importsShape = "";

  async function loadImports() {
    if (!config.local) return;
    try { imports = await api("/api/machines/web-ui"); } catch { imports = { file: null, machines: [] }; }
    renderImports();
    syncAdd();
  }

  /** the wizard's first step, filled with what herdr-web-ui saved for this PC */
  function fillFrom(m) {
    reset();
    Object.assign(w, { target: m.target, label: m.name, keyPath: m.key || "", session: m.session, from: m });
    renderImports();
    showAdd(true);
  }

  /** herdr-web-ui's own PCs, which Herdr and broadcasts cannot see: a notice above the list */
  function renderImports() {
    importBox.replaceChildren();
    if (!imports.machines.length) return;
    importBox.append(
      h("div", { class: "import-head" }, h("b", null, `herdr-web-ui 里有 ${imports.machines.length} 台机器还没加到 Herdr`),
        h("span", { class: "sub" }, `它们只存在 herdr-web-ui 自己的 ${imports.file} 里，Herdr 和广播都看不到。`)),
      h("div", { class: "import-list" }, imports.machines.map((m) => h("div", { class: "import-item" },
        h("div", { class: "import-main" }, h("span", { class: "mname" }, m.name),
          h("code", null, [m.target, m.key ? `私钥 ${m.key}` : null, m.session ? `会话 ${m.session}` : null].filter(Boolean).join("　")),
          m.error ? h("span", { class: "wnote bad" }, m.error) : null,
          m.appKey ? h("span", { class: "wsub" }, "这把私钥是 herdr-web-ui 生成的：在 herdr-web-ui 里删掉这台机器时它也会被删掉，Herdr 就登录不上了。") : null),
        h("button", { class: "btn", type: "button", disabled: !!m.error || w.busy, onclick: () => fillFrom(m) }, "加到 Herdr →")))));
  }

  // ---- the wizard ----

  let moreOpen = false;
  const w = { step: "address", target: "", label: "", keyPath: "", session: null, from: null, job: null, entry: null, entryName: "", backup: null, check: null, login: null, key: null, busy: false, error: null, result: null, terminal: null };
  const reset = () => Object.assign(w, { step: "address", entry: null, entryName: "", backup: null, check: null, login: null, key: null, busy: false, error: null, diagnosis: null, forget: null, result: null, terminal: null, job: null });

  async function act(fn) {
    w.busy = true;
    w.error = null;
    w.diagnosis = null;
    w.forget = null;
    renderWizard();
    try { await fn(); } catch (error) { w.error = error.message; }
    w.busy = false;
    renderWizard();
  }

  /** where a login leaves the wizard: on to adding, or back to the key */
  function afterLogin(login) {
    w.login = login;
    if (login.ok) w.step = "add";
    else if (login.problem === "host-key-changed") {
      w.step = "address";
      w.error = "这台服务器的主机指纹和以前记录的不一样了。可能是服务器重装过，也可能有人冒充它。确认没问题后，在终端运行下面的命令删掉旧记录，再点下一步。";
      w.forget = login.forget;
    } else if (login.problem === "auth" || login.problem === "host-key") w.step = "key";
    else if (login.diagnosis) { w.step = "address"; w.diagnosis = login.diagnosis; }
    else { w.step = "address"; w.error = `连不上：${login.error || login.problem}`; }
  }

  async function doCheck() {
    const r = await post("/api/ssh/check", { target: w.target });
    w.check = r;
    w.target = r.target;
    w.key = r.key;
    if (r.login) afterLogin(r.login);
    else if (r.diagnosis) { w.step = "address"; w.diagnosis = r.diagnosis; }
    else if (r.scanError) { w.step = "address"; w.error = `连不上服务器：${r.scanError}`; }
    else w.step = "hostkey";
  }
  const check = () => act(doCheck);

  /** a private key given: first the Host entry it needs, shown before anything is written */
  const preview = (name) => act(async () => {
    const r = await post("/api/ssh/config-entry", { target: w.target, label: w.label, key: w.keyPath, name });
    w.entry = r;
    w.entryName = r.name;
    w.step = "config";
  });
  const start = () => (w.keyPath.trim() && !defaultKey(w.keyPath) ? preview() : check());

  const fixKey = () => act(async () => {
    await post("/api/ssh/key-fix", { key: w.entry.key.path });
    w.entry = await post("/api/ssh/config-entry", { target: w.target, label: w.label, key: w.keyPath, name: w.entryName });
    toast("已把私钥权限改成 600");
  });

  const writeEntry = () => act(async () => {
    const r = await post("/api/ssh/config-write", { target: w.target, key: w.keyPath, name: w.entryName });
    w.backup = r.backup;
    toast(`已写入 ~/.ssh/config：Host ${r.name}`);
    // from here on the server is reached by its name, as ssh and Herdr will; the key is in the entry
    w.target = r.name;
    w.keyPath = "";
    await doCheck();
  });

  const trust = () => act(async () => {
    const r = await post("/api/ssh/trust", { target: w.target, fingerprints: w.check.keys.map((k) => k.fingerprint) });
    afterLogin(r.login);
  });

  const verify = () => act(async () => {
    const r = await post("/api/ssh/verify", { target: w.target });
    w.key = r.key;
    afterLogin(r.login);
    const own = w.check && w.check.resolved && w.check.resolved.identity;
    if (!r.login.ok && r.login.problem === "auth") w.error = own
      ? `还是登录不上：服务器没有接受 ${own.display}。检查用户名（现在是 ${w.check.resolved.user}）对不对，以及这把私钥是不是这台服务器的。`
      : "还是登录不上：服务器没有接受这把公钥。检查公钥有没有完整放进 ~/.ssh/authorized_keys，以及文件权限。";
  });

  const keygen = () => act(async () => {
    const r = await post("/api/ssh/keygen", {});
    w.key = r.key;
    toast("已生成密钥");
  });

  /** `herdr machine add`, run by the server in a terminal of its own; `install`: approved here */
  const add = (install) => act(async () => {
    const r = await post("/api/machines/add", { target: w.target, label: w.label, session: w.session, install, system: (w.login && w.login.system) || null });
    w.job = r.job;
    w.terminal = null;
    void followJob(r.job.id);
  });

  /** the job's state, read until it ends; a question shows as soon as it is asked */
  async function followJob(id) {
    while (w.job && w.job.id === id && ["downloading", "running", "question"].includes(w.job.state)) {
      await new Promise((resolve) => setTimeout(resolve, w.job.state === "question" ? 1500 : 700));
      if (!w.job || w.job.id !== id) return;
      try { w.job = (await api(`/api/machines/add/${id}`)).job; } catch (error) { w.error = error.message; return renderWizard(); }
      if (w.job.state === "done") { w.step = "done"; toast("已添加"); }
      renderWizard();
    }
  }

  const answer = (yes) => act(async () => {
    w.job = (await post(`/api/machines/add/${w.job.id}/answer`, { yes })).job;
  });

  /** the running server there left alone: a session of its own, which Herdr starts beside it */
  const SEPARATE_SESSION = "broadcast";
  const separateSession = () => act(async () => {
    const old = w.job;
    await post(`/api/machines/add/${old.id}/answer`, { yes: false });
    for (let i = 0; i < 60; i++) {
      const job = (await api(`/api/machines/add/${old.id}`)).job;
      if (!["downloading", "running", "question"].includes(job.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    w.session = SEPARATE_SESSION;
    const r = await post("/api/machines/add", { target: w.target, label: w.label, session: w.session, install: true, system: (w.login && w.login.system) || null });
    w.job = r.job;
    void followJob(r.job.id);
  });

  const cancelJob = () => act(async () => {
    w.job = (await api(`/api/machines/add/${w.job.id}`, { method: "DELETE" })).job;
  });

  const openTerminal = () => act(async () => {
    w.terminal = await post("/api/ssh/terminal", { target: w.target, label: w.label, session: w.session });
  });

  /** a running `herdr machine add`: where it is, the question it asks, what it printed */
  function jobView(job, login) {
    const out = [];
    const disabled = w.busy;
    const log = job.output.trim();
    if (job.state === "downloading") {
      const d = job.download || { done: 0, total: null, what: "Herdr" };
      const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
      out.push(h("div", { class: "wrow" },
        h("span", { class: "wnote" }, `正在这台电脑上下载 ${d.what}：${mb(d.done)}${d.total ? ` / ${mb(d.total)}（${Math.floor((d.done / d.total) * 100)}%）` : ""}`),
        h("button", { class: "btn quiet", type: "button", disabled, onclick: cancelJob }, "取消")),
        d.total ? h("progress", { max: d.total, value: d.done }) : null,
        h("p", { class: "wsub" }, "从 GitHub 下载，断了会接着下，下载完核对校验值。下好后通过 SSH 传到服务器，以后再加机器不用重新下载。"));
    } else if (job.state === "running") {
      out.push(h("div", { class: "wrow" }, h("span", { class: "wnote" }, "正在连接服务器、准备 Herdr…（下载安装可能要一两分钟）"),
        h("button", { class: "btn quiet", type: "button", disabled, onclick: cancelJob }, "取消")));
    } else if (job.state === "question") {
      const q = job.question;
      const box = [h("p", { class: "wnote" }, "Herdr 在问：", h("code", null, q.text))];
      if (q.context) box.push(h("pre", { class: "wout" }, q.context));
      if (q.kind === "server") {
        box.push(h("p", { class: "wnote warn" }, "服务器上已经有一个 Herdr 服务在运行。重启它会关闭里面所有的终端和 agent（正在跑的任务会中断）。"));
        if (login.webUiHerdr) box.push(h("p", { class: "wnote warn" }, `这个服务多半是 herdr-web-ui 启动的（${login.webUiHerdr}）：重启后 herdr-web-ui 里这台机器上的终端和 agent 会被关闭，需要在那边重新连接。`));
        if (!w.session) box.push(h("p", { class: "wsub" }, `不想动它，可以改用单独的会话「${SEPARATE_SESSION}」：Herdr 在旁边另起一个服务，现有的完全不受影响；但广播只能看到这个新会话里的 agent，看不到原来那个服务里的。`));
        box.push(h("div", { class: "wrow" },
          h("button", { class: "btn", type: "button", disabled, onclick: () => answer(true) }, "重启服务"),
          !w.session ? h("button", { class: "btn primary", type: "button", disabled, onclick: separateSession }, "不重启，用单独会话") : null,
          h("button", { class: "btn quiet", type: "button", disabled, onclick: cancelJob }, "取消添加")));
      } else {
        if (q.kind === "install") box.push(h("p", { class: "wnote" }, "要在服务器上安装 Herdr。"));
        box.push(h("div", { class: "wrow" },
          h("button", { class: "btn primary", type: "button", disabled, onclick: () => answer(true) }, "同意"),
          h("button", { class: "btn", type: "button", disabled, onclick: () => answer(false) }, "不同意"),
          h("button", { class: "btn quiet", type: "button", disabled, onclick: cancelJob }, "取消添加")));
      }
      out.push(h("div", { class: "question", role: "alert" }, box));
    } else if (job.state === "failed" || job.state === "cancelled") {
      out.push(h("p", { class: "wnote bad" }, job.reason || (job.state === "cancelled" ? "已取消，机器没有保存。" : "没能添加，机器没有保存。Herdr 的输出在下面。")));
      if (/download failed/i.test(log)) out.push(h("p", { class: "wnote" }, "Herdr 自己下载超时了（它对下载限时很短）。再点一次「安装并连接」：插件会先在这台电脑上下载好再传过去。"));
      else if (/not installed|approve installation/i.test(log)) out.push(h("p", { class: "wnote" }, "服务器上还缺 Herdr：用「安装并连接」装好再连。"));
      else if (/server is not ready for saved machines/i.test(log)) out.push(h("p", { class: "wnote" }, "服务器上原来的 Herdr 服务没有重启，Herdr 不能用它保存机器。再试一次，选「重启服务」或「用单独会话」。"));
    }
    if (log) out.push(h("details", { open: job.state === "failed" || null }, h("summary", null, "Herdr 的输出"), h("pre", { class: "wout" }, log)));
    return out;
  }

  function renderWizard() {
    const order = ["address", "config", "hostkey", "key", "add", "done"];
    const at = order.indexOf(w.step);
    const stateOfStep = (name) => (order.indexOf(name) < at ? "done" : name === w.step ? "now" : "later");
    const disabled = w.busy || !config.local;
    /** a step as it shows: its name, where it is, what it says while it is the one in hand */
    const steps = [];
    const step = (title, state, ...body) => steps.push({ title, state, body: body.flat().filter(Boolean) });
    const out = [];
    if (!config.local) out.push(h("p", { class: "wnote bad" }, "添加机器只能在这台电脑本机的浏览器里操作（地址用 localhost 或 127.0.0.1 打开本页）。"));

    // the address; name and key are the less common part, behind 更多选项 once there are machines
    const typed = splitAddress(w.target);
    const editing = disabled || w.step !== "address";
    const take = () => { w.target = joinAddress(addr.value, port.value); w.label = label.value; w.keyPath = keyField.value; };
    const next = h("button", { class: "btn primary", type: "button", disabled: disabled || !w.target.trim(), onclick: () => { take(); start(); } }, w.busy ? "检查中…" : "检查");
    const changed = () => {
      w.target = joinAddress(addr.value, port.value);
      next.disabled = disabled || !w.target.trim();
      if (w.from) { w.from = null; w.session = null; renderImports(); }
    };
    /**
     * a pasted or finished address: its port and key moved to their own fields. Shown again only
     * after a paste: on leaving the field, a click on 检查 is under way and must find its button.
     */
    const tidy = (pasted) => {
      const parts = splitAddress(addr.value);
      const whole = /^\s*ssh\s/.test(addr.value);
      if (parts.port && (whole || !port.value.trim())) port.value = parts.port;
      if (parts.key && (whole || !keyField.value.trim())) { w.keyPath = parts.key; keyField.value = parts.key; }
      if (parts.address !== addr.value.trim()) addr.value = parts.address;
      changed();
      if (!pasted) return;
      w.label = label.value;
      moreOpen = moreOpen || !!parts.key;
      renderWizard();
      const again = wizardBox.querySelector("input[aria-label='服务器地址']");
      if (again && !again.disabled) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    };
    const enter = (e) => { if (e.key === "Enter") { e.preventDefault(); tidy(false); take(); if (w.target.trim()) start(); } };
    const addr = h("input", { class: "winput", value: typed.address, placeholder: "user@服务器地址，或 ~/.ssh/config 里的 Host 名", "aria-label": "服务器地址", disabled: editing, autocomplete: "off", spellcheck: "false",
      oninput: changed, onchange: () => tidy(false), onpaste: () => setTimeout(() => tidy(true)), onkeydown: enter });
    const port = h("input", { class: "winput port", value: typed.port, placeholder: "端口 22", inputmode: "numeric", maxlength: "5", "aria-label": "端口", disabled: editing,
      oninput: (e) => { e.target.value = e.target.value.replace(/\D/g, ""); changed(); }, onkeydown: enter });
    const label = h("input", { class: "winput short", value: w.label, placeholder: "显示名称（可选）", "aria-label": "显示名称", disabled: disabled || w.step !== "address",
      oninput: (e) => { w.label = e.target.value; } });
    const keyField = h("input", { class: "winput", value: w.keyPath, placeholder: "私钥文件（可选）：服务器要用 .pem 登录时填，例如 ~/.ssh/server.pem", "aria-label": "私钥文件", disabled: disabled || w.step !== "address",
      oninput: (e) => { w.keyPath = e.target.value; } });
    const r1 = w.check && w.check.resolved;
    const standsFor = r1 && r1.alias
      ? h("p", { class: "wsub" }, "这个 Host 指向 ", h("code", null, `${r1.user ? `${r1.user}@` : ""}${r1.host}${r1.port !== 22 ? `:${r1.port}` : ""}`),
        r1.identity ? ["，用私钥 ", h("code", null, r1.identity.display)] : null, "。")
      : null;
    const addressBody = [h("div", { class: "wrow" }, addr, port, w.step === "address" ? next : null,
      w.step === "address"
        ? h("button", { class: "btn quiet more-options", type: "button", "aria-expanded": String(moreOpen), onclick: () => { moreOpen = !moreOpen; renderWizard(); } }, moreOpen ? "收起选项" : "更多选项")
        : h("button", { class: "btn quiet", type: "button", disabled: w.busy, onclick: () => { reset(); renderWizard(); } }, "重新填写"))];
    if (w.step === "address" && moreOpen) addressBody.push(h("div", { class: "wrow" }, label, keyField));
    if (w.step === "address" && !moreOpen && (w.label || w.keyPath)) addressBody.push(h("p", { class: "wsub" }, `名称 ${w.label || "未填"}　私钥 ${w.keyPath || "未填"}`));
    if (w.step === "address" && defaultKey(w.keyPath)) addressBody.push(h("p", { class: "wsub" }, h("code", null, w.keyPath.trim()), " 是 ssh 的默认私钥，ssh 会自己用它，不用另写 SSH 配置。"));
    if (w.step === "address") addressBody.push(h("p", { class: "wsub" }, "也可以粘贴 ssh 命令，例如 ", h("code", null, "ssh -p 2222 -i ~/.ssh/server.pem ubuntu@1.2.3.4"), "。"));
    if (w.from) addressBody.push(h("p", { class: "wsub" }, `从 herdr-web-ui 的「${w.from.name}」填入${w.session ? `，用远程会话 ${w.session}` : ""}。`));
    addressBody.push(standsFor);
    step("地址", stateOfStep("address"), addressBody);

    // a Host entry for a server with its own key
    if (w.entry && (w.step === "config" || at > order.indexOf("config"))) {
      const now = w.step === "config";
      const e = w.entry;
      const body = [];
      if (now) {
        body.push(h("p", { class: "wnote" }, "这台服务器要用 ", h("code", null, e.key.display), " 登录。Herdr 连接时用的是系统的 ssh，所以要在 ", h("code", null, e.file), " 里加一段配置："));
        if (e.key.loose) body.push(h("p", { class: "wnote warn" }, "这把私钥的权限太宽，ssh 会拒绝使用它（要求只有你自己能读）。",
          h("button", { class: "btn", type: "button", disabled, onclick: fixKey }, "改成 600"), "　或在终端运行 ", h("code", null, `chmod 600 ${e.key.display}`)));
        if (e.key.passphrase) body.push(h("p", { class: "wnote warn" }, "这把私钥有密码短语。Herdr 在后台连接时没人替你输入，写入配置后请在终端运行 ", h("code", null, `ssh-add --apple-use-keychain ${e.key.display}`), "。"));
        const nameInput = h("input", { class: "winput short", value: w.entryName, "aria-label": "配置名", disabled, oninput: (ev) => { w.entryName = ev.target.value; } });
        body.push(h("div", { class: "wrow" }, h("span", { class: "wsub" }, "配置名"), nameInput,
          h("button", { class: "btn quiet", type: "button", disabled, onclick: () => preview(nameInput.value) }, "更新预览")));
        if (e.taken) body.push(h("p", { class: "wnote bad" }, `配置里已经有 Host ${e.name} 了：换一个配置名。`));
        body.push(copyBlock(e.text, "配置"),
          h("p", { class: "wsub" }, "写在已有的 Host 配置前面（ssh 以先读到的为准），原文件另存为 config.herdr-broadcast.bak。私钥文件留在原处。"),
          h("div", { class: "wrow" }, h("button", { class: "btn primary", type: "button", disabled: disabled || e.taken || e.key.loose, onclick: writeEntry }, w.busy ? "写入中…" : "写入配置并继续")));
      } else {
        body.push(h("p", { class: "wsub" }, "已写入 Host ", h("code", null, w.entryName), w.backup ? `，原文件备份在 ${w.backup}` : "", "。"));
      }
      step("SSH 配置", stateOfStep("config"), body);
    }

    // the host key
    if (at >= order.indexOf("hostkey") && w.check && !w.check.known) {
      const now = w.step === "hostkey";
      step("服务器指纹", stateOfStep("hostkey"),
        now ? h("p", { class: "wnote" }, "第一次连接这台服务器。核对下面的指纹和服务器上的一致再信任它（在服务器上运行 ", h("code", null, "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"), " 可以看到）。") : null,
        h("ul", { class: "prints" }, w.check.keys.map((k) => h("li", null, h("span", { class: "ktype" }, k.type), h("code", null, k.fingerprint)))),
        now ? h("div", { class: "wrow" }, h("button", { class: "btn primary", type: "button", disabled, onclick: trust }, w.busy ? "写入中…" : "信任这台服务器")) : null);
    }

    // this computer's key on the server, or the key the config names for it
    if (at >= order.indexOf("key")) {
      const own = w.check && w.check.resolved && w.check.resolved.identity;
      if (w.step === "key" && own) {
        const body = [h("p", { class: "wnote" }, "SSH 配置为这台服务器指定了私钥 ", h("code", null, own.display), "，但服务器没有接受它。")];
        if (own.loose) body.push(h("p", { class: "wnote warn" }, "这把私钥的权限太宽，ssh 不会用它：在终端运行 ", h("code", null, `chmod 600 ${own.display}`), "。"));
        if (own.passphrase) body.push(h("p", { class: "wnote warn" }, "这把私钥有密码短语：在终端运行 ", h("code", null, `ssh-add --apple-use-keychain ${own.display}`), "。"));
        body.push(h("p", { class: "wnote" }, `也检查一下用户名（现在是 ${w.check.resolved.user || "未指定"}）对不对，以及这把私钥是不是这台服务器的。`),
          h("div", { class: "wrow" }, h("button", { class: "btn primary", type: "button", disabled, onclick: verify }, w.busy ? "验证中…" : "重新验证")));
        step("免密登录", "now", body);
      } else if (w.step === "key") {
        const key = w.key;
        const body = [];
        if (!key) {
          body.push(h("p", { class: "wnote" }, "这台 Mac 还没有 SSH 密钥。生成一把（~/.ssh/id_ed25519，没有密码短语），再把它的公钥放到服务器上。"),
            h("div", { class: "wrow" }, h("button", { class: "btn primary", type: "button", disabled, onclick: keygen }, "生成密钥")));
        } else {
          const install = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${key.publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
          body.push(
            h("p", { class: "wnote" }, "还不能免密登录。把这台 Mac 的公钥放到服务器上，任选一种："),
            h("p", { class: "wsub" }, "在服务器上（已经登录进去的终端里）运行："),
            copyBlock(install, "命令"),
            h("p", { class: "wsub" }, "或者在这台 Mac 的终端里运行（会问一次服务器密码）："),
            copyBlock(`ssh-copy-id -i ${key.path} ${w.target.replace(/^ssh:\/\//, "").replace(/:(\d+)$/, " -p $1")}`, "命令"),
            h("details", null, h("summary", null, `只看公钥（${key.path}）`), copyBlock(key.publicKey, "公钥")));
          if (key.passphrase) body.push(h("p", { class: "wnote warn" }, "这把私钥有密码短语。Herdr 在后台连接时没人替你输入，请先在终端运行 ", h("code", null, `ssh-add --apple-use-keychain ${key.path.replace(/\.pub$/, "")}`), "。"));
          body.push(h("div", { class: "wrow" }, h("button", { class: "btn primary", type: "button", disabled, onclick: verify }, w.busy ? "验证中…" : "放好了，验证连接")));
        }
        step("免密登录", "now", body);
      } else {
        step("免密登录", "done");
      }
    }

    // adding to Herdr: installing it there first when it is missing or another version
    if (at >= order.indexOf("add")) {
      const login = w.login || {};
      const needs = !sameHerdr(login.herdr, login.localHerdr);
      const want = login.localHerdr || "与这台电脑相同版本的 Herdr";
      const facts = [login.system ? login.system : null, `Herdr ${login.herdr || "未安装"}`].filter(Boolean).join("　·　");
      const body = [h("p", { class: "wsub" }, "已经能免密登录。", facts)];
      if (login.supported === false) body.push(h("p", { class: "wnote warn" }, "Herdr 只支持 x86_64 / aarch64 的 Linux 和 macOS，这台机器可能用不了。"));
      const job = w.job;
      const live = job && ["downloading", "running", "question"].includes(job.state);
      if (w.step === "add" && !live) {
        if (needs) {
          body.push(h("p", { class: "wnote" }, login.herdr
            ? `服务器上的 Herdr 是 ${login.herdr}，这台电脑是 ${want}：Herdr 要求两边版本一致。`
            : "服务器上还没有 Herdr。"));
          if (login.webUiHerdr) body.push(h("p", { class: "wsub" }, `服务器上有 herdr-web-ui 装的 ${login.webUiHerdr}（在 ~/.local/share/herdr-web-ui 里），那是它自己的私有副本，Herdr 不用它。两者互不影响。`));
          body.push(h("ul", { class: "plan" },
            h("li", null, `把 ${want} 传到服务器的 `, h("code", null, "~/.local/bin/herdr"), "，不需要 root"),
            h("li", null, "启动服务器上的 Herdr"),
            h("li", null, "保存这台机器，之后 Herdr 侧边栏和广播都能用")),
          h("p", { class: "wsub" }, "要停止或重启服务器上已经在运行的 Herdr 服务时，会先问你。"));
        }
        body.push(h("div", { class: "wrow" },
          h("button", { class: "btn primary", type: "button", disabled, onclick: () => add(needs) }, w.busy ? "开始中…" : needs ? "安装并连接" : "添加到 Herdr"),
          h("button", { class: "btn quiet", type: "button", disabled, onclick: openTerminal, title: "在 Herdr 里开一个标签页运行添加命令，自己在终端里回答问题" }, "在终端里添加")));
      }
      if (job && w.step === "add") body.push(...jobView(job, login));
      if (w.step === "add" && w.terminal) {
        body.push(h("p", { class: "wsub" }, `已在 Herdr 里打开「${w.terminal.workspaceLabel || "添加机器"}」，命令已经输入好了。完成后这里会自动显示新机器。`));
        if (data.webUi.running && w.terminal.web_link) body.push(h("button", { class: "btn", type: "button", onclick: () => openInWebUi(w.terminal.web_link, "terminal") }, "在 herdr-web-ui 里打开这个终端"));
        body.push(copyBlock(w.terminal.command, "命令"));
      }
      step(needs && w.step !== "done" ? "安装 Herdr" : "保存到 Herdr", stateOfStep("add"), body);
    }

    // the steps as a line of chips, the one in hand open below it
    const visible = steps.filter((x) => x.state !== "later");
    if (visible.length > 1) {
      out.push(h("ol", { class: "steps", "aria-label": "步骤" }, visible.map((x) => h("li", { class: `chip ${x.state}` },
        x.state === "done" ? h("span", { class: "tick", "aria-hidden": "true" }, "✓") : null, x.title))));
    }
    for (const x of steps) {
      if (x.state !== "now" || !x.body.length) continue;
      out.push(h("div", { class: "step-body" }, x.body));
    }

    if (w.step === "done") {
      const fresh = () => { Object.assign(w, { target: "", label: "", keyPath: "", session: null, from: null }); reset(); renderImports(); };
      out.push(h("div", { class: "wdone" }, h("p", null, `已添加 ${w.label || w.target}，它现在在下面的列表和 Herdr 的侧边栏里。`),
        h("div", { class: "wrow" },
          h("button", { class: "btn", type: "button", onclick: () => {
            const machine = data.state.machines.find(m => m.target === w.target || m.target === w.target.replace(/^ssh:\/\//, ""));
            if (machine) showAgentPreparation(machine); else toast("机器列表正在更新，请从下方机器的「准备 Agent」入口继续");
          } }, "准备 Agent（可跳过）"),
          h("button", { class: "btn primary", type: "button", onclick: () => { fresh(); renderWizard(); showAdd(false); } }, "完成"),
          h("button", { class: "btn", type: "button", onclick: () => { fresh(); renderWizard(); } }, "再添加一台"))));
    }
    if (w.diagnosis) {
      out.push(h("div", { class: "diagnosis", role: "alert" },
        h("p", { class: "wnote bad" }, w.diagnosis.message),
        w.diagnosis.hints.length ? h("p", { class: "wsub" }, "可能的原因：") : null,
        h("ul", null, w.diagnosis.hints.map((hint) => h("li", null, hint))),
        h("button", { class: "btn", type: "button", disabled: w.busy, onclick: check }, "重试")));
    }
    if (w.error) out.push(h("p", { class: "wnote bad", role: "alert" }, w.error));
    if (w.forget) out.push(copyBlock(w.forget, "命令"));
    // a step that opened in a terminal: done once the machine shows up
    if (w.terminal && w.step === "add" && data.state.machines.some((m) => m.target && (m.target === w.target || m.target === w.target.replace(/^ssh:\/\//, "")))) {
      w.step = "done";
      return renderWizard();
    }
    wizardBox.replaceChildren(...out);
  }

  function update() {
    renderList();
    if (w.terminal && w.step === "add") renderWizard();
    // a machine added or removed: what is left to import changes with it
    const shape = JSON.stringify(data.state.machines.map((m) => [m.id, m.target]));
    if (shape !== importsShape) { importsShape = shape; void loadImports(); }
  }

  renderList();
  renderWizard();
  syncAdd();
  // no machine yet: the form is what this page is for
  if (data.state.machines.length <= 1) showAdd(true);
  importsShape = JSON.stringify(data.state.machines.map((m) => [m.id, m.target]));
  void loadImports();
  void loadHealth(false);
  // Esc folds the add form away
  return { update, escape: () => { if (!adding || w.busy) return false; showAdd(false); return true; } };
}

// ---- a broadcast: its prompt, and every agent's interactive screen --------------------------

/** Selection is persistent; readiness controls sending and explains what needs attention. */
/** Only user decisions are exposed; transport and recovery details stay internal. */
function connectionPresentation(e, ready, recovery = null, handedOff = false) {
  const states = {
    ready: { kind: "ready", text: "", action: null, button: "" },
    connecting: { kind: "connecting", text: "正在连接…", action: null, button: "" },
    handedOff: { kind: "handedOff", text: "画面已暂停，点击终端可接管", action: null, button: "" },
    confirm: { kind: "confirm", text: "请在终端完成启动确认", action: "confirm", button: "查看并确认" },
    manual: { kind: "manual", text: "请手动打开 agent 并选择原历史", action: "identity", button: "已恢复此会话" },
    identity: { kind: "identity", text: "会话身份尚未核实", action: "identity", button: "核对会话" },
    identityPending: { kind: "identityPending", text: "尚未获取会话标识", action: null, button: "" },
    startConfirm: { kind: "confirm", text: "等待启动确认，完成后自动发送", action: "confirm", button: "查看并确认" },
    choose: { kind: "choose", text: "请选择要继续的对话", action: "choose", button: "选择对话" },
    settings: { kind: "settings", text: "设备连接需要设置", action: "settings", button: "打开连接设置" },
    unavailable: { kind: "unavailable", text: "原对话无法恢复", action: "new", button: "新建对话" },
    failed: { kind: "failed", text: "未能恢复对话", action: "continue", button: "重试" },
    closed: { kind: "closed", text: "对话已关闭", action: "continue", button: "继续对话" },
  };
  if (e.custom_startup_pending) return { kind: "confirm", text: "等待确认就绪，尚未发送本轮输入", action: "custom-startup", button: "已进入新对话，发送本轮输入" };
  if (e.requires_action) return states.settings;
  if (recovery === "unavailable" || e.restore_unavailable) return states.unavailable;
  if (recovery === "failed") return states.failed;
  if (recovery === "connecting") return states.connecting;
  if (e.terminal_state === "conflict" || recovery === "choose") return states.choose;
  if (e.needs_start_confirmation) return e.state === "starting" ? states.startConfirm : states.confirm;
  if (e.terminal_state === "identity_pending") return states.identityPending;
  if (e.terminal_state === "restoring") return e.restore_pending ? states.connecting
    : states[e.restore_kind === "manual" ? "manual" : e.restore_kind === "choose" ? "choose" : e.restore_kind === "identity" ? "identity" : "confirm"];
  if (e.terminal_state === "closed") {
    if (!e.can_resume) return states.unavailable;
    return states.closed;
  }
  // an agent that could not start: one line here, the shell's own words in the terminal below and the detail on hover
  if (["shell", "not_started"].includes(e.terminal_state) && e.state === "failed") {
    return { kind: "start_failed", text: e.terminal_state === "shell" ? "Agent 未能启动，原因见下方终端" : "Agent 未能启动", action: null, button: "", detail: e.error || "" };
  }
  if (e.terminal_state === "not_started" && ["cancelled", "failed"].includes(e.state)) return states.ready;
  if (handedOff && !ready) return states.handedOff;
  if (e.terminal_state === "shell") return ready ? states.ready : states.connecting;
  return e.terminal_state === "live" && ready ? states.ready : states.connecting;
}

/** Scope instructions, participants and counts to one round; the broadcast identity stays put. */
function broadcastRound(b, roundId, focusExec = null) {
  const rounds = b.rounds || [];
  const focusedRound = b.executions.find(e => e.id === focusExec)?.round_id;
  const round = rounds.find(r => r.id === (roundId ?? focusedRound)) || rounds.at(-1);
  if (!round) return b;
  return { ...b, prompt: round.prompt, created_at: round.created_at, total: round.total, counts: round.counts,
    round, executions: b.executions.filter(e => e.round_id === round.id) };
}

/** One live panel per conversation, using its latest task independently of the input being read. */
function broadcastAgentKey(e) {
  return JSON.stringify([e.machine_id, e.terminal_id ? ["terminal", e.terminal_id]
    : e.session_value ? ["session", e.agent_kind, e.session_value] : ["execution", e.id]]);
}

function broadcastAgents(b) {
  const agents = new Map();
  for (const e of [...b.executions].sort((a, b) => a.id - b.id)) agents.set(broadcastAgentKey(e), e);
  return [...agents.values()];
}

/**
 * `id`: the broadcast; or `focusExec`, an execution whose broadcast to show, scrolled to that
 * agent (a link from a notification). Focus a screen to type into that agent.
 */
function broadcastView(main, id, focusExec) {
  const titleEl = h("span", { class: "title" });
  const promptText = h("div", { class: "round-prompt", tabindex: "0", role: "region", "aria-label": "本轮任务输入" });
  const metaText = h("span", { class: "round-meta" });
  const roundLabel = h("strong", { class: "round-label" });
  // Instructions are reference material; keep the live terminals in view by default.
  const promptDetails = h("details", { class: "round-instruction" },
    h("summary", { class: "round-context-head" }, roundLabel, h("span", { class: "round-input-label" }, "任务输入"), metaText,
      h("span", { class: "round-expand", "aria-hidden": "true" })), promptText);
  const hint = h("p", { class: "webui-hint", hidden: true });
  const summary = h("div", { class: "summary", role: "group", "aria-label": "按状态跳到 agent" });
  const wall = h("div", { class: "wall" });
  const panels = new Map();
  let selectedRoundId = null;
  const roundButtons = new Map();
  const roundList = h("div", { class: "round-list", role: "group", "aria-label": "选择任务轮次" });
  const roundHeading = h("strong");
  const roundHistory = h("div", { class: "round-history" }, roundHeading, roundList);
  const roundContext = h("section", { class: "round-context", "aria-label": "任务轮次与输入" }, roundHistory, promptDetails);
  const body = h("div", { class: "column wide" }, roundContext, hint, summary);
  const fontLabel = h("button", { class: "btn quiet", type: "button", title: `恢复默认 ${screenFont.normal}px` });
  /** one size for every screen on the wall, at once */
  const applyFont = (size) => {
    screenFont.size = size;
    wall.style.setProperty("--screen-font", `${screenFont.size}px`);
    fontLabel.textContent = `${screenFont.size}px`;
    for (const panel of panels.values()) panel.terminal.font(screenFont.size);
  };
  const fontControl = h("span", { class: "font-size", role: "group", "aria-label": "终端文字大小" },
    h("button", { class: "btn quiet", type: "button", title: "文字小一点", "aria-label": "文字小一点", onclick: () => applyFont(screenFont.size - 1) }, "A−"),
    fontLabel,
    h("button", { class: "btn quiet", type: "button", title: "文字大一点", "aria-label": "文字大一点", onclick: () => applyFont(screenFont.size + 1) }, "A+"));
  fontLabel.addEventListener("click", () => applyFont(screenFont.normal));
  applyFont(screenFont.size);
  const actions = h("span", { class: "top-actions" });
  main.append(topbar(titleEl, h("span", { class: "spacer" }), actions, fontControl), h("div", { class: "scroll" }, body));
  let actionsFor = null;
  let summaryFor = null;
  let focused = false;
  let disposed = false;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const execId = Number(entry.target.dataset.exec);
      const panel = panels.get(execId);
      if (panel) { panel.terminal.visible(entry.isIntersecting); if (entry.isIntersecting) maybeRecover(panel); }
    }
  });
  /** which panel of each state the summary jumped to last, so pressing again goes to the next */
  const jumped = new Map();
  // running times move every second
  const ticker = setInterval(() => { if (!document.hidden) update(); }, 1000);

  const broadcastId = () => {
    if (id !== null) return id;
    const found = findExec(focusExec);
    return found ? found.b.id : null;
  };

  function flash(el) {
    el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    el.classList.remove("focus");
    void el.offsetWidth;
    el.classList.add("focus");
    setTimeout(() => el.classList.remove("focus"), 2500);
  }

  /** counts by state, each a button to the agents in it */
  function renderSummary(b) {
    const groups = [
      ...SUMMARY.map(([key, states, t, text]) => ({ key, t, text, list: b.executions.filter((e) => states.includes(e.state)) }))].filter((g) => g.list.length);
    const shape = groups.map((g) => `${g.key}:${g.list.map((e) => e.id).join(",")}`).join("|");
    if (shape === summaryFor) return;
    summaryFor = shape;
    summary.replaceChildren(...groups.map((g) => h("button", { class: "sum", type: "button", title: `跳到${g.text}的 agent`, onclick: () => {
      const next = ((jumped.get(g.key) ?? -1) + 1) % g.list.length;
      jumped.set(g.key, next);
      const panel = panels.get(g.list[next].id);
      if (panel) flash(panel.el);
    } }, h("span", { class: `dot ${g.t}` }), `${g.text} ${g.list.length}`)));
  }

  /** The same prompt to the same agents, as a new broadcast to look over before it goes. */
  function rebroadcast(b) {
    const fresh = new Map();
    let missing = 0;
    for (const e of b.executions) {
      if (!e.cwd || !e.agent_kind || e.agent_kind === "custom") { missing++; continue; }
      const k = JSON.stringify([e.machine_id, e.cwd, e.agent_kind]);
      const p = fresh.get(k) || { machine: e.machine_id, cwd: e.cwd, kind: e.agent_kind, count: 0 };
      p.count++; fresh.set(k, p);
    }
    sessionStorage.setItem(PREFILL_KEY, JSON.stringify({ title: b.title, prompt: b.prompt, fresh: [...fresh.values()] }));
    if (missing) toast(`${missing} 个参与者无法转为新建配置，请重新选择并填写命令`);
    go("#/new");
  }

  function opens(e) {
    const buttons = [];
    if (e.can_cancel_start) buttons.push(h("button", { class: "btn quiet", type: "button", onclick: () => taskActionFor(e.id, async () => {
      await post(`/api/executions/${e.id}/cancel`);
      await refreshConversation();
      toast("已取消本次发送，agent 保持打开。");
    }) }, "取消本次发送"));
    if (e.can_retry) {
      buttons.push(confirmButton("再次发送本轮任务", "确认再次发送（新增一轮）", () => taskActionFor(e.id, async () => {
        const result = await post(`/api/executions/${e.id}/retry`);
        selectedRoundId = result.round_id;
        try { const fresh = await api("/api/state"); if (!disposed) { data = fresh; update(); } } catch { /* state stream will catch up */ }
        toast(`已新增第 ${result.round_number} 轮，原记录已保留。`);
      }), { class: "btn quiet", title: "会再次发送同一指令，新增一轮并保留原结果。请先核对原对话，避免重复执行。" }));
    }
    if (["working", "blocked"].includes(e.agent_status) && e.terminal_state === "live") buttons.push(confirmButton("中断 agent", "确认中断（发送 Ctrl+C）", () => taskActionFor(e.id, async () => {
      const current = panels.get(e.id)?.current;
      await post(`/api/executions/${e.id}/interrupt`, { terminal_id: current?.terminal_id });
      toast("已发送 Ctrl+C，请查看终端确认。");
    }), { class: "btn quiet", title: "向当前 agent 发送 Ctrl+C；不撤回消息，也不改变广播的发送结果。" }));
    if (!e.pane_id || !SHOWN.includes(e.terminal_state)) return buttons;
    // switches what Herdr shows on this computer: useless from a phone or another computer
    if (config.local) {
      buttons.push(h("button", { class: "btn quiet", type: "button", title: "让这台电脑上的 Herdr 切到这个 agent 所在的标签页", onclick: async () => {
        try { const { message } = await post(`/api/executions/${e.id}/focus`); toast(message); } catch { try { await refreshConversation(); } catch { /* automatic connection recovery */ } }
      } }, "切到 Herdr"));
    }
    if (data.webUi.running && e.web_link) {
      const openExternal = (mode) => {
        openInWebUi(e.web_link, mode);
      };
      buttons.push(h("span", { class: "webui-open", role: "group", "aria-label": "在 herdr-web-ui 中打开" },
        h("span", { class: "webui-label" }, "herdr-web-ui"),
        h("button", { class: "btn webui-choice", type: "button", title: "继续同一个 agent：阅读 Markdown 回复和工具记录、发送附件、预览文件。对话功能随 agent 和 herdr-web-ui 版本而异。", onclick: () => openExternal("chat") },
          "对话 ↗"),
        h("button", { class: "btn webui-choice", type: "button", title: "继续操作这个终端：搜索历史输出、将选中内容引用到消息；手机可用 Esc、Tab、方向键等快捷按键。", onclick: () => openExternal("terminal") },
          "终端 ↗"),
        h("details", { class: "webui-help" },
          h("summary", { "aria-label": "在 herdr-web-ui 中打开有什么好处", title: "什么时候去 herdr-web-ui？" }, "?"),
          h("div", { class: "webui-explainer" },
            h("p", { class: "webui-explainer-title" }, "在同一个 agent 上继续"),
            h("p", null, h("strong", null, "对话"), "阅读回复和工具记录，发送附件、预览文件。"),
            h("p", null, h("strong", null, "终端"), "搜索历史、引用选中内容，使用手机快捷按键。"),
            h("p", { class: "webui-explainer-foot" }, "具体功能随 agent 和 herdr-web-ui 版本而异。")))));
    }
    return buttons;
  }

  function panelFor(e) {
    const dot = h("span", { class: "dot" });
    const whoName = h("span", { class: "who-name" });
    const whoKind = h("span", { class: "who-kind" });
    const renameButton = h("button", { class: "icon-btn rename-agent", type: "button", "aria-label": "修改 agent 名称", title: "修改真实 agent 名称，与 herdr-web-ui 同步", onclick: () => {
      if (!panel.current.can_rename || savingName) return;
      renameTerminal = panel.current.terminal_id;
      nameInput.value = panel.current.agent_name || "";
      nameError.hidden = true;
      renameForm.hidden = false;
      nameInput.focus();
      nameInput.select();
    }, html: '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="m10.5 2.5 3 3M3 10l7.5-7.5a1.4 1.4 0 0 1 2 0l1 1a1.4 1.4 0 0 1 0 2L6 13l-3.5.5L3 10Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>' });
    const who = h("span", { class: "who" }, whoKind, whoName, renameButton);
    let savingName = false;
    let renameTerminal = null;
    const nameInput = h("input", { name: "agent-name", "aria-label": "Agent 名称", maxlength: "32", autocomplete: "off", autocapitalize: "none", spellcheck: "false", placeholder: "例如 frontend 或 reviewer" });
    const nameError = h("span", { class: "rename-error", role: "alert", hidden: true });
    const closeRename = () => {
      if (savingName) return;
      renameForm.hidden = true;
      if (!disposed && !renameButton.disabled) renameButton.focus();
    };
    const saveName = h("button", { class: "btn primary", type: "submit" }, "保存");
    const cancelName = h("button", { class: "btn quiet", type: "button", onclick: closeRename }, "取消");
    const renameForm = h("form", { class: "agent-rename", hidden: true,
      onkeydown: (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRename(); } },
      onsubmit: async (event) => {
        event.preventDefault();
        if (savingName) return;
        const name = nameInput.value.trim();
        if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
          nameError.textContent = "以小写字母开头，只能包含小写字母、数字、-、_，最多 32 个字符。";
          nameError.hidden = false;
          nameInput.focus();
          return;
        }
        savingName = true;
        nameError.hidden = true;
        nameInput.disabled = saveName.disabled = cancelName.disabled = true;
        saveName.textContent = "保存中…";
        try {
          const result = await post(`/api/executions/${panel.current.id}/rename`, { name, terminal_id: renameTerminal });
          if (disposed) return;
          for (const b of data.state.broadcasts) for (const item of b.executions) {
            if (item.machine_id === panel.current.machine_id && item.terminal_id === renameTerminal) item.agent_name = result.name;
          }
          renameForm.hidden = true;
          update();
          renameButton.focus();
          toast(`已改名为 ${result.name}，herdr-web-ui 使用同一名称`);
        } catch (error) {
          if (!disposed) {
            if (/名称/.test(error.message)) { nameError.textContent = error.message; nameError.hidden = false; }
            else { renameForm.hidden = true; try { await refreshConversation(); } catch { /* automatic connection recovery */ } }
          }
        } finally {
          savingName = false;
          nameInput.disabled = saveName.disabled = cancelName.disabled = false;
          saveName.textContent = "保存";
          if (!disposed && !renameForm.hidden) nameInput.focus();
        }
      },
    }, h("div", { class: "rename-row" }, nameInput, saveName, cancelName),
      h("span", { class: "rename-hint" }, "修改真实 agent 名称，与 herdr-web-ui 同步。小写字母开头，最多 32 个字符。"), nameError);
    const state = h("span", { class: "state" });
    const identityLabel = h("summary");
    const identityHelp = h("p");
    const identityId = h("code");
    const identityInfo = h("details", { class: "identity-info" }, identityLabel, identityHelp, identityId);
    const machineName = h("span", { class: "machine-name" });
    const machineBadge = h("span", { class: "machine-badge" },
      h("span", { class: "machine-icon", "aria-hidden": "true", html: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="8.5" rx="1.5"/><path d="M8 11v2.5M5 13.5h6"/></svg>' }), machineName);
    const directory = h("span", { class: "directory" });
    const where = h("span", { class: "where" }, machineBadge, directory);
    const opensBox = h("span", { class: "opens" });
    const host = h("div", { class: "terminal-host", "aria-label": "终端：点一下后可以直接输入" });
    const connection = h("span", { role: "status" });
    const connectionAction = h("button", { class: "btn quiet", type: "button", hidden: true,
      onclick: () => connectionActionFor(panel) });
    const terminalBody = h("div", { class: "terminal-body" }, host);
    const connectionBar = h("div", { class: "terminal-status", hidden: true }, connection, connectionAction);
    const el = h("section", { class: "screen-panel", id: `exec-${e.id}`, "data-exec": String(e.id) });
    const grow = h("button", { class: "icon-btn", type: "button", "aria-pressed": "false", title: "放大（Esc 恢复）", "aria-label": "放大", html: GROW_ICON, onclick: () => toggleBig(panel) });
    // a double click on the head, not the screen: there it selects a word to copy
    const head = h("div", { class: "screen-head", ondblclick: (event) => { if (!event.target.closest("button, details")) toggleBig(panel); } },
      who, h("span", { class: "screen-status" }, dot, state, grow), where, opensBox, identityInfo);
    const pick = h("input", { type: "checkbox", class: "pick", title: "选择这个 agent，在页面上方继续广播", "aria-label": "选择此 agent 继续广播",
      onchange: () => { if (pick.checked) picked.add(panel.current.id); else picked.delete(panel.current.id); syncPicked(); } });
    head.prepend(h("label", { class: "pick-box", title: "选择这个 agent，在页面上方继续广播" }, pick));
    const typing = h("div", { class: "typing" }, "⌨ 正在输入到这个 agent");
    const panel = { el, dot, who, whoName, whoKind, renameButton, current: e, state, identityLabel, identityHelp, identityId, connection, connectionAction, connectionBar,
      where, machineName, machineBadge, directory, opensBox, host, terminalBody, grow, pick, typing,
      busy: false, live: false, resumeRequested: false, opensKey: null, recovery: null, recoveryError: null, recoveryKey: null, recoveryAttempts: 0,
      recoveryTimer: null, connectionTimer: null, connectingSince: null, dialog: null };
    panel.terminal = createBroadcastTerminal(host, e.id,
      (text) => sendTerminalInput(panel.current.id, text),
      (ready) => { panel.live = ready; el.classList.toggle("live", ready); updateTerminalDisplay(panel); maybeRecover(panel); }, screenFont.size);
    host.addEventListener("focusin", () => { typing.textContent = "⌨ 正在输入到这个 agent　点终端外面结束"; });
    el.append(head, renameForm, terminalBody, connectionBar, typing);
    observer.observe(el);
    return panel;
  }

  // ---- typing into the agents' terminals ----

  /** Selection is used only by the explicit follow-up composer, never terminal keystrokes. */
  const picked = new Set();
  let followupSending = false;
  let selectionShape = "";
  // Opened from an agent's link, the broadcast is known only once the state has arrived: the
  // draft's key is settled then, so drafts of different broadcasts never share one.
  let followupDraftKey = null;
  const draftKey = () => {
    if (followupDraftKey === null && broadcastId() !== null) {
      followupDraftKey = `broadcast.followup.${broadcastId()}`;
      if (!followupInput.value) followupInput.value = sessionStorage.getItem(followupDraftKey) || "";
    }
    return followupDraftKey;
  };
  const followupCount = h("span", { class: "followup-count" });
  const followupTargets = h("div", { class: "followup-targets" });
  const followupResult = h("div", { class: "followup-result", role: "status", hidden: true });
  const followupInput = h("textarea", { rows: "2", placeholder: "选择下方 agent，输入下一轮任务…", "aria-label": "继续广播的内容",
    oninput: () => { const key = draftKey(); if (key) sessionStorage.setItem(key, followupInput.value); syncComposer(); },
    onkeydown: (event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.isComposing) { event.preventDefault(); void sendFollowup(); } },
  });
  draftKey();
  const followupSend = h("button", { class: "btn primary", type: "submit", disabled: true }, "发送");
  const followupClear = h("button", { class: "btn quiet followup-clear", type: "button", disabled: true, onclick: () => setPicked([]) }, "清空");
  let newPicker;
  const newPickerHost = h("div");
  const addAgents = h("details", { class: "followup-add" }, h("summary", null, "新增 Agent"), newPickerHost);
  const followupBox = h("form", { class: "followup-composer", onsubmit: (event) => { event.preventDefault(); void sendFollowup(); } },
    h("div", { class: "followup-heading" },
      h("div", { class: "followup-heading-info" }, h("strong", null, "继续广播"), followupCount),
      h("div", { class: "followup-controls" },
        h("button", { class: "btn quiet", type: "button", "aria-label": "全选 agent", onclick: () => setPicked([...panels.keys()]) }, "全选"), followupClear)),
    followupTargets, followupInput, addAgents,
    h("div", { class: "followup-footer" }, h("span", { class: "followup-shortcut" }, "⌘ / Ctrl + Enter 发送"), followupSend), followupResult);
  newPicker = newAgentPicker(syncComposer);
  newPickerHost.append(newPicker.el);
  function setPicked(ids) {
    if (followupSending) return;
    picked.clear();
    for (const x of ids) picked.add(x);
    syncPicked();
  }
  function syncComposer() {
    const selected = [...picked].map(id => panels.get(id)?.current).filter(Boolean);
    const blocked = selected.filter(e => !e.can_follow_up);
    followupSend.disabled = followupSending || (!picked.size && !newPicker?.count()) || !followupInput.value.trim() || blocked.length > 0;
    const total = picked.size + (newPicker?.count() || 0);
    followupSend.textContent = followupSending ? "正在发送…" : total ? `发送给 ${total} 个 agent` : "发送";
    followupClear.disabled = followupSending || !picked.size;
    followupInput.placeholder = picked.size ? "输入下一轮任务…" : "选择下方 agent，输入下一轮任务…";
    followupInput.disabled = followupSending;
    for (const { button } of roundButtons.values()) button.disabled = followupSending;
    followupCount.textContent = `已有 ${picked.size} 个 · 新增 ${newPicker?.count() || 0} 个`;
    const shape = JSON.stringify(selected.map(e => [e.id, e.machine_label, e.agent_name, e.agent_kind]));
    if (shape !== selectionShape) {
      selectionShape = shape;
      followupTargets.replaceChildren(...selected.map(e => h("span", { class: "followup-target" }, `${e.machine_label || e.machine_id} · ${e.agent_name || e.agent_kind}`)));
    }
    followupTargets.hidden = !picked.size;
  }
  function syncPicked() {
    for (const [x, p] of panels) {
      p.pick.checked = picked.has(x);
      p.pick.disabled = followupSending;
      p.pick.title = "选择这个 agent 继续广播";
      p.el.classList.toggle("picked", picked.has(x));
    }
    syncComposer();
  }
  async function sendFollowup() {
    if (followupSending || (!picked.size && !newPicker?.count()) || !followupInput.value.trim()) return;
    if ([...picked].some(id => !panels.get(id)?.current.can_follow_up)) { syncPicked(); return; }
    const targets = [...picked].map(execution_id => ({ execution_id, terminal_id: panels.get(execution_id)?.current.terminal_id }));
    const prompt = followupInput.value;
    followupSending = true;
    newPicker.lock(true);
    followupResult.hidden = true;
    syncPicked();
    try {
      const result = await post(`/api/broadcasts/${broadcastId()}/follow-up`, { prompt, targets, ...(newPicker.count() ? { new: newPicker.specs() } : {}) });
      if (disposed) return;
      const key = draftKey();
      if (key && sessionStorage.getItem(key) === prompt) sessionStorage.removeItem(key);
      followupInput.value = "";
      newPicker.clear();
      followupResult.className = "followup-result";
      selectedRoundId = result.round_id;
      followupResult.textContent = `第 ${result.round_number} 轮已提交给 ${result.executions} 个 agent，记录保留在本页。`;
      // A failed refresh must not turn a successful submission into a retryable send failure.
      try { const fresh = await api("/api/state"); if (!disposed) data = fresh; } catch { /* SSE will catch up. */ }
      if (disposed) return;
      update();
      renderSidebar();
      followupResult.hidden = false;
      followupInput.disabled = false;
      followupInput.focus();
    } catch (error) {
      if (!disposed) { followupResult.className = "followup-result bad"; followupResult.textContent = "尚未确认提交结果，请查看任务记录。"; followupResult.hidden = false; }
    } finally { followupSending = false; if (!disposed) { newPicker.lock(false); syncPicked(); } }
  }

  function sendTerminalInput(execId, text) {
    panels.get(execId)?.terminal.send(text);
  }

  async function taskActionFor(execId, action) {
    try { await action(); }
    catch {
      try { await refreshConversation(); } catch { /* the connection bar owns connection recovery */ }
      const panel = panels.get(execId);
      if (panel?.live && panel.current.terminal_state === "live") toast("操作结果尚未确认，请查看任务记录。", true);
    }
  }

  async function refreshConversation() {
    const fresh = await api("/api/state");
    if (!disposed) { data = fresh; update(); }
  }

  function currentPanel(panel) { return !disposed && !panel.disposed && panels.get(panel.current.id) === panel; }

  async function maybeRecover(panel) {
    if (!currentPanel(panel) || !panel.terminal.active || panel.busy || panel.recoveryTimer
      || !panel.resumeRequested || ["choose", "unavailable", "failed"].includes(panel.recovery)) return;
    panel.busy = true;
    updateTerminalDisplay(panel);
    try {
      const result = await post(`/api/executions/${panel.current.id}/continue`,
        { choose_session: panel.current.resume_mode === "choose" });
      if (!currentPanel(panel)) return;
      panel.resumeRequested = false;
      panel.recovery = result.mode === "unavailable" ? "unavailable" : null;
      try { await refreshConversation(); }
      catch { panel.recovery = "connecting"; return; }
      if (currentPanel(panel)) {
        panel.terminal.activate();
        if (["choose", "inspect"].includes(result.mode) && panel.current.terminal_state !== "live") {
          showConnectionDialog(panel, panel.current.restore_kind === "choose" ? "choose" : panel.current.restore_kind === "identity" ? "identity" : "confirm");
        }
      }
    } catch (error) {
      if (currentPanel(panel)) {
        if (error && error.status >= 400 && error.status < 500) {
          // the server refused: asking again on a timer would only repeat it, so a click retries
          panel.resumeRequested = false;
          panel.recovery = "failed";
          panel.recoveryError = error.message;
        } else {
          panel.recovery = "connecting";
          panel.recoveryTimer = setTimeout(() => { panel.recoveryTimer = null; maybeRecover(panel); },
            Math.min(10000, 1000 * 2 ** Math.min(panel.recoveryAttempts++, 4)));
        }
      }
    } finally { panel.busy = false; if (currentPanel(panel)) updateTerminalDisplay(panel); }
  }

  async function resumeConversation(panel) {
    if (panel.busy) return;
    panel.resumeRequested = true;
    panel.recovery = "connecting";
    await maybeRecover(panel);
  }

  function closePanelDialog(panel) {
    const dialog = panel.dialog;
    if (!dialog) return;
    dialog.el.close();
    dialog.cleanup();
  }

  function showConnectionDialog(panel, kind, options = []) {
    for (const p of panels.values()) closePanelDialog(p);
    if (!currentPanel(panel)) return;
    const title = h("h2", null, kind === "new" ? "新建对话" : kind === "choose" ? "选择要继续的对话" : kind === "identity" ? "核对原会话" : "查看终端");
    const body = h("div", { class: "connection-dialog-body" });
    const primary = h("button", { class: "btn primary", type: "button" }, kind === "new" ? "新建" : panel.current.manual_session ? "已恢复此会话" : "继续此对话");
    const cancel = h("button", { class: "btn quiet", type: "button", onclick: () => closePanelDialog(panel) }, "取消");
    const dialog = h("dialog", { class: "connection-dialog", "aria-label": title.textContent }, title, body,
      h("div", { class: "connection-dialog-actions" }, cancel, primary));
    const native = kind !== "new" && options.length === 0;
    let selected = null;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (native) { panel.terminalBody.append(panel.host); panel.terminal.pinned(false); }
      if (panel.dialog?.el === dialog) panel.dialog = null;
      dialog.remove();
    };
    panel.dialog = { el: dialog, kind, native, primary, cleanup };
    if (kind === "new") body.append(h("p", null, "新对话不包含原对话记录。"));
    else if (options.length) {
      primary.disabled = true;
      for (const option of options) body.append(h("label", { class: "conversation-option" },
        h("input", { type: "radio", name: `conversation-${panel.current.id}`, onchange: () => { selected = option.terminal_id; primary.disabled = false; } }), option.label));
    } else {
      if (kind === "identity") body.append(h("p", null, "暂时无法自动核实会话身份。请核对下方是否为原对话，确认后可继续广播；不会重新发送历史任务。"));
      body.append(panel.host);
      panel.terminal.pinned(true);
      primary.hidden = !panel.current.can_confirm_session;
    }
    primary.addEventListener("click", async () => {
      if (panel.busy) return;
      if (kind === "new") {
        const e = panel.current;
        sessionStorage.setItem(PREFILL_KEY, JSON.stringify({ title: "", prompt: "", targets: [],
          fresh: e.cwd ? [{ machine: e.machine_id, cwd: e.cwd, kind: e.agent_kind, count: 1 }] : [] }));
        closePanelDialog(panel); go("#/new"); return;
      }
      panel.busy = true; primary.disabled = true;
      try {
        await post(`/api/executions/${panel.current.id}/${selected ? "select-conversation" : "confirm-session"}`, { terminal_id: selected || panel.current.terminal_id });
        panel.recovery = null;
        await refreshConversation();
        closePanelDialog(panel);
      } catch {
        try { await refreshConversation(); } catch { /* no raw connection errors on the card */ }
      } finally { panel.busy = false; if (currentPanel(panel)) updateTerminalDisplay(panel); }
    });
    dialog.addEventListener("close", cleanup);
    main.append(dialog);
    dialog.showModal();
    if (native) { panel.terminal.activate(); panel.terminal.focusWhenReady(); }
  }

  async function connectionActionFor(panel) {
    if (panel.busy) return;
    const display = connectionPresentation(panel.current, panel.live, panel.recovery);
    if (display.action === "custom-startup") {
      panel.busy = true;
      try { await post(`/api/executions/${panel.current.id}/confirm-startup`, { terminal_id: panel.current.terminal_id }); await refreshConversation(); }
      catch (error) { toast(error.message, true); }
      finally { panel.busy = false; if (currentPanel(panel)) updateTerminalDisplay(panel); }
      return;
    }
    if (display.action === "settings") {
      sessionStorage.setItem("broadcast.connection-settings", JSON.stringify({ machine: panel.current.machine_label || panel.current.machine_id,
        reason: panel.current.resume_reason || "请检查这台设备的连接配置。" }));
      go("#/machines"); return;
    }
    if (display.action === "new") { showConnectionDialog(panel, "new"); return; }
    if (display.action === "continue") { await resumeConversation(panel); return; }
    if (display.action === "choose" && panel.current.terminal_state === "conflict") {
      panel.busy = true;
      try {
        const result = await api(`/api/executions/${panel.current.id}/conversation-options`);
        if (currentPanel(panel) && result.options.length) showConnectionDialog(panel, "choose", result.options);
        else await refreshConversation();
      } catch { /* automatic state refresh resolves connection races */ }
      finally { panel.busy = false; if (currentPanel(panel)) updateTerminalDisplay(panel); }
      return;
    }
    if (display.action === "choose" && panel.current.terminal_state === "closed") { await resumeConversation(panel); return; }
    if (["confirm", "choose", "identity"].includes(display.action)) showConnectionDialog(panel, display.action);
  }

  function disposePanel(panel) {
    panel.disposed = true;
    closePanelDialog(panel);
    clearTimeout(panel.connectionTimer);
    clearTimeout(panel.recoveryTimer);
    panel.terminal.dispose();
  }

  function updateTerminalDisplay(panel) {
    if (panel.disposed) return;
    const e = panel.current;
    const live = panel.live && SHOWN.includes(e.terminal_state);
    const shown = (panel.live || panel.terminal.hasScreen) && SHOWN.includes(e.terminal_state);
    panel.host.style.visibility = shown ? "visible" : "hidden";
    panel.host.setAttribute("aria-hidden", String(!shown));
    const display = connectionPresentation(e, live, panel.busy ? "connecting" : panel.recovery, panel.terminal.handedOff);
    panel.connection.textContent = display.text;
    // the server's reason, for whoever looks closer; the card itself stays one short line
    panel.connection.title = display.detail ?? (display.kind === "failed" ? panel.recoveryError || "" : "");
    panel.connectionAction.textContent = display.button;
    panel.connectionAction.hidden = !display.action;
    panel.connectionAction.disabled = panel.busy;
    if (display.kind === "connecting") {
      if (!panel.terminal.active || document.hidden) {
        clearTimeout(panel.connectionTimer); panel.connectionTimer = null; panel.connectingSince = null;
        panel.connectionBar.hidden = true;
      } else {
        if (panel.connectingSince === null) {
          panel.connectingSince = Date.now();
          panel.connectionTimer = setTimeout(() => { panel.connectionTimer = null; if (!disposed) updateTerminalDisplay(panel); }, 2000);
        }
        panel.connectionBar.hidden = Date.now() - panel.connectingSince < 2000 || document.hidden;
      }
    } else {
      clearTimeout(panel.connectionTimer); panel.connectionTimer = null; panel.connectingSince = null;
      panel.connectionBar.hidden = !display.text;
    }
    if (panel.dialog && panel.dialog.kind !== "new") {
      if (display.kind === "ready") closePanelDialog(panel);
      else if (panel.dialog.native) {
        panel.dialog.primary.hidden = !e.can_confirm_session;
        panel.dialog.primary.disabled = panel.busy;
      }
    }
  }

  /** one agent across the whole row, taller, to read it closely; again to put it back */
  function toggleBig(panel, big = !panel.el.classList.contains("big")) {
    panel.el.classList.toggle("big", big);
    panel.grow.innerHTML = big ? SHRINK_ICON : GROW_ICON;
    panel.grow.setAttribute("aria-pressed", String(big));
    panel.grow.setAttribute("aria-label", big ? "恢复" : "放大");
    panel.grow.title = big ? "恢复（Esc）" : "放大（Esc 恢复）";
    if (big) panel.el.scrollIntoView({ block: "nearest" });
  }

  function dismissWebUiHelp(event) {
    for (const help of main.querySelectorAll(".webui-help[open]")) {
      if (!help.contains(event.target)) help.open = false;
    }
  }

  /** Esc closes help first, then restores enlarged panels. */
  function escape() {
    for (const p of panels.values()) if (p.dialog) { closePanelDialog(p); return true; }
    const help = main.querySelector(".webui-help[open]");
    if (help) {
      help.open = false;
      help.querySelector("summary").focus();
      return true;
    }
    const big = [...panels.values()].filter((p) => p.el.classList.contains("big"));
    for (const p of big) toggleBig(p, false);
    return big.length > 0;
  }

  function patch(panel, e) {
    const recoveryKey = `${e.machine_id}:${e.terminal_id}:${e.session_value}`;
    if (panel.recoveryKey !== recoveryKey || SHOWN.includes(e.terminal_state)) {
      panel.recovery = null;
      if (panel.recoveryKey !== recoveryKey) { clearTimeout(panel.recoveryTimer); panel.recoveryTimer = null; }
    }
    panel.recoveryKey = recoveryKey;
    panel.current = e;
    panel.renameButton.disabled = !e.can_rename;
    panel.renameButton.hidden = !e.can_rename;
    panel.renameButton.title = e.can_rename ? "修改真实 agent 名称，与 herdr-web-ui 同步" : "修改名称";
    panel.el.classList.toggle("ask", e.agent_status === "blocked");
    panel.el.classList.toggle("inactive", ["closed", "not_started"].includes(e.terminal_state));
    panel.dot.className = `dot ${tone(e.state)}`;
    const kind = ({ claude: "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode", gemini: "Gemini", custom: "自定义 agent" })[e.agent_kind] || e.agent_kind || "Agent";
    // Use the same real name that Herdr and herdr-web-ui show; do not invent local numbering.
    const title = e.agent_name || kind;
    if (panel.whoName.textContent !== title) panel.whoName.textContent = title;
    if (panel.whoKind.textContent !== kind) panel.whoKind.textContent = kind;
    panel.whoName.hidden = title.toLowerCase() === kind.toLowerCase();
    panel.who.title = [
      `类型：${kind}`, e.agent_name ? `Agent 名称：${e.agent_name}` : "此 agent 未命名",
      e.target_kind === "new" ? "来源：为这次广播新建" : "来源：已有会话",
    ].filter(Boolean).join("\n");
    const activity = e.agent_status ? `　·　Agent ${AGENT_STATUS[e.agent_status] || e.agent_status}` : "";
    panel.state.className = `state c-${tone(e.state)}`;
    const round = findBroadcast(broadcastId())?.rounds?.find(r => r.id === e.round_id);
    panel.state.textContent = `${round ? `第 ${round.number} 轮` : "最近任务"}：${label(e.state)}${activity}`;
    const binding = identityPresentation(e);
    panel.identityLabel.textContent = binding.label;
    panel.identityHelp.textContent = binding.help;
    panel.identityId.textContent = e.session_value || "";
    panel.identityId.hidden = !e.session_value;
    panel.state.title = "广播记录表示发送结果；Agent 状态是当前状态，不能据此判断这条消息是否执行完成。";
    const machineName = e.machine_label || e.machine_id;
    if (panel.machineName.textContent !== machineName) panel.machineName.textContent = machineName;
    panel.machineBadge.title = `所在机器：${machineName}`;
    const directory = e.cwd ? baseName(e.cwd) : "";
    if (panel.directory.textContent !== directory) panel.directory.textContent = directory;
    panel.directory.hidden = !directory;
    panel.directory.title = e.cwd || "";
    panel.where.title = [
      `机器：${e.machine_label || e.machine_id}`, e.cwd ? `目录：${e.cwd}` : null,
      e.workspace_label ? `工作区：${e.workspace_label}` : null, e.pane_id ? `终端：${e.pane_id}` : null,
    ].filter(Boolean).join("\n");
    // its machine not answering says more than any state it had
    const down = !!e.pane_id && machineDown(e.machine_id);
    panel.el.classList.toggle("down", down);
    const opensKey = `${e.id}|${e.state}|${e.agent_status}|${!!e.note}|${e.can_retry}|${e.can_cancel_start}|${e.pane_id}|${e.terminal_id}|${e.web_link}|${data.webUi.running}|${e.terminal_state}`;
    if (panel.opensKey !== opensKey) {
      panel.opensKey = opensKey;
      panel.opensBox.replaceChildren(...opens(e));
    }
    const available = !!e.pane_id && !down && SHOWN.includes(e.terminal_state);
    panel.terminal.execution(e.id);
    // only a pane with a conversation in it takes a wrapped paste; a bare shell takes lines
    panel.terminal.agent(["live", "restoring"].includes(e.terminal_state));
    panel.terminal.available(available ? `${e.machine_id}:${e.pane_id}:${e.terminal_id}` : null);
    panel.pick.disabled = followupSending;
    updateTerminalDisplay(panel);
    maybeRecover(panel);
  }

  function update() {
    newPicker.refresh();
    const broadcast = findBroadcast(broadcastId());
    if (!broadcast) {
      for (const panel of panels.values()) {
        disposePanel(panel);
        observer.unobserve(panel.el);
      }
      panels.clear();
      picked.clear();
      titleEl.textContent = "";
      actions.replaceChildren();
      actionsFor = null;
      body.replaceChildren(h("p", { class: "empty-note" }, loaded ? "这条广播已被删除。" : "读取中…"));
      return;
    }
    const b = broadcastRound(broadcast, selectedRoundId, focused ? null : focusExec);
    draftKey();
    // Keep reading a chosen round as updates arrive. After sending, wait for that new round.
    if (selectedRoundId === null) selectedRoundId = b.round?.id ?? null;
    if (!body.contains(wall)) body.replaceChildren(roundContext, followupBox, summary, hint, wall);
    roundHistory.hidden = (broadcast.rounds?.length || 1) <= 1;
    roundHeading.textContent = "轮次";
    for (const round of broadcast.rounds || []) {
      let entry = roundButtons.get(round.id);
      if (!entry) {
        const name = h("strong");
        const button = h("button", { class: "round-option", type: "button", onclick: () => {
          if (followupSending || selectedRoundId === round.id) return;
          selectedRoundId = round.id;
          promptDetails.open = true;
          update();
        } }, name);
        entry = { button, name };
        roundButtons.set(round.id, entry);
        roundList.append(button);
      }
      entry.name.textContent = `第 ${round.number} 轮`;
      entry.button.title = `查看第 ${round.number} 轮任务输入`;
      entry.button.classList.toggle("current", round.id === b.round?.id);
      entry.button.setAttribute("aria-pressed", String(round.id === b.round?.id));
      entry.button.disabled = followupSending;
    }
    // Round selection only changes the reference input. Reuse live panels even when a
    // follow-up adds a newer execution for the same conversation.
    const agents = broadcastAgents(broadcast);
    for (const e of agents) {
      if (!panels.has(e.id)) {
        const existing = [...panels.values()].find(p => broadcastAgentKey(p.current) === broadcastAgentKey(e));
        if (existing) {
          const previousId = existing.current.id;
          panels.delete(previousId);
          panels.set(e.id, existing);
          existing.el.id = `exec-${e.id}`;
          existing.el.dataset.exec = String(e.id);
          if (picked.delete(previousId)) picked.add(e.id);
        } else {
          const panel = panelFor(e);
          panels.set(e.id, panel);
          wall.append(panel.el);
        }
      }
      patch(panels.get(e.id), e);
    }
    const visibleIds = new Set(agents.map(e => e.id));
    for (const [execId, panel] of panels) {
      if (visibleIds.has(execId)) continue;
      disposePanel(panel);
      observer.unobserve(panel.el);
      panel.el.remove();
      panels.delete(execId);
      picked.delete(execId);
    }
    titleEl.textContent = b.title;
    if (promptText.textContent !== b.prompt) {
      promptText.textContent = b.prompt;
      promptText.scrollTop = 0;
    }
    roundLabel.textContent = `第 ${b.round?.number || 1} 轮`;
    metaText.textContent = `${b.total} 个 agent · ${ago(b.created_at)}发出`;
    hint.hidden = !data.webUi.running && !data.webUi.installed;
    const hintText = "" + (data.webUi.running
      ? "勾选 agent 后可在上方继续广播；直接操作终端只影响当前 agent。细读回复、发附件或搜索历史，可进入 herdr-web-ui。"
      : data.webUi.installed
        ? "启动 herdr-web-ui 后，可从卡片右上角继续同一个 agent：在对话视图读回复、发附件，或在终端视图搜索历史、引用内容。"
        : "安装 herdr-web-ui，可在同一个 agent 上使用对话阅读、附件、文件预览和终端历史搜索。");
    if (hint.textContent !== hintText) hint.textContent = hintText;
    renderSummary({ executions: agents });
    syncPicked();
    const focusedExecution = broadcast.executions.find(e => e.id === focusExec);
    const focusedAgent = focusedExecution && agents.find(e => broadcastAgentKey(e) === broadcastAgentKey(focusedExecution));
    if (!focused && focusedAgent && panels.has(focusedAgent.id)) {
      focused = true;
      flash(panels.get(focusedAgent.id).el);
    }
    // rebuilt only when what they act on changes, so a half-pressed button stays armed
    const shape = `${b.id}:${b.round?.id}`;
    if (shape !== actionsFor) {
      actionsFor = shape;
      actions.replaceChildren(...[
        // an unsent draft in the form would be replaced: that takes a second press
        confirmButton("另建广播", "再点一次覆盖草稿", async () => rebroadcast(broadcastRound(findBroadcast(b.id) || b, selectedRoundId)),
          { class: "btn quiet", title: "用本轮指令和参与的 agent 新建独立广播，发之前可以修改" },
          () => { const draft = loadDraft(); return !!(draft.prompt || "").trim() && draft.prompt !== b.prompt; }),
        confirmButton("删除记录", "再点一次删除", async () => {
          await api(`/api/broadcasts/${b.id}`, { method: "DELETE" });
          toast("已删除");
          go("");
        }, { class: "btn quiet", title: "仅删除历史记录；不会撤回已发送的消息，也不会关闭 agent 或 pane" }),
      ].filter(Boolean));
    }
  }

  // Dismiss before another control acts, including terminal clicks and keyboard focus changes.
  const helpDismissEvents = ["pointerdown", "click", "focusin"];
  for (const type of helpDismissEvents) document.addEventListener(type, dismissWebUiHelp, true);
  update();
  return { update, escape, dispose() {
    newPicker.dispose();
    disposed = true;
    for (const type of helpDismissEvents) document.removeEventListener(type, dismissWebUiHelp, true);
    for (const panel of panels.values()) disposePanel(panel);
    clearInterval(ticker);
    observer.disconnect();
  } };
}

/** Binding is independent of submission and current agent activity. */
function identityPresentation(e) {
  const check = e.identity_check;
  const reasons = {
    report_timeout: "本轮等待已结束，期间未收到原生会话标识。",
    proof_timeout: "已收到原生会话标识，但在等待期限内未能核实本轮输入。",
    unsupported: "此 agent 尚不支持延迟身份的自动核验，请人工核对会话。",
    unavailable: "已收到原生会话标识，但无法读取对应会话记录完成核验。",
    changed: "核验期间终端或会话身份不一致，未自动绑定。",
    cancelled: "本轮身份核验已中断，可人工核对当前会话。",
  };
  let reason = reasons[check?.state] || "";
  if (check?.state === "unavailable" && !check.reported_at) reason = "无法读取终端的会话上报，请人工核对。";
  if (check?.state === "unavailable" && check.reason === "read_limit") reason = "已收到原生会话标识，但对应会话记录超过读取限制，未完成核验。";
  if (["waiting_report", "verifying"].includes(check?.state) && e.identity_state !== "pending") reason = "上次身份核验未完成；服务不会自动重试，可人工核对当前会话。";
  const suffix = reason + "关闭浏览器标签不会停止 agent；再次打开可连接仍在运行的终端。";
  if (e.session_value) return { label: "已绑定原生会话", help: `已保存原生会话标识。即使 agent 进程退出，只要原机器上的历史仍在，点击继续对话即可按此标识恢复。${suffix}` };
  if (e.identity_state === "pending") return { label: "正在核验原生会话", help: `本轮已提交，${check?.reported_at ? "已收到标识，正在核验对应会话记录" : "正在等待会话标识上报"}；发送成功不等于绑定成功。${suffix}` };
  if (e.identity_state === "manual") return { label: "人工确认的终端 · 未绑定原生会话", help: `当前按你的确认使用此终端，尚未保存原生会话 ID。进程退出或服务重启后需要重新核对，可能需要手动选择历史；进程内切换会话后也请重新绑定。${suffix}` };
  return { label: "尚未绑定原生会话", help: `安装集成用于让 agent 上报会话标识，安装成功并不表示此会话已绑定。请在终端完成 hooks 信任并返回输入框；仍无法取得标识时可人工核对。关闭 agent 进程后，可能需要手动选择历史。${suffix}` };
}

// ---- wiring -----------------------------------------------------------------------------

function connect() {
  const source = new EventSource("/api/events");
  // the build this page's script came with: a server restarted on other files serves another script
  let served = null;
  source.onmessage = (event) => {
    data = JSON.parse(event.data);
    const build = data.build;
    if (build && served && build !== served) return location.reload();
    if (build) served = build;
    loaded = true;
    noticeWaiting();
    renderMachines();
    renderUpdate();
    renderSidebar();
    if (view) view.update();
  };
}

$("new").addEventListener("click", () => go("#/new"));
$("machines").addEventListener("click", () => go("#/machines"));
$("settings").addEventListener("click", () => go("#/settings"));
document.addEventListener("visibilitychange", renderUpdateNotice);
addEventListener("storage", (event) => { if (event.key === UPDATE_DISMISS_KEY) renderUpdateNotice(); });
$("search").addEventListener("input", () => renderSidebar());
$("search").addEventListener("keydown", (event) => { if (event.key === "Escape") event.target.blur(); });
addEventListener("hashchange", route);
// the home screen is the list on a phone and a new broadcast on a desktop: crossing over redraws it
matchMedia("(max-width: 820px)").addEventListener("change", () => { if (parseRoute().name === "home") route(); });

/** Moves to the broadcast `step` places down the sidebar (up when negative), as it is filtered. */
function stepBroadcast(step) {
  const order = sidebarGroups().groups.flatMap(([, items]) => items.map((b) => b.id));
  if (order.length === 0) return;
  const at = order.indexOf(currentBroadcastId());
  const next = at < 0 ? (step > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, at + step));
  if (order[next] === currentBroadcastId()) return;
  revealCurrent = true;
  go(`#/b/${order[next]}`);
}

/** N new, / search, J and K down and up the broadcasts, Esc puts a big panel back. Not while typing. */
addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
  // a terminal on the page takes every key, Esc included
  if (event.defaultPrevented || (event.target.closest && event.target.closest(".terminal-host"))) return;
  const typing = event.target.closest && event.target.closest("input, textarea, select, [contenteditable]");
  if (event.key === "Escape") {
    if (!typing && view && view.escape && view.escape()) event.preventDefault();
    return;
  }
  if (typing) return;
  const key = event.key.toLowerCase();
  if (key === "n") go("#/new");
  else if (event.key === "/") {
    // on a phone the search is on the list screen
    if (matchMedia("(max-width: 820px)").matches && document.body.classList.contains("in-main")) go("");
    $("search").focus();
  } else if (key === "j") stepBroadcast(1);
  else if (key === "k") stepBroadcast(-1);
  else return;
  event.preventDefault();
});
// relative times move without new data
setInterval(() => { renderSidebar(); if (view && parseRoute().name === "broadcast") view.update(); }, 30000);
renderNotify();

api("/api/config").then((c) => { config = c; }).catch(() => {}).finally(() => { route(); connect(); });
