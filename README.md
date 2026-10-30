# herdr-broadcast

A [Herdr](https://herdr.dev) plugin that sends **one prompt to many agents at once** from a web page, and shows every agent's screen while it works.

- **Broadcast** a prompt to agents that are already running, to agents it starts for you, or to both, on the local machine or on Herdr's saved SSH machines.
- **Watch** each agent’s interactive terminal and live status alongside the broadcast’s delivery results. A live agent status does not establish whether a particular message has finished.
- **Immediate delivery**: submitting a broadcast sends to each selected agent, including working agents. Each agent handles its own message scheduling. Broadcast is a shortcut for pasting the same prompt into several agents, not a task scheduler.
- **Independent of the browser**: an accepted send or agent launch finishes even if the page closes. There is no persisted message queue, idle wait, automatic retry or replay after restart.

## Install

Requires Herdr 0.9.5+ on each connected machine and [Bun](https://bun.sh) 1.4+; installation installs the xterm.js assets served by the plugin.

```bash
herdr plugin install qivyn/herdr-broadcast
```

Then open **http://127.0.0.1:7318**. The page starts with Herdr; after installing, start it once by hand (or restart Herdr):

```bash
herdr plugin action invoke qivyn.herdr-broadcast.web
```

GitHub installations use the action prefix `qivyn.herdr-broadcast`; local `herdr plugin link` installations use `herdr-broadcast`.

## The web page

- **新建广播**: two tabs, new agents (the default) and agents already running, with the prompt in the centered composer (`Enter` sends, `Shift+Enter` adds a line). The centered prompt composer sits above the recipient picker. New agents start in a fresh session: pick the type, then `+` beside a folder where agents run now, or type another folder (on this machine, the folders under what you type are suggested). Running agents are ticked; working agents receive immediately. For a newly launched agent, startup confirmation (such as trusting a directory) stays within the current submission: complete it within five minutes to send once, or cancel that unsent delivery. An existing agent’s blocked approval/question dialog fails the send for a deliberate retry.
- **A broadcast**: its prompt, a count of agents by state (click one to jump to them), and every agent's live terminal. Select agents and use the top **继续广播** composer to send a follow-up in their existing conversations. Selection is retained even while an agent is disconnected or being restored; the composer waits until all selected agents are usable, with required connection actions shown only on their cards. Each submission appends a round to the same broadcast, with its own instruction, participants and delivery results; the list keeps one entry. The detail page opens the latest round input, with compact text tabs to read earlier inputs. Task instructions are collapsed on entry; choosing another round expands its input in a height-limited, scrollable reference above the terminals. Round selection preserves the terminals and agent selection, including agents absent from that round. Follow-ups reuse the same terminal connection. Messages are submitted without waiting for earlier AI work. Each terminal shows its conversation’s current status alongside the latest delivery result, independently of the round input being read. Existing records migrate to round one without changing their results. Terminal keystrokes affect only that terminal. Text size and panel size are adjustable.
- **Agent names**: use the pencil beside a card's title to rename the live agent in Herdr. herdr-web-ui reads the same name. Names start with a lowercase letter and contain up to 32 lowercase letters, digits, `-` or `_`; duplicates are refused. The tab's label is separate.
- **Other views**: **在 Herdr 里打开** brings it to the front in Herdr; with [herdr-web-ui](https://github.com/devswha/herdr-web-ui) running, **打开对话 / 打开终端** open its chat or terminal there. herdr-web-ui is optional: the page notices whether it is running.
- **Settings**: **设置** shows the running version and **重启服务**, which always uses the confirmed runtime. GitHub installations also get **检查更新** and **更新并重启**, with the installed version shown separately when it differs. Update checks run 15 seconds after startup and every six hours; installation is always manual. Local links show no development mode, edit notifications or update controls; developers load changes explicitly from the command line. Progress and failures survive reconnects and closing the browser. If the page cannot open, invoke **Broadcast: 重启服务** in Herdr. Restarting Herdr alone does not restart this independent service.

- **Machines**: the sidebar names every machine; the Machines page contains connection settings and diagnostics. **准备 Agent** checks CLI execution, configuration directories and Herdr integration versions for Claude Code, Codex, Pi, OMP, OpenCode, Kimi, Antigravity, Grok and Qwen. The default new-agent picker uses these nine; other running kinds remain accessible. Missing prerequisites open the preparation dialog. Select integrations to install/update, or skip this optional step after adding a machine. The plugin does not install agent CLIs, dependencies or model credentials. Preparation uses the saved SSH user and login environment, honors custom configuration directories reported by Herdr, and reuses current integrations. Operations expose progress, cancellation and per-agent results; closing the browser keeps them running, service drain waits for them, and interruption triggers inspection without replaying installation commands. Integration readiness is separate from receiving a native session ID.
- Keys: `N` new broadcast, `/` search, `J` / `K` next and previous broadcast, `Esc` puts a zoomed screen back.

Terminal input and output use a persistent WebSocket and `herdr terminal session control`, with persistent SSH for remote machines. The foreground page takes terminal control automatically on entry or a deliberate terminal click. Losing focus or opening herdr-web-ui keeps existing controllers and their output connected; background pages do not accept input or start new connections. When another client takes over, this page stops reconnecting and keeps the last screen with a paused status. Returning to this page or clicking the terminal grants one takeover attempt; returning while still connected keeps that connection. Offscreen reconnects and timer retries never force takeover, so two pages cannot repeatedly steal control from each other. Disconnecting leaves the agent running, and unsent input is never replayed.

Connection feedback lives in one place: a card's bottom status bar. It stays hidden while connected and during drops shorter than two seconds; longer automatic retries show only **正在连接…**. There are no reconnect/takeover buttons, central connection overlays, global disconnect banners or connection-success popups. Only a required decision adds one action: **查看并确认**, **核对会话**, **选择对话**, **打开连接设置**, **新建对话**, or **继续对话**. Missing session identity is shown separately from an agent waiting for startup confirmation. Technical errors stay out of the card. Session checks still prevent a different conversation from receiving a message or being mistaken for the saved conversation.

Connections to live agents recover automatically after browser or network interruptions. Once an agent process has exited, its conversation stays closed until the user clicks **继续对话**, regardless of the recorded delivery result. That explicit action reopens exact Claude Code, Codex, Pi, OMP, OpenCode, Kimi, Antigravity, Grok and Qwen sessions on the original machine and directory. Native identifiers need not be UUIDs. Pi/OMP transcript paths are checked for readability before restoration. Records without an ID first try bounded exact history discovery (directory, round prompt, send time within 10 seconds; Python 3 required), then open a supported native session picker if no unique match is available; kinds without a picker open a terminal for manual recovery. Native selections are accepted when Herdr reports identity; the dialog's **继续此对话** handles integrations that cannot report it. Multiple live instances of the same saved history can also be selected explicitly. Restoring never replays the task or resumes unfinished work by submitting a prompt. **新建对话** opens an empty composer and does not copy the old instruction. History must still exist on the original machine; the plugin does not archive terminal output.

Every agent card shows **已绑定原生会话**, **尚未绑定原生会话**, or **人工确认的终端** independently of delivery status. Expand the label for the native identifier and recovery explanation. Closing a browser tab leaves the agent running; after the agent exits, exact restoration requires a saved identifier and available history on its original machine.

A bounded identity check runs after an explicit submission when its native identity is still missing. Codex, Claude Code and Pi verify only the reported conversation against that input, directory, timestamp and physical terminal; unrelated old transcripts cannot block this check. Other agents retain receipt/manual binding and show that delayed verification is unsupported. The card explains report timeouts, proof failures and interrupted checks. Refreshing or restarting never resumes a check or resends input. Finding an entirely unknown historical identity remains a separate, conservative search.

Plugin-created and restored Codex instances use `--no-daemon` after checking support in the actual local/SSH login environment. Unsupported or unavailable CLIs fail before launch with an actionable explanation; existing processes are not restarted. Codex hooks review/management and selection dialogs block task input even if Herdr reports idle. A new broadcast waits up to five minutes within the current request, sends once after confirmation returns to the conversation, and never replays on cancel, timeout or restart. Trust remains a user action.

Codex can report its identity after the send receipt. A bounded, read-only check for that submission requires a unique exact native-history match (round text, cwd and send time), matching the physical terminal and reported ID. It does not adopt arbitrary later reports or revisit unknown history after restart. A no-ID Codex confirmation pins the CLI process and keeps explicit selection intent; a verified follow-up can save that selected session on its confirmed parent. Missing/ambiguous history keeps the binding unknown without changing the delivery result. Python 3 is needed for history and process checks.

Custom agents can be added from **已有 agent → 添加自定义 agent** by explicitly confirming an existing terminal. The card labels it **人工确认的终端**, without inventing a native identity or agent status. Python 3 is required on that machine to verify foreground process start identity (Linux boot ID/start ticks; macOS native microsecond start time). Each send checks the physical terminal and process before paste and Enter. Exit to a shell, replacement, PID reuse, service process restart or unverifiable continuity require explicit confirmation again. Later rounds inherit valid bindings. **继续对话** opens a plain terminal in the original directory; start your agent, choose its history and click **已恢复此会话**. Switching conversations inside the same process is outside this detection and requires a new manual binding.

A session ID reported at send time is saved with that delivery. If it was missing, later polling and terminal lookup leave the historical identity unknown: the same terminal may now contain a different conversation. Continuing from that live terminal requires explicit confirmation; historical discovery or an explicitly opened picker can also establish identity. Confirmation without a reported ID permits the selected terminal to be used, but does not authorize silently adopting a later session report.

**再次发送本轮任务** is a separate, confirmed action that appends a round in the verified original conversation and preserves the prior result. Repeated requests reuse the same retry round. A closed existing agent must be restored first; the page does not offer an ineffective retry or silently create a fresh conversation. **中断 agent** sends Ctrl+C to the verified current agent; its effect is visible in the terminal. It does not retract a queued native message or change any broadcast delivery result. Terminal Ctrl+C works the same way. An uncertain send is never replayed automatically; inspect both the conversation and the agent’s native message queue before deliberately retrying. **已发送** means the terminal submission returned successfully, not that the agent has read, started or completed that instruction.

Selecting a different live instance for history does not move a send or agent launch already in progress. If the selected instance temporarily stops reporting its session ID, it stays selected and waits for verification. Native restore or explicit confirmation applies to that physical terminal; a contradictory session report invalidates that confirmation. A fresh-terminal retry requires persisted evidence that no task input was attempted. Older records without that evidence remain uncertain even when their send timestamps are empty, and must reconnect to or restore the original conversation first.

This refactor keeps database schema v9 and preserves broadcasts, rounds and session identity records. For the first upgrade, update or re-link the plugin through Herdr so the old worker action and event subscriptions are removed. Restart drains legacy executors before accepting new sends; a timeout aborts migration. Old unsent queue records become closed history and are never dispatched automatically. Legacy working/blocked records retain their delivery history without further task-completion tracking. Interrupted submissions become failed or uncertain results for manual inspection; completed history and session bindings are preserved.

Who gets in: it listens on 127.0.0.1, accepts only its own Host names (`localhost`, `127.0.0.1`, and `web_hosts`), and takes changes only from its own page. To reach it from a phone, set `web_token` first, then serve the port through Tailscale (`tailscale serve --bg --https=8443 http://127.0.0.1:7318`, adding the Tailscale name to `web_hosts`) or an SSH tunnel, and open `/?token=…` once on each device.

### The server

It is a process of its own, as herdr-web-ui's is. Herdr's startup hook starts it detached; it runs a copy of the plugin kept under the plugin's state directory, so updating the plugin does not pull files out from under it. Start is idempotent and waits until the page answers. If port 7318 is taken it serves on the next free one (7325 and up) and remembers it; a `web_port` you set is used as is.

| Action | |
|---|---|
| `herdr-broadcast.web` | start it (a running one is left alone) |
| `herdr-broadcast.web-restart` | restart only the confirmed runtime; conversations remain in Herdr |
| `herdr-broadcast.web-status` | whether it is running and answering, and where |
| `herdr-broadcast.web-stop` | drain and stop the service; it stays stopped until explicitly started |

It does not stop when Herdr does: a machine whose Herdr is down shows as such on the page, and comes back by itself.

## Delivery and agent execution

A broadcast is an immediate fan-out of one user submission. The request validates recipients, creates its history round, and starts one send attempt per target. New recipients are created and started within that same operation. There is no background database consumer. A timer, page refresh, restored conversation or service restart cannot initiate a send.

| Delivery state | Meaning |
|---|---|
| submitting | this accepted request is starting its sends; not work saved for a future scheduler |
| starting | creating the new recipient’s workspace / tab, starting its agent, and waiting for initial startup confirmation when needed |
| sending | validating the physical target and writing the prompt |
| sent | terminal submission returned successfully |
| failed | validation, launch or submission failed before any message input, or Herdr explicitly refused input |
| uncertain | input may have reached the agent; inspect the original conversation before manually retrying |

These are **delivery results**, separate from the live agent’s `working`, `idle`, `done` or `blocked` status. Herdr’s prompt command can submit while an agent works, but neither a state transition nor `completion_seq` identifies which submitted message finished. Broadcast therefore never turns a new message’s result into “task completed”. Old lifecycle states remain readable as historical records; schema v9 and its legacy fields remain compatible.

Session identity is captured before input and from that submission's `agent prompt` response when it identifies the same physical target and agent. A response can fill only its own delivery's missing identity; it cannot rewrite an earlier unknown record or replace a known session. Conflicting response identity makes the delivery uncertain without retrying. Responses without identity preserve what was already known, and later polling never backfills historical identity merely from the current terminal.

Same-terminal paste/Enter writes are serialized only for the duration of submission to prevent interleaved text. They do not wait for AI work or persist messages for later execution. Different recipients can be submitted concurrently. Working agents use their native behavior, which may queue a message or incorporate it into the current turn depending on the agent. An existing agent’s blocked dialog or an unavailable machine produces a result requiring manual retry; becoming idle or reconnecting later does not trigger another attempt. A new agent’s initial confirmation is different: the accepted launch waits up to five minutes using Herdr’s occupant-pinned `agent wait`, then sends once in the same round. Cancellation, timeout, agent exit/replacement or service drain ends that wait without sending; resolving it later never replays the message.

Sending results and rounds are retained for inspection. “Delete record” deletes only history: it cannot retract messages already handed to an agent. Records cannot be deleted while their sends/launches are still in flight. Retry is a separate explicit operation that appends a round and is deduplicated across repeated retry requests.

A prompt for an existing agent is typed into its input box, as if from the keyboard: an unsent draft already in that box goes out with it. Check the box is empty before broadcasting to an agent you were typing into.

New agents get names like `bc12-claude-1`. A broadcast's new agents on one machine share one workspace (`📡12 <title>`), one tab each, every tab in its agent's own folder and named for it (`claude-1 · app`): one broadcast is one workspace to find and to close.

On a remote machine, Herdr resolves folders there: use an absolute path or `~/…`. The plugin uses Herdr's saved machines (`herdr machine`); machines added through herdr-web-ui's own "Add PC" are not among them.

### What runs in the background

The resident chain is **launcher → update manager → Web service**. Only the Web service accepts broadcasts and performs their immediate sends or launches. Polling is for page snapshots and conversation identity; it never dispatches messages. With no browser subscriptions, there is no queue-processing loop. The startup hook starts the service when `web_autostart` is enabled; old event/worker commands are harmless compatibility notices.

Closing every browser leaves already accepted sends running. After delivery, each agent owns its messages and processing independently of the page and Broadcast service. Stopping the service refuses new submissions, ends unsent startup-confirmation waits, and drains other accepted operations; restarting never replays saved messages. If the process crashes during submission, recovery records failure or uncertainty instead of resuming it. Uncertain delivery is never automatically retried.

SQLite stores broadcasts, rounds, recipient identities, delivery results and conversation bindings under the plugin’s state directory, one database per Herdr session (`broadcast.sqlite`, `broadcast-<session>.sqlite`). Each database has its own service lock, control socket (current user only), port metadata, runtime versions and update transaction. An immediate send attempt is claimed atomically and its input attempt recorded before writing, protecting against duplicate requests and preserving evidence after a crash.

### Updating and rollback

GitHub installations follow Herdr's `requested_ref`, or the default branch when absent; fixed tags and commits require an explicit change in Herdr. Dirty files, untracked files and divergent histories in an installed copy prevent an update. GitHub updates use `herdr plugin update` to register the installation, then stage a separate runtime.

Local links use the local working tree as their source, including uncommitted and untracked runtime files. `bun src/main.ts web-apply` snapshots and validates it, refreshes the Herdr registration with `herdr plugin link`, then safely switches services. The plugin does not pull, checkout, reset or choose an upstream branch for local developers. Git operations remain yours. **重启服务** never applies source changes in either mode.

Preparation happens in an independent directory while the current Web service keeps working: frozen-lockfile install, typecheck, runtime assets, protocol and schema v9 compatibility. A cooperative drain then blocks new external operations and waits up to 120 seconds for submissions, agent creation and session restoration. It does not wait for the agents' AI work. A drain timeout resumes the current service without killing sends.

The launcher replaces the manager and Web service together. A new service starts paused and must pass boot identity, version, content fingerprint, database and lock checks within 20 seconds. Only the confirmed chain may accept new broadcasts. Startup failure restores the previous runtime using the same database. Durable transaction records recover an interrupted switch; databases are never rolled back. Current, previous and still-used runtime directories are retained. Installing files is reported separately from successfully running them, so failed candidates remain retryable.

The launcher is the sole writer of `update.json`. Managers submit partial patches over IPC; the launcher checks the sending manager, operation ID, phase, step and outcome before persisting them. Replaced managers cannot overwrite the confirmed result. Checks, preparation, switching and stopping have separate lifecycle states. A stop cancels and awaits checks/preparation before draining Web operations; a failed drain restores the manager's update checks. Install/restart requests cancel an overlapping check instead of reporting it as an installation in progress. CLI start waits for an existing switch; CLI stop returns completion only after the original launcher has exited and released its lock.

The launcher itself stays resident across version switches. When upgrading from the older launcher, apply/install the new runtime first, then run `bun src/main.ts web-stop` followed by `bun src/main.ts web-start` once to load the new launcher too. During this compatibility interval the new manager keeps preparation progress in memory and the old launcher still records switch outcomes; durable preparation progress and the new control guarantees require the full chain restart. Normal stopping drains accepted submissions and does not wait for or stop the agents' AI work.

Management install/apply/restart endpoints return `202` with `operationId`. SSE and `/api/config` expose the persisted operation outcome; duplicate requests reuse it. Closing a browser does not cancel an update. CLI start/stop/restart controls the same manager through its local socket. Local `web-apply` submits to an authenticated, local-only Web API and follows the manager operation. The page has no local-apply button.

## Settings

`config.toml` in `herdr plugin config-dir herdr-broadcast`:

```toml
web_port = 7318                 # the broadcast web page
web_host = "127.0.0.1"          # what it listens on
web_token = "…"                 # required from every browser once set
web_hosts = ["mypc.tail1234.ts.net"]  # Host names to accept besides localhost
web_autostart = true            # start it with Herdr
web_url = "http://localhost:7317/"  # herdr-web-ui's address, for the links to it
```

## Command line

For scripts, from the plugin's directory:

```bash
bun src/main.ts send --prompt "Review the diff" --to w2:p1 --to gpu-box/w1:p3
bun src/main.ts send --prompt "Fix the flaky test" --new claude@~/src/app*2
bun src/main.ts list
```

`send` requires a running Web service and submits through its authenticated API; it never saves tasks offline or creates another executor. `list` opens the database read-only.

`--to` names a running agent's pane, `--new KIND@DIR[*COUNT]` starts agents; prefix either with a saved machine's id or label and `/` for an SSH machine.

## Development

### CI and merge checks

[CI](.github/workflows/ci.yml) runs on every PR targeting `main` and every push to `main`, without path filters. Its stable check names are **Unit**, **Integration**, **Core E2E**, and **Build**. All four must be configured as required in GitHub's branch protection; changing YAML alone does not configure that protection. Keep PR requirements and administrator bypass restrictions enabled. Failed or missing checks must block normal merges.

CI uses Ubuntu 24.04, Bun 1.4.3 and checksum-verified Herdr 0.9.5. Actions are pinned to commit SHAs. Run the same checks locally:

```bash
bun install --frozen-lockfile
bun run test:unit
bun run test:integration
E2E_LOG_DIR="$PWD/test-results" bun run test:e2e
bun run build
```

Unit groups component/helper tests (including small SQLite/HTTP fixtures); Integration discovers every remaining `test/**/*.test.ts`, including new test files. Their union is the complete `bun test` suite. Core E2E exercises real HTTP, Herdr, PTY and WebSocket paths, plus unrecognized-process manual binding and explicit restoration, with a deterministic fake agent, including receipt counts/order, sending while working and no replay after Web restart. It requires no model credentials. Browser layout/interaction, real SSH and Pi/Claude/Codex compatibility are additional targeted validation, not implied by this check.

Build typechecks `src`, `test` and `scripts`, installs production dependencies from the frozen lockfile in a temporary directory, validates the plugin manifest/runtime entry, browser syntax and terminal assets, then writes a source package to `dist/`. Herdr runs TypeScript directly; there is no separate compiled executable. The package includes `build-info.json` with the revision, dirty-workspace flag and source fingerprint, plus an archive checksum. Install the extracted candidate through the normal Herdr plugin workflow; CI does not apply it to a live service or publish a release.

JUnit reports, console logs and E2E diagnostics are retained as Actions artifacts for 30 days; validated candidate packages are uploaded with the checked commit in the artifact name. Archive any evidence needed longer in the task/PR record.

### Local development

```bash
bun install          # terminal assets and development dependencies
bun test             # runs against a fake herdr CLI (test/fake-herdr.ts)
bun run typecheck
herdr plugin link .  # register this checkout as a local development plugin
herdr plugin action invoke herdr-broadcast.web
```

After editing code, manually run `bun src/main.ts web-apply` from the linked source directory. Local files are not watched or automatically loaded. It accepts local edits without requiring a Git commit and includes manifest re-linking. A separate **重启服务** / `bun src/main.ts web-restart` only restarts the code already running. Starting a stopped service also keeps its last confirmed version; apply explicitly after starting if you want to load newer source. Ordinary users install through `herdr plugin install qivyn/herdr-broadcast` and never need the development workflow.

`scripts/e2e-real.ts` starts its own Herdr server with a disposable configuration, database and session; `scripts/fake-agent.ts` stands in for an agent, so it spends no tokens. The script checks actual receipt counts rather than inferring delivery from agent status. It stops the test server and removes temporary state afterwards. A different session name alone does not isolate installed plugin startup hooks; retain the shared environment helper when extending these tests.


### Refactor verification (2026-10-28)

The immediate-delivery tests cover working recipients, independent local/remote sends, multiline paste ordering, duplicate submission/retry protection, blocked startup, uncertain input, session identity, browser disconnects, drain timeout and no replay after restart. The management regressions also cover cancelling checks and descriptions, cancellation during operation acceptance, failed-drain/SIGTERM recovery, stale manager/operation writes, start during replacement and stop followed immediately by start. The existing regression suites cover terminals, session restoration, rounds, management process replacement and updates. All process/update fixtures use temporary directories, isolated databases/Git repositories and fake Herdr; they do not operate on production broadcasts or real plugin installations.

`bun run typecheck` and the complete `bun test` suite pass: **326 tests, 0 failures**, including PTY and management process tests. The earlier queue-based refactor passed 330 tests; obsolete task-completion/queue assertions have been replaced with immediate-delivery and no-replay coverage. The attached historical session contained PTY creation failures (`Failed to open PTY`); those remain recorded historical failures, whose OS-level cause was not established. This run’s sandbox initially refused temporary socket listeners; the full suite passed with temporary HTTP/Unix-socket listening allowed. This permission issue is separate from the historical PTY failures.

## License

MIT

`bun scripts/e2e-terminal.ts` checks real terminal streaming, Unicode, two simultaneous terminals, resizing, ownership conflicts and per-key round-trip latency. It creates an isolated configuration and session under a temporary directory and removes them afterwards; it never uses your normal Herdr session.

`bun scripts/e2e-resume.ts` checks real Pi history selection, automatic history discovery and reopening the same saved history using isolated Herdr/Pi configuration and a fixture transcript. It sends no new prompt or model request and removes its temporary session afterwards.

### Agent preparation and recovery verification

`bun scripts/e2e-manual.ts` verifies manual binding, cross-round delivery, blocking after exit to a shell, and explicit restoration without replay. It is included in `bun run test:e2e`. `bun scripts/e2e-environment-ssh.ts` separately uses an ephemeral loopback SSH server, temporary keys and disposable Pi/Codex configuration directories to verify integration installation/updates through a saved machine profile, native Pi identity persistence, Codex first-hook trust/input ordering, native identity persistence and exact recovery without replay; it requires `sshd`, `ssh-keygen`, Herdr, Pi and Codex with `--no-daemon`. Neither script changes user integrations or existing Herdr sessions. Real compatibility of all nine agent CLIs requires those agents to be installed; the automated recovery argument tests do not replace those live checks.

Environment endpoints: `GET /api/machines/:id/environment`, `POST /api/machines/:id/prepare-agents` with `{ "integrations": ["pi"] }`, and `GET`/`DELETE /api/environment-operations/:id`. Preparation returns `202` with `operationId`; duplicates for the same active selection reuse that operation. Installation and cancellation require the service computer’s local page, normal authentication and same-origin checks. Operation records live beside the database in a separate `.agent-environment.json` journal. Database schema v9 and the existing broadcast API remain compatible.

`bun scripts/e2e-codex.ts` verifies real Codex hooks trust, deliberately delayed identity, independent terminals, manual selection and exact restoration. It uses temporary configuration and an offline provider, without user credentials or model requests. Add `--preview` to keep an isolated browser acceptance page open; press Ctrl+C to stop and clean up. `E2E_LOG_DIR` optionally retains test evidence. Codex compatibility was exercised with CLI 0.164.0 and Herdr 0.9.5; future TUI changes may require updates to modal detection.
