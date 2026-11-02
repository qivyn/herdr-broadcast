# Usage reference

[English overview](../README.md) · [中文介绍](../README.zh-CN.md) · [Development](development.md)

## Interface language

The page supports English and Simplified Chinese. It uses the first supported browser language on the first visit, with English as the fallback. Choose **Settings → Language** to save a preference for this browser. Changing language reloads the page; it does not restart the service or send any instructions. Prompts, user names, commands, paths, session IDs, and Agent terminal output retain their original content. External tool diagnostics may retain the tool’s original language.

## Configuration

Find the configuration directory for a GitHub installation:

```sh
herdr plugin config-dir qivyn.herdr-broadcast
```

Create or edit `config.toml` there. Locally linked installations use the ID `herdr-broadcast` instead.

```toml
web_port = 7318
web_host = "127.0.0.1"
web_autostart = true

# Set before allowing access from another device.
# web_token = "replace-with-a-long-random-token"
# web_hosts = ["your-computer.example"]

# Optional: the address used by links to herdr-web-ui.
# web_url = "http://localhost:7317/"
```

| Setting | Default | Purpose |
| --- | --- | --- |
| `web_port` | `7318` | Explicit port. Without one, an occupied default falls back to ports 7325–7328. |
| `web_host` | `127.0.0.1` | Listening address. Keep loopback when using a local tunnel or proxy. |
| `web_token` | Unset | Authentication required by the page and API when configured. |
| `web_hosts` | Empty | Additional accepted Host names, such as a reverse proxy's hostname. |
| `web_autostart` | `true` | Start the service with Herdr. |
| `web_url` | Auto-detected when available | Address for links to the optional herdr-web-ui plugin. |

Restart the service after changing its listening or authentication configuration. For access from another device, set `web_token`, allow the proxy hostname in `web_hosts`, and use an SSH tunnel or authenticated HTTPS proxy. Open `/?token=YOUR_TOKEN` once on that device to authenticate. Treat that URL as a credential.

## Service commands

GitHub installations use `qivyn.herdr-broadcast`; local links use `herdr-broadcast`.

| Command | Behavior |
| --- | --- |
| `herdr plugin action invoke qivyn.herdr-broadcast.web` | Start the page; reuse it if already running. |
| `herdr plugin action invoke qivyn.herdr-broadcast.web-status` | Show whether it is running and its address. |
| `herdr plugin action invoke qivyn.herdr-broadcast.web-restart` | Restart the current runtime. |
| `herdr plugin action invoke qivyn.herdr-broadcast.web-stop` | Drain accepted operations and stop the service. |

The web service runs independently of Herdr's terminal UI. Closing a browser or disconnecting a terminal stream does not stop agents. Stopping the service ends unsent startup waits and drains other accepted operations; restarting does not replay saved instructions. A stopped service requires an explicit start.

## Tasks, rounds, and delivery

A new task creates new agents and records round 1. A follow-up adds a round to that task using existing participants, new agents, or both. Existing participants must belong to the task. New agents receive only the current instruction; no history summary or earlier round is automatically sent to them.

The same task's new agents on a machine share a workspace, with a separate tab and working directory for each agent. Their native conversations stay independent. An independent task created with **New broadcast from this round** copies the selected round's input and compatible new-agent configuration, not its running instances. Custom commands must be entered again.

| Result | Meaning |
| --- | --- |
| `submitting` | The accepted request is beginning its attempts. |
| `starting` | Creating or starting a new agent; startup confirmation may be needed. |
| `sending` | Checking the target and submitting input. |
| `sent` | Terminal submission returned successfully. |
| `failed` | No input was attempted, or Herdr explicitly refused it. |
| `uncertain` | Input may have arrived; inspect the original conversation before retrying. |
| `cancelled` | An unsent startup wait was explicitly cancelled. |

These are delivery results, separate from the agent's live `working`, `idle`, `done`, or `blocked` status. Working agents receive immediately and use their own message handling. A blocked existing agent requires a deliberate retry after you resolve its prompt. A newly launched agent may wait up to five minutes for startup steps within the accepted send.

There is no persisted dispatcher or automatic retry. Refresh, reconnection, session restoration, and service restart never initiate delivery. Same-terminal paste/Enter operations are serialized to keep text from interleaving. Check any existing terminal draft before submitting another instruction.

**Send this round again** explicitly appends a retry round after verifying the conversation; duplicate retry requests reuse that retry round. **Interrupt Agent** sends Ctrl+C to the current verified agent, without retracting prior input or rewriting delivery history. **Delete record** removes history only and is blocked while sends or launches are in flight.

## Machines and session components

Use Herdr's saved SSH profiles, visible in the **Machines** page. These are separate from herdr-web-ui's own machine connections. Remote working directories must be absolute or start with `~/`.

The picker inspects programs on the selected machine. Session components let Herdr report conversation identity; install or update them individually or through **Manage all Agents**. Installation uses that machine's saved SSH user and environment. Each machine is configured separately. The plugin does not install agent CLIs, dependencies, or model credentials.

The built-in picker offers Claude Code, Codex, Pi, OMP, OpenCode, Kimi, Antigravity, Grok, and Qwen. Support for starting and restoring a tool still depends on its installed CLI, integration, version, and native history. Automated argument tests do not establish live compatibility with every CLI version.

Ready components need no repeated setup. Successful installation updates the current groups without a completion banner. Running operations expose progress and cancellation; failures and interruptions retain their reasons. Closing the dialog leaves an accepted component installation running. Installation actions require the service computer's local page.

## Custom agents

A custom entry accepts machine, directory, display name, a single-line startup command, and a count from 1 to 20. Commands can be at most 16384 characters; names can be at most 120 characters. Use an interactive process that continues accepting terminal input.

Each custom agent gets a new terminal. Complete login, trust, and other startup steps, ensure the command has entered a new conversation, then confirm **Ready in a new conversation; send this round**. Before confirmation no task prompt is sent. Repeated confirmation cannot duplicate delivery. Cancellation, timeout, process/terminal replacement, or service shutdown ends the attempt without replay.

The command exists only in the accepted operation's memory. It is not saved in execution history, browser drafts, or routine plugin logs; it can still appear in the target terminal and its shell history. Starting it again requires entering the command again. Custom commands have no one-click session-component installer.

Python 3 is required for foreground process checks. Custom-agent bindings identify a user-confirmed terminal and process lifetime, not a verified native session. Switching conversations inside the same process requires renewed manual confirmation.

## Terminal connections and recovery

Live terminals reconnect after browser or network interruptions. When another client takes terminal control, Broadcast pauses its connection rather than repeatedly taking control back. Returning to the page or deliberately clicking the terminal grants one takeover attempt. Unsent terminal keystrokes are not replayed.

An exited agent stays closed until you choose **Continue conversation**. Recovery uses the original machine, directory, and native history. It does not copy history elsewhere or replay the round prompt. **New conversation** opens a fresh conversation without copying the old task.

If a native identity was saved, the plugin verifies it before using the terminal. If identity is missing, it can look for a unique matching history entry or open a supported native history picker. Ambiguous identity remains unknown until explicit selection or confirmation. Python 3 is needed for history-based checks; native history must remain available on the original machine. The plugin does not archive terminal output.

Custom-agent recovery opens a plain terminal in the original directory. Start your program, select its original history, and confirm **I restored this conversation**. The saved startup command is never automatically executed.

## Updates

GitHub installations offer a newer published stable GitHub Release from **Settings**, followed by explicit **Update and restart**. Update checks do not track unreleased branch commits. A running version at or above the latest release is not downgraded.

The updater validates and stages the exact release commit before switching runtime. Restart alone keeps the confirmed runtime. Dirty plugin checkouts or conflicting installation metadata may require you to resolve local changes first. The independent launcher, manager, and web service keep their own runtime snapshots; stopping and starting is not a substitute for applying source changes during development.

For older installations, re-install or re-link the plugin once if its manifest still registers obsolete workers or event hooks. Old unsent queues become closed history, not automatically dispatched work. Existing historical results and session bindings are preserved.

## CLI

Run these from the plugin's source directory, with its web service already running:

```sh
# A new task with two new agents.
bun src/main.ts send --prompt "Review this change" --new 'claude@~/src/app*2'

# A new round in task 12: one existing participant and a new agent.
bun src/main.ts follow-up --broadcast 12 --prompt "Check the fix" \
  --execution 24 --new 'gpu-box/pi@~/repo'

# A custom interactive process. Replace the command with your own tool.
bun src/main.ts send --prompt "Review" \
  --custom '{"cwd":"~/repo","command":"my-agent","label":"My Agent","count":1}'

bun src/main.ts list
bun src/main.ts confirm-startup --execution 25 --terminal-id TERM_ID
```

- `--new [MACHINE/]KIND@DIR[*COUNT]` accepts a built-in kind, a saved machine ID or label, and a directory. The default machine is local.
- Repeated `--custom JSON` options accept `machine` (default `local`), `cwd`, `command`, optional `label`, and `count` (default 1).
- `list` is read-only and prints task, round, and execution IDs. `--execution` must refer to the selected task's participant. Terminal IDs are available through the state API or terminal information.
- Creating or following up prints the accepted round's execution IDs. Acceptance does not establish delivery success.
- `send --to` was removed in 0.4.0. Use `follow-up --broadcast ID --execution ID` for existing participants.
- CLI sends use the running service's authenticated API. They do not queue messages offline or start a separate executor.

## HTTP API

The API uses the page's authentication and Host/origin checks. Clients with a configured token send `Authorization: Bearer TOKEN`. Mutation requests also need an `Origin` header matching an accepted service origin. Replace placeholders below with IDs from your task.

| Method and path | Purpose |
| --- | --- |
| `GET /api/state` | Read tasks, rounds, execution/terminal IDs, and current status. |
| `POST /api/broadcasts` | Create a task with `prompt`, optional `title`, and `new` entries. Nonempty `targets` are rejected. |
| `POST /api/broadcasts/:id/follow-up` | Append a round with `prompt`, `targets`, and/or `new`. |
| `POST /api/executions/:id/confirm-startup` | Confirm a pending custom launch using its `terminal_id`. |
| `POST /api/executions/:id/cancel` | Cancel an unsent startup wait. |
| `GET /api/machines/:id/environment` | Inspect programs and session components. |
| `POST /api/machines/:id/prepare-agents` | Start installation with an `integrations` array. |
| `GET /api/environment-operations/:id` | Read installation progress. |
| `DELETE /api/environment-operations/:id` | Cancel installation. |

A new entry has `machine`, `kind`, `cwd`, and `count`. For `kind: "custom"`, add `command` and an optional `label`. A follow-up target is `{ "execution_id": 24, "terminal_id": "TERM_ID" }`. Follow-ups validate task membership and terminal identity, and require at least one existing or new participant.

All parameters and existing targets are checked before a round is accepted. Invalid requests create no round or startup side effects. After acceptance, each participant succeeds or fails independently. Creation/follow-up responses contain `id`, `round_id`, `round_number`, `executions`, and `execution_ids`. Network uncertainty must be inspected before an explicit retry.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| The page does not open | Invoke `web` and then `web-status`; the default port may have changed. |
| An agent is unavailable | Select the correct machine, install its CLI there, complete login, and recheck. |
| A custom agent receives nothing | Finish startup and explicitly confirm readiness before the five-minute wait ends. |
| A history record cannot be restored | Check the original machine, directory, CLI, Python 3, and saved history; manually choose the conversation when needed. |
| Another browser has terminal control | Return to this page or deliberately click the terminal to request control. |
| New source is not visible after restart | Locally linked source needs `web-apply`; a normal restart reuses the current runtime. |
