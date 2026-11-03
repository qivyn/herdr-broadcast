# AGENTS.md

herdr-broadcast 是一个 Herdr 插件：在网页上把同一条提示词发给多个 agent（本机或 SSH 机器上），并记录投递结果、实时查看各 agent 的终端。Bun 直接运行 TypeScript，没有单独的编译产物。用户文档和 CI 说明见 [README.md](README.md)。

## 适用范围

下面的「自验证闭环」「测试与构建」「发版判断与确认」「提交与 PR」规则只用于**开发或修改功能**（包括修 bug、重构、改配置/脚本/CI），只有**开发或修改功能**才需要读取这些规则。

如果用户只是询问项目细节（代码怎么工作、某个行为的原因、架构、命令用法等），直接阅读代码回答即可：不改文件、不跑整套测试、不提交、不建 PR。回答中需要确认运行时行为时，可以跑单个相关测试或命令作为佐证。

如果用户只是询问项目细节并且撰写项目架构文档（比如 README.md ），直接阅读代码撰写文档即可：不改代码、不跑整套测试。

## 项目结构

- `src/main.ts`：命令行入口（`web`、`web-start`、`web-apply`、`send`、`list` 等）。
- `src/engine.ts`、`src/db.ts`、`src/worker.ts`：投递引擎、SQLite 存储（schema v9）、执行器。
- `src/herdr.ts`、`src/herdr-types.ts`：封装 `herdr` CLI 调用。
- `src/agent-*.ts`、`src/continuation.ts`、`src/session-*.ts`、`src/identity-acquisition.ts`、`src/manual-session.ts`：agent 启动、环境准备、会话识别与恢复。
- `src/service/`：服务管理（启动/停止/替换进程、更新与回滚、IPC）。
- `src/web/`：HTTP/WebSocket 服务和浏览器页面（`page.html`、`page.js`、`terminal.js` 是浏览器端纯 JS）。
- `test/*.test.ts`：`bun test` 测试，使用 `test/fake-herdr.ts` 假 Herdr CLI。
- `scripts/`：测试分组、E2E、构建脚本；`scripts/fake-agent.ts` 是不消耗 token 的假 agent。
- `herdr-plugin.toml`：插件清单；`deploy/`：部署相关脚本。

## 常用命令

```bash
bun install --frozen-lockfile
bun run typecheck                               # tsc --noEmit，覆盖 src、test、scripts
bun run test:unit                               # Unit
bun run test:integration                        # Integration
E2E_LOG_DIR="$PWD/test-results" bun run test:e2e  # Core E2E，需要 Herdr 0.9.5+
bun run build                                   # typecheck + 打包校验，产物在 dist/
bun test test/engine.test.ts                    # 跑单个测试文件
```

CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)）的四个必需检查是 **Unit**、**Integration**、**Core E2E**、**Build**，环境为 Ubuntu 24.04、Bun 1.4.3、Herdr 0.9.5。本地验证要和 CI 跑同样的命令。GitHub 的 `main` 规则应将这四项设为合并门槛；本文记录验证要求，实际约束由 GitHub 规则执行。

## 开发修改后的自验证闭环

改完代码不能只说「应该可以了」，必须自己跑通验证，循环直到通过：

1. **改动**：完成代码修改，同时补上或更新对应测试（见下一节）。
2. **静态检查**：`bun run typecheck`。
3. **相关测试先行**：先跑与改动直接相关的测试文件（`bun test test/xxx.test.ts`），失败就读输出、定位根因、修复，再重跑。
4. **完整回归**：相关测试通过后，跑 `test:unit`、`test:integration`、`test:e2e`、`build` 全部四项（具体要求见下一节）。
5. **实际运行验证**：改动会影响可见行为时，要把它真正跑起来看：
   - 网页 UI / HTTP API 改动：在全新临时目录中，沿用 `scripts/e2e-environment.ts` 的 `isolatedHerdr()` 创建独立 Herdr 环境，隔离 XDG 配置、状态、数据、缓存、运行目录及 Herdr 会话，并将 broadcast 的数据库和配置放在该临时目录中；用假 agent 启动服务，再用浏览器预览工具检查页面、控制台错误、网络请求和交互。当前 `.claude/launch.json` 的 `broadcast-dev` 仅隔离 broadcast 状态和配置，未隔离 Herdr 环境，不能直接用于此验证。
   - 确认加载了本次源码：`web` / `web-start` 会复用已有服务或已保存的运行版本，停止后重启也不会自动应用工作树改动。优先使用全新隔离状态启动；如需复用开发环境，先在该隔离 Herdr 环境中链接本地源码，再显式执行 `web-apply`。检查运行快照的 `sourceRoot`、`sourceHash` 与当前工作树一致，并确认 `/api/health` 返回的 `hash` 与该快照的 `hash` 一致，再进行验收。验证完成后停止本次创建的服务和 Herdr 会话，清理临时目录。
   - 命令行改动：实际执行对应的 `bun src/main.ts ...` 子命令并检查输出。
6. **失败就回到第 1 步**，不跳过、不注释掉失败的测试、不放宽断言来让测试通过。确实无法修复的失败要如实告诉用户，附上失败输出。

隔离要求：

- 所有验证只能使用临时目录、隔离数据库和隔离 Herdr 会话。**不要**操作用户正在使用的 Herdr 会话、已安装的插件、正式运行的 broadcast 服务或真实 agent 的配置。
- 扩展 E2E 时沿用 `scripts/e2e-environment.ts` 的 `isolatedHerdr()`：仅换会话名不能隔离已安装插件的启动 hook。
- 不要对真实模型发请求；用 `scripts/fake-agent.ts` 或离线 provider。
- Integration 测试需要监听临时 HTTP / Unix socket。如果沙箱拒绝监听导致失败，说明是环境限制，在允许本地监听后重跑，不要把它当成代码问题去改。

## 测试与构建要求

每次功能开发或修改，都要建立**实际可运行**的测试，并保证以下四项在本地真正跑过且通过：

| 层级 | 放在哪里 | 写什么 | 命令 |
| --- | --- | --- | --- |
| Unit | `test/` 下，文件名加入 `scripts/test-suite.ts` 的 `unit` 集合 | 纯函数、解析、格式化、小型 SQLite/HTTP 夹具 | `bun run test:unit` |
| Integration | `test/` 下其余 `*.test.ts`（自动归入） | 模块协作：引擎、服务管理、Web API、会话恢复等，用 `test/fake-herdr.ts` | `bun run test:integration` |
| Core E2E | `scripts/e2e-*.ts`，核心流程要加入 `scripts/e2e.ts` 的列表 | 真实 HTTP → 引擎 → Herdr → PTY → agent 回执，用假 agent | `bun run test:e2e` |
| Build | `scripts/build.ts` | 类型检查、生产依赖安装、清单/入口/浏览器脚本/终端资源校验 | `bun run build` |

规则：

- 新行为至少要有一个能在旧代码上失败、在新代码上通过的测试；修 bug 先写能复现 bug 的测试。
- 测试要断言实际结果（例如真实回执数量和顺序），不要只断言「没有抛错」或从状态推断结果。
- 只有改动触及核心投递、终端、手动绑定或恢复流程时才需要新增或修改 Core E2E；但 `bun run test:e2e` 每次都要跑。
- 新文件、新运行时资源要确认被 `scripts/build.ts` 的打包白名单覆盖，并且 `bun run build` 通过。
- 定向 E2E 不在 CI 里，改到相关区域时额外运行：
  - `bun scripts/e2e-codex.ts`：Codex hooks、身份获取、恢复（需要 Codex CLI）。
  - `bun scripts/e2e-environment-ssh.ts`：SSH 机器上的集成安装与恢复（需要 sshd、Pi、Codex）。
  - `bun scripts/e2e-resume.ts`：Pi 历史恢复（需要 Pi）。
  - 缺少依赖无法运行时，明确告诉用户哪一项没跑、为什么。

## 发版判断与确认

- 较大功能更新或功能修复，AI 必须在创建 PR 前询问用户是否发版，说明理由和建议版本；已有明确决定时不重复询问。
- 用户确认后，同步更新 `package.json` 和 `herdr-plugin.toml`，版本须一致且高于已有正式版，并完成验证。未确认前不自动升版或创建 PR。
- 无用户可感知变化的文档、测试、重构或 CI 调整，通常无需发版。

## 提交与 PR

- **只有用户明确授权提交后**才 commit、push 和创建 PR；改完代码、验证通过后先停下来汇报，等用户同意。
- 如果当前在 `main` 上，先新建功能分支再提交。不要往 `main` 直接推送，不要 force push。
- 使用可用且已授权的工具向 `main` 创建 PR，例如 `gh pr create` 或 GitHub 连接器。某个工具不可用时可使用其他已授权方式；若没有可用方式，应说明缺少的工具或权限及未完成的操作。PR 描述必须包含：
  - **改动**：改了什么、为什么改，涉及的主要文件。
  - **验证结果**：实际执行过的命令和真实结果（例如 `bun run test:integration`：325 pass / 0 fail），实际运行或浏览器验证看到了什么；没跑的检查（如定向 E2E）和原因也要写明。不能写没有执行过的结果。
  - **发版决定**：是否发版及理由；需要发版时写明用户确认的新版本，用户选择暂不发版时明确记录。
- **不要自动合并**：不开启 auto-merge，不通过任何工具合并 PR。创建 PR 后把链接给用户，由用户手动合并。
