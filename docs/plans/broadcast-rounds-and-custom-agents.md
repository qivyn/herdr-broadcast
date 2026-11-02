# 广播任务、多轮参与者与自定义 Agent 正式计划

核对日期：2026-10-30。实施前代码基线：`2774d98`。本计划经用户确认，包含网页、HTTP API、CLI，以及自定义启动命令。本次交付不包含提交、推送和 PR。

## 目标与现状

侧边栏一项代表一个持续的广播任务；每次明确发送代表一轮。新建任务只创建新 Agent；继续广播可选择任务已有参与者并新增 Agent。主流类型提供快捷选项，其他交互式终端 Agent 使用自定义命令。

以下为实施前静态核对结果，不代表重新执行过测试：

| 需求 | 实施前状态 | 证据与缺口 |
| --- | --- | --- |
| 一个任务包含多轮输入 | 已完成 | `Store.createRound()` 插入轮次，续发返回原任务 ID |
| 每轮独立保存 prompt、参与者、投递结果 | 已完成 | rounds 与 executions.round_id |
| 每轮只向选中的参与者发送 | 已完成 | 续发校验归属，并按物理终端去重 |
| 保留历史结果 | 已完成 | 新轮新建执行记录，不覆盖旧轮 |
| 切换轮次不重建终端 | 已完成 | 页面参考输入与终端面板分离 |
| 已有参与者限当前任务 | 已完成 | 续发拒绝其他 broadcast 的 execution_id |
| 新建任务只创建新 Agent | 未完成 | 页面、API、CLI 仍接受已有 Agent |
| 详情页混合已有与新增 Agent | 部分完成 | 已有目标续发可用，新增目标尚未接入 |
| 新 Agent 只接收本轮输入 | 基础能力已有 | 引擎按 round_id 使用 prompt，缺混合入口及验收 |
| 自定义命令创建 Agent | 未完成 | 原入口只绑定已有终端 |
| 恢复不新增轮次、不重发 | 已完成 | 会话恢复与投递独立 |
| CLI 区分新建与续发 | 未完成 | send 始终创建独立任务 |

主要实现位置：`src/web/page.js`、`src/web/server.ts`、`src/db.ts`、`src/engine.ts`、`src/main.ts`。

## 产品规则

### 新建与续发

- 新建页移除已有 Agent 选择、人工绑定任意现有终端的入口，至少添加一个新 Agent 才可提交。
- 详情页增加“新增 Agent”，复用新建选择器，允许仅已有、仅新增、混合三种提交。
- 一次续发只追加一轮，侧边栏不新增任务。新参与者后续可被选中；未选中的参与者不补发。
- 新 Agent 只收到本轮 prompt；已有 Agent 保留各自原生上下文。不自动附带历史摘要，不引入其他任务的实例。
- 另建广播仅预填 prompt 与可转换的新建配置，不复用旧实例；自定义命令需要重新填写。
- 历史指令、参与者、结果不因新增、关闭或恢复而改写。已发送表示终端投递成功，不表示任务完成。

### 自定义 Agent

- 配置机器、目录、显示名称、单行启动命令和数量；只支持持续接收输入的交互式终端程序。
- 在新终端执行一次命令，不安装 CLI、依赖或凭据。用户负责命令进入新对话；插件只能保证新建终端。
- 用户完成登录、信任等启动步骤后，点击“已进入新对话，发送本轮输入”。确认前无 prompt，核实终端及前台进程后发送一次。
- 五分钟内可确认或取消；超时、进程退出/替换、终端替换、服务停止或重启都不补发、不重放命令。
- 后续沿用人工绑定和进程连续性检查。恢复由用户手动启动、选择原历史后确认，不自动运行原命令。
- 命令只存在于本次操作内存中，不保存至数据库历史、常规日志或浏览器草稿；用户输入的命令仍会出现在目标终端本身。
- 已有历史中的自定义 Agent 保持可用；本期不提供任意外部终端加入新任务的入口。

### 失败边界

接受前校验全部参数和已有目标，失败不建轮次、不启动、不发送。接受后独立记录各参与者结果，部分失败不撤销已发送输入，也不重试整轮。网络不确定时查看历史，刷新、恢复、重启不触发投递。

## HTTP API 与 CLI 契约

- `POST /api/broadcasts` 仅接受新 Agent，拒绝非空 targets，并提示改用 follow-up。
- `POST /api/broadcasts/:id/follow-up` 接受 targets 和 new，至少一项非空；targets 使用本任务 execution_id 与 terminal_id。
- 内置 new 项保留 machine、kind、cwd、count；自定义使用 kind=custom，增加 command 与可选 label。数量为 1–20 整数，命令非空单行、至多 16384 字符；label 为至多 120 字符的非空单行名称。
- 创建和续发返回 id、round_id、round_number、executions、execution_ids。
- `POST /api/executions/:id/confirm-startup` 请求 `{ "terminal_id": "..." }`，只确认当前操作，重复确认不重复发送；取消复用执行记录 cancel 接口。
- 校验失败返回 400，跨站/未授权沿用现有认证规则，服务排空期间返回 503。创建成功不表示已发送，应读取执行记录结果。

```sh
# 新任务
bun src/main.ts send --prompt "第一轮" --new 'pi@~/repo*2'
# 原任务下一轮：已有参与者与新增参与者混合
bun src/main.ts follow-up --broadcast 12 --prompt "第二轮" --execution 24 --new 'pi@~/repo'
# 自定义命令（命令在所选机器上执行）
bun src/main.ts send --prompt "检查代码" --custom '{"machine":"local","cwd":"~/repo","command":"my-agent","label":"My Agent","count":1}'
# 查看任务、轮次和执行记录 ID；完成终端准备后确认
bun src/main.ts list
bun src/main.ts confirm-startup --execution 25 --terminal-id TERM_ID
```

send --to 明确报错并提示 follow-up。follow-up 不修改任务标题。custom 可重复，缺省机器为本机。

## 执行与存储

保持 schema v9，复用 broadcast/round/execution 和人工绑定。启动命令通过请求内存映射交给本轮引擎，事务先写入全部执行记录再启动。跨轮按机器分配不重复编号，复用任务工作区。只有新增参与者建立终端面板，原连接、勾选、草稿不因轮次切换重建。

## 实施与验收

顺序：接口与引擎及回归测试 → 共用选择器与 CLI → 文档同步 → 隔离验收。

1. 第一轮 A、B；第二轮 B、新增 C：一个任务、两轮；A 只有第一轮，B 有两轮，C 只有第二轮，断言真实回执数量与文本。
2. 仅已有、仅新增、混合续发；无效配置与跨任务目标无部分副作用。
3. 自定义确认前零回执，确认后恰好一次；重复确认不重复发送。
4. 取消、超时、进程/终端替换、停止/重启不补发；历史不保存命令，恢复不重放。
5. 切轮及混合续发保留原终端、勾选和历史；另建广播不带已有实例。
6. CLI 实际执行 send/follow-up/confirm-startup/list，旧 send --to 拒绝；保留旧数据库与人工绑定历史兼容。
7. 执行 typecheck、相关测试、Unit、Integration、Core E2E、Build；核心 E2E 使用完整隔离 Herdr、真实 HTTP/PTY 和假 Agent。
8. 浏览器检查页面、控制台、网络、交互，核对源码快照 sourceRoot/sourceHash 与 health hash；验证后清理本次环境。
9. 按改动范围追加 Codex、SSH、Pi 定向 E2E，禁止真实模型请求；未执行项及原因如实记录。

实际验证结果由本次交付汇报记录，不以本计划中的验收目标代替执行证据。

## 本轮实施结果（2026-10-30）

上述待实现项均已落地：新建入口只创建新 Agent，详情页和 API 支持混合轮次，CLI 新增 follow-up/confirm-startup，自定义命令通过新终端及显式确认发送，启动命令不进入历史，schema 保持 v9。正式计划已加入构建白名单。

实际验证：

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 通过 |
| `bun test test/page.test.ts test/mixed-broadcast.test.ts` | 102 pass / 0 fail |
| `bun run test:unit` | 120 pass / 0 fail |
| `bun run test:integration` | 393 pass / 0 fail |
| `E2E_LOG_DIR=/tmp/broadcast-final-e2e bun run test:e2e` | delivery、terminal、manual 三组通过，断言真实回执 |
| `bun run build` | 通过；源码包包含计划文档与新测试 |
| `bun scripts/e2e-codex.ts` | 首次在选择历史会话后等待就绪超时；单独离线重跑通过 |
| `bun scripts/e2e-environment-ssh.ts` | 隔离 SSH/Pi/Codex 验证通过 |
| `bun scripts/e2e-resume.ts` | 隔离 Pi 历史恢复通过 |
| 浏览器验收 | 一个任务、两轮、三个 Agent；4/4 已发送，切轮保留勾选，控制台无错误 |

浏览器验收使用全新隔离 Herdr/XDG、数据库及配置，sourceRoot/sourceHash 与本次工作树一致，health hash 与运行快照一致；假 Agent 的四条回执为两条第一轮、两条第二轮。本次验证未使用真实模型，结束后清理本次临时服务和会话。未操作现用插件或正式服务，未提交、推送或创建 PR。
