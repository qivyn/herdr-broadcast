# 本机双容器

两个容器共用 `local/agent-tools:2026-10-23` 镜像，SSH 登录后以普通用户 `node` 运行。
基于 Debian Bookworm + Node.js 24，支持 Apple Silicon ARM64，也可在 AMD64 上构建。

镜像包含：

- Claude Code `2.1.309`，命令 `claude`
- Pi `1.4.0`（`@earendil-works/pi-coding-agent`），命令 `pi`
- [CC Switch CLI](https://github.com/SaladDay/cc-switch-cli) `5.11.3`，命令 `cc-switch`
- Bash、Git、curl、jq、ripgrep、Python 3、SSH 客户端

## 启动与进入

在本目录执行：

```sh
docker compose build agent1
docker compose up -d --no-build
```

从任意目录进入：

```sh
docker exec -it -u node ai-agent-1 bash
docker exec -it -u node ai-agent-2 bash
```

也可以从本机 SSH 连接（仅绑定本机回环地址）：

```sh
ssh -p 2221 node@127.0.0.1
ssh -p 2222 node@127.0.0.1
```

SSH 只允许公钥登录。首次创建数据卷时，将本机的公钥加入两个容器；
当前这两个容器已导入本机 `~/.ssh/id_rsa.pub`。重新从空数据卷创建时可执行：

```sh
docker exec -i -u node ai-agent-1 sh -c 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys' < ~/.ssh/id_rsa.pub
docker exec -i -u node ai-agent-2 sh -c 'umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys' < ~/.ssh/id_rsa.pub
```

SSH 登录后执行 `cd /workspace` 进入工作目录。主机密钥保存在各自的 `agent1-ssh`、
`agent2-ssh` 命名卷中，重建容器后保持不变。

进入后运行：

```sh
claude
pi
cc-switch
```

第一次使用需要在各容器内登录或配置自己的 API。`cc-switch` 会打开终端交互界面；
也可以用命令行管理配置：

```sh
cc-switch --app claude provider list
cc-switch --app pi provider list
```

Pi 的账号登录可在交互界面执行 `/login`。
如果 API 服务运行在 Mac 上，容器里的地址用 `host.docker.internal` 替代 `localhost`。

## 数据与生命周期

每个容器分别使用两个 Docker 命名卷，保存 `/home/node` 和 `/workspace`。
登录信息、`~/.claude.json`、`~/.claude`、`~/.pi`、`~/.cc-switch` 和工作文件都会保留，
两个容器之间互不共享；宿主机的账号和项目目录没有自动挂载。
可在 `/workspace` 内用 `git clone` 准备项目。

在本目录执行：

```sh
docker compose ps
docker compose stop
docker compose start
docker compose down
```

`down` 删除容器但保留命名卷，下次 `up -d --no-build` 后可以继续使用。
`docker compose down -v` 会同时删除这两个容器的登录配置和工作文件。

修改 Dockerfile 中的版本参数后重新构建，再启动，即可升级工具，数据卷仍会保留。

安装来源：[Claude Code](https://code.claude.com/docs/en/setup#install-with-npm)、
[Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)、
[CC Switch CLI v5.11.3](https://github.com/SaladDay/cc-switch-cli/releases/tag/v5.11.3)。
