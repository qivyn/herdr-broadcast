# Development and releases

[English overview](../README.md) · [中文介绍](../README.zh-CN.md) · [Usage](usage.md)

## Local setup

Bun runs the TypeScript source directly. CI uses Ubuntu 24.04, Bun 1.4.3, and checksum-verified Herdr 0.9.5.

```sh
git clone https://github.com/qivyn/herdr-broadcast.git
cd herdr-broadcast
bun install --frozen-lockfile
```

To link a checkout for your own development environment:

```sh
herdr plugin link .
herdr plugin action invoke herdr-broadcast.web
```

Local links use the ID `herdr-broadcast`, while GitHub installations use `qivyn.herdr-broadcast`. Linking changes the plugins available to that Herdr user; use a separate development environment when you also use a production installation.

After a source edit, load it explicitly:

```sh
bun src/main.ts web-apply
```

`web-start` and `web-restart` can reuse an existing runtime snapshot. They do not automatically load the working tree. The page has no local-apply button.

## Project map

| Area | Files |
| --- | --- |
| CLI and plugin entry | `src/main.ts`, `herdr-plugin.toml` |
| Immediate delivery and SQLite history | `src/engine.ts`, `src/db.ts`, `src/worker.ts` |
| Herdr CLI transport | `src/herdr.ts`, `src/herdr-types.ts` |
| Agent startup, identity, and recovery | `src/agent-*.ts`, `src/continuation.ts`, `src/session-*.ts`, `src/manual-session.ts` |
| Service management and runtime switching | `src/service/`, `src/web/launch.ts` |
| Browser and HTTP/WebSocket API | `src/web/` |
| Tests and offline fixtures | `test/`, `scripts/e2e-*.ts`, `scripts/fake-agent.ts` |

The resident chain is launcher → update manager → web service. The web service accepts explicit submissions and starts their immediate delivery. Polling updates snapshots and verifies identities; it never consumes a persistent message queue. SQLite schema v9 stores tasks, rounds, execution results, and conversation bindings. History is separate from the live agent's work status.

The source archive is assembled from an explicit allowlist. Add new runtime resources and linked documentation to `scripts/build.ts` when necessary.

## Before submitting a PR

Describe the problem and resulting behavior, include reproduction steps for fixes, and add a regression test that fails before the fix. Preserve history and session identity checks. Do not introduce automatic retries or prompt replay as part of recovery.

Run:

```sh
bun run typecheck
bun test test/your-related.test.ts
bun run test:unit
bun run test:integration
E2E_LOG_DIR="$PWD/test-results" bun run test:e2e
bun run build
```

Replace the example test path with the files relevant to your change. Unit covers the files explicitly listed in `scripts/test-suite.ts`; every other `test/**/*.test.ts` is included in Integration. Together they cover the complete `bun test` suite.

Core E2E tests the real HTTP → Herdr → PTY path, terminal streaming, and manual restoration using deterministic fake agents. It checks receipt text/counts, mixed rounds, cancellation during creation, and no replay. It does not imply live compatibility with every installed agent CLI.

For visible changes, start a fresh isolated environment with `isolatedHerdr()` from `scripts/e2e-environment.ts`. Keep all XDG directories, Herdr sessions, database, and plugin configuration temporary. Inspect the page, console, API interactions, and terminal output. Match the runtime snapshot's `sourceRoot` and `sourceHash` to the working tree and `/api/health.hash` to the runtime hash. Stop and remove the environment afterward. A separate session name alone does not isolate installed plugin hooks.

Additional checks depend on the area changed:

| Command | Coverage and requirements |
| --- | --- |
| `bun scripts/e2e-codex.ts` | Codex hooks trust, delayed identity, and exact restoration; needs the Codex CLI and uses an offline provider. |
| `bun scripts/e2e-environment-ssh.ts` | Saved SSH profiles, component setup, and Pi/Codex restoration; needs `sshd`, `ssh-keygen`, Herdr, Pi, and Codex. |
| `bun scripts/e2e-resume.ts` | Native Pi history selection and exact restoration; needs Pi and uses a fixture transcript. |
| `bun scripts/e2e-release-update.ts` | Release inspection and runtime staging with an isolated Herdr and temporary Git repository. |

Never use production sessions or real model requests for automated checks. Report missing dependencies or failed checks accurately. Include the actual commands and results in the PR, along with any browser acceptance evidence.

The four required CI checks are **Unit**, **Integration**, **Core E2E**, and **Build**. Repository branch rules must enforce them; the workflow file does not configure branch protection by itself. Logs and JUnit evidence are retained as Actions artifacts for 30 days. Source packages include version, commit, source fingerprint, and checksum metadata.

## Versioning and releases

For a substantial feature update or user-facing fix, decide whether to release before creating the PR. AI-assisted work should ask the user for that decision and recommend a version unless the user has already decided. Document the release decision in the PR.

1. Update both `package.json` and `herdr-plugin.toml` to the same stable `MAJOR.MINOR.PATCH` version, higher than every published stable Release. Features normally increase the minor version; fixes increase the patch version. Explain compatibility changes.
2. Complete the applicable local checks and open a PR against `main`.
3. Have the PR merged manually after its checks pass.
4. The resulting `main` push runs CI again. After all four checks succeed, the Release job publishes `v<version>` at that exact commit, with generated notes, the validated archive, checksum, and `build-info.json`.

PR runs and manually dispatched workflows never publish. An unchanged or older version is skipped even if CI is green. Only the Release job has `contents: write`; it uses the built-in Actions token. No manually created tag is required.

If publication fails, inspect the Release job and rerun the failed jobs on that same run. The publisher can resume its own draft; it will not overwrite an existing published version or conflicting tag. CI publishes a release but does not switch anyone's running plugin service.

## Herdr marketplace

The [official marketplace documentation](https://herdr.dev/tui/docs/marketplace/) describes automatic discovery of public GitHub repositories tagged `herdr-plugin` whose default branch contains a valid `herdr-plugin.toml`. Keep the repository description and manifest metadata accurate. Indexing does not imply review or endorsement by Herdr.

The repository stays the source of the plugin; users install it with `herdr plugin install qivyn/herdr-broadcast`. A GitHub Release and a marketplace listing are separate: changing a version does not add the discovery topic to the repository.
