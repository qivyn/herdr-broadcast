/* global Terminal, FitAddon, UnicodeGraphemesAddon */
"use strict";

/** One xterm and one persistent connection per visible agent. No input survives a disconnect. */
function createBroadcastTerminal(host, execId, onInput, onReady, fontSize) {
  const term = new Terminal({
    cursorBlink: true, scrollback: 0, convertEol: false, fontSize,
    fontFamily: '"SF Mono", Menlo, Consolas, "PingFang SC", "Microsoft YaHei", monospace',
    theme: { background: "#1d1c1a", foreground: "#e6e3d9", cursor: "#e6e3d9", selectionBackground: "#706354" },
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new UnicodeGraphemesAddon.UnicodeGraphemesAddon());
  let opened = false;
  let socket = null;
  let available = null;
  let visible = false;
  let pinned = false;
  let ready = false;
  let hasScreen = false;
  let disposed = false;
  let handedOff = false;
  let resizeFrame = null;
  let lastSize = "";
  let outputBytes = 0;
  let focusPending = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let foreground = !document.hidden && document.hasFocus();
  let takeoverPending = foreground;
  let takeoverInFlight = false;
  const focusIfReady = () => {
    if (!focusPending || !ready || disposed || document.hidden) return;
    focusPending = false;
    host.scrollIntoView({ block: "nearest", inline: "nearest" });
    term.focus();
  };
  const setReady = (value) => { ready = value; if (!value) dropInput(); onReady(value); if (value) focusIfReady(); };
  const cancelFocus = () => { focusPending = false; };
  const focusElsewhere = (event) => { if (!host.contains(event.target)) cancelFocus(); };
  document.addEventListener("pointerdown", focusElsewhere);
  document.addEventListener("focusin", focusElsewhere);
  const send = (message) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 64 * 1024) { disconnect(); autoReconnect(); return false; }
    socket.send(JSON.stringify(message));
    return true;
  };
  /**
   * Our stream is herdr's rendered screen, not the program's bytes, so xterm never sees the
   * `ESC[?2004h` that turns on bracketed paste and would send a paste as plain lines: in a TUI
   * every newline would submit. herdr-web-ui closes this with bracketed paste when it has a pty;
   * here a paste into an agent's pane is wrapped the same way, as many pieces as a message needs.
   */
  const PASTE_START = "\u001b[200~";
  const PASTE_END = "\u001b[201~";
  const INPUT_CHUNK = 8192;
  let pasting = false;
  let agentPane = true;
  let inputQueue = [];
  let inputTimer = null;
  const wrap = (text) => PASTE_START + text + PASTE_END;
  /** the pieces one input becomes: a paste wrapped (unless the program was seen to ask for it) */
  const pieces = (text) => {
    if (!text.length) return [];
    const bracketed = text.startsWith(PASTE_START) && text.endsWith(PASTE_END);
    const body = bracketed ? text.slice(PASTE_START.length, text.length - PASTE_END.length) : text;
    const wants = bracketed || (pasting && agentPane && /[\r\n]/.test(body));
    const out = [];
    for (let start = 0; start < body.length;) {
      let end = Math.min(body.length, start + INPUT_CHUNK);
      // a surrogate pair is two units: keep it whole
      const code = body.charCodeAt(end - 1);
      if (end < body.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
      const piece = body.slice(start, end);
      out.push(wants ? wrap(piece) : piece);
      start = end;
    }
    return out;
  };
  const drainInput = () => {
    inputTimer = null;
    while (inputQueue.length) {
      if (!socket || socket.readyState !== WebSocket.OPEN || !ready) { inputQueue = []; return; }
      if (socket.bufferedAmount > 32 * 1024) { inputTimer = setTimeout(drainInput, 20); return; }
      if (!send({ type: "input", text: inputQueue.shift() })) { inputQueue = []; return; }
    }
  };
  const sendInput = (text) => {
    inputQueue.push(...pieces(text));
    if (inputQueue.length === 0) return true;
    if (inputTimer === null) drainInput();
    return true;
  };
  const dropInput = () => {
    inputQueue = [];
    clearTimeout(inputTimer);
    inputTimer = null;
  };
  // A paste is text, even when it is one letter: xterm handles the DOM paste right after this
  host.addEventListener("paste", () => {
    pasting = true;
    queueMicrotask(() => { pasting = false; });
  }, true);
  function resize() {
    resizeFrame = null;
    if (disposed || !opened || !visible || host.clientWidth < 20 || host.clientHeight < 20) return;
    fit.fit();
    const size = `${term.cols}:${term.rows}`;
    if (ready && size !== lastSize) {
      lastSize = size;
      send({ type: "resize", cols: Math.min(500, term.cols), rows: Math.min(200, term.rows) });
    }
  }
  const scheduleResize = () => { if (resizeFrame === null) resizeFrame = requestAnimationFrame(resize); };
  const observer = new ResizeObserver(scheduleResize);
  observer.observe(host);

  function disconnect() {
    clearTimeout(reconnectTimer); reconnectTimer = null;
    const previous = socket;
    socket = null;
    takeoverInFlight = false;
    setReady(false);
    if (previous) previous.close();
  }
  function autoReconnect() {
    if (disposed || handedOff || !available || !(visible || pinned) || !foreground || document.hidden) return;
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, Math.min(10000, 500 * 2 ** Math.min(reconnectAttempt++, 5)));
  }
  function connect() {
    if (disposed || handedOff || !available || !(visible || pinned) || !foreground || document.hidden || socket) return;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    if (!opened) { term.open(host); opened = true; }
    resize();
    const url = new URL(`/api/executions/${execId}/terminal`, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("cols", String(Math.min(500, term.cols)));
    url.searchParams.set("rows", String(Math.min(200, term.rows)));
    // Foreground activation grants one attempt. Timers and ownership loss never renew it.
    if (takeoverPending) url.searchParams.set("takeover", "1");
    takeoverInFlight = takeoverPending;
    takeoverPending = false;
    const ws = new WebSocket(url);
    socket = ws;
    outputBytes = 0;
    let first = true;
    let failed = false;
    lastSize = `${term.cols}:${term.rows}`;
    setReady(false);
    // A reset is queued with the new first frame, after any old writes already in xterm.
    ws.onmessage = (event) => {
      if (socket !== ws || disposed) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === "status" && message.state === "waiting") {
          takeoverInFlight = false;
          setReady(false);
          return;
        }
        if (message.type === "error") {
          takeoverInFlight = false;
          failed = true;
          if (message.canTakeover === true) {
            // Another client owns the terminal now. Only user activation may reclaim it.
            handedOff = true;
            takeoverPending = false;
            cancelFocus();
            disconnect();
          } else setReady(false);
          return;
        }
        if (message.type !== "output" || failed) return;
        const bytes = Uint8Array.from(atob(message.data), (c) => c.charCodeAt(0));
        outputBytes += bytes.length;
        if (outputBytes > 8 * 1024 * 1024) {
          disconnect(); autoReconnect(); return;
        }
        if (first) { term.write("\x1bc"); first = false; }
        term.write(bytes, () => {
          if (disposed || socket !== ws || failed) return;
          outputBytes -= bytes.length;
          if (!send({ type: "ack", seq: message.seq })) return;
          hasScreen = true;
          if (!ready) { takeoverInFlight = false; reconnectAttempt = 0; setReady(true); scheduleResize(); }
        });
      } catch {
        failed = true;
        disconnect();
        autoReconnect();
      }
    };
    ws.onerror = () => {
      if (socket !== ws) return;
      disconnect(); autoReconnect();
    };
    ws.onclose = () => {
      if (socket !== ws || disposed) return;
      socket = null;
      takeoverInFlight = false;
      setReady(false);
      autoReconnect();
    };
  }

  // xterm handles the browser's IME, paste, control keys and escape sequences.
  // Rendered Herdr frames need no device replies. Consume queries so replies cannot be
  // mistaken for user input (especially when broadcasting to several selected agents).
  const queries = [
    term.parser.registerCsiHandler({ final: "c" }, () => true),
    term.parser.registerCsiHandler({ prefix: ">", final: "c" }, () => true),
    term.parser.registerCsiHandler({ final: "n" }, () => true),
    term.parser.registerCsiHandler({ prefix: "?", final: "n" }, () => true),
  ];
  const input = term.onData((text) => {
    if (!foreground || document.hidden) return;
    if (!ready) { if (!socket) autoReconnect(); return; }
    onInput(text);
  });
  term.attachCustomKeyEventHandler((event) => {
    // Preserve browser copy/paste, while Ctrl+C without a selection still interrupts.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && term.hasSelection()) return false;
    if (event.metaKey && event.key.toLowerCase() === "v") return false;
    if (event.type === "keydown" && !event.isComposing && ["PageUp", "PageDown"].includes(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      if (ready) send({ type: "scroll", direction: event.key === "PageUp" ? "up" : "down", lines: Math.max(1, term.rows - 1) });
      return false;
    }
    return true;
  });
  host.addEventListener("wheel", (event) => {
    if (!ready || !event.deltaY || event.ctrlKey) return;
    event.preventDefault(); event.stopPropagation();
    send({ type: "scroll", direction: event.deltaY < 0 ? "up" : "down", lines: Math.min(100, Math.max(1, Math.ceil(Math.abs(event.deltaY) / (event.deltaMode ? 1 : 35)))) });
  }, { passive: false, capture: true });
  const activate = () => {
    if (disposed || document.hidden || !document.hasFocus()) return;
    const returning = !foreground || handedOff;
    foreground = true;
    handedOff = false;
    if (!ready) {
      if (takeoverInFlight && socket && !returning) return;
      takeoverPending = true;
      disconnect(); connect();
    }
  };
  const back = () => { if (!foreground || handedOff) activate(); };
  const leave = () => {
    foreground = false;
    takeoverPending = false;
    cancelFocus(); dropInput();
    clearTimeout(reconnectTimer); reconnectTimer = null;
  };
  const visibility = () => { if (document.hidden) leave(); else back(); };
  // Keep the last screen on disconnect; both it and its body can reclaim control on a click.
  const activationBody = host.parentElement;
  host.addEventListener("pointerdown", activate);
  activationBody?.addEventListener("pointerdown", activate);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("focus", back);
  window.addEventListener("blur", leave);
  return {
    get ready() { return ready && socket?.readyState === WebSocket.OPEN; },
    get hasScreen() { return hasScreen; },
    get handedOff() { return handedOff; },
    send(text) { return ready && foreground && !document.hidden && sendInput(text); },
    get active() { return !disposed && foreground && !handedOff && !document.hidden && (visible || pinned); },
    // Follow-up rounds share this connection; use the latest record only on a future reconnect.
    execution(id) { execId = id; },
    /** an agent's pane, whose TUI takes a wrapped paste; a plain shell takes lines */
    agent(value) { agentPane = value; },
    available(key) {
      if (available === key) return;
      available = key;
      hasScreen = false;
      disconnect();
      if (key) connect();
    },
    activate,
    ensureConnected() { connect(); },
    focusWhenReady() { if (!disposed) { focusPending = true; focusIfReady(); } },
    cancelFocus,
    visible(value) {
      visible = value;
      if (value) { connect(); scheduleResize(); }
      else if (!pinned) disconnect();
    },
    pinned(value) { pinned = value; if (value) connect(); else if (!visible) disconnect(); },
    font(size) { term.options.fontSize = size; scheduleResize(); },
    dispose() {
      disposed = true;
      disconnect();
      observer.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("pointerdown", focusElsewhere);
      document.removeEventListener("focusin", focusElsewhere);
      window.removeEventListener("focus", back);
      window.removeEventListener("blur", leave);
      host.removeEventListener("pointerdown", activate);
      activationBody?.removeEventListener("pointerdown", activate);
      input.dispose(); queries.forEach((query) => query.dispose());
      term.dispose();
    },
  };
}
