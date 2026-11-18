# 环境与账号隔离

Hapla 有三个不同的隔离层：整套部署、用户执行器、服务端账号。不要把“两个会话”
或“两个工作目录”当成两个独立环境。

## 整套部署隔离

`./deploy.sh --instance NAME` 为一整套 Web/Server 环境选择不同的资源：

| 资源 | 默认实例 | 示例 `staging` 实例 |
| --- | --- | --- |
| 私有配置 | `.env.selfhost` | `.runtime/selfhost/staging/.env` |
| Compose 项目 | `hapla` | `hapla-staging` |
| 数据库卷 | `hapla_hapla-data` | `hapla-staging_hapla-data` |
| 网络 | `hapla_default` | `hapla-staging_default` |
| Server / Web 镜像标签 | `:lite` | `:instance-staging` |
| Web 端口 | 首次从 12345 寻找空闲端口 | 独立端口，可用 `--port` 固定 |
| 主密钥 | 独立生成并保留 | 独立生成并保留 |

配置中的自定义镜像标签会保留。测试和正式环境应使用不同的浏览器来源，避免浏览器
本地账号状态混淆；独立浏览器 profile 可以进一步区分不同账号。每套环境单独备份
数据库卷和配置，不能把同一个 PGlite 目录交给两个 Server 同时写入。

## 双用户部署示例

两位用户可以共用同一中继，各自保留工作区、Hapla 配对状态和 agent 登录目录。旧部署
常见做法是为每位用户挂载独立的工作区、`.hapla` 和 `.codex` 目录，同时使用同一中继网络。
迁移前用 Docker 核对实际挂载、服务归属及配置文件，避免用模板覆盖持有真实账号数据的容器。

## 可复用的独立执行器模板

新模板是 [`deploy/compose.worker.yml`](../deploy/compose.worker.yml)，镜像由
[`deploy/Dockerfile.worker`](../deploy/Dockerfile.worker) 构建。默认用 UID/GID 1000、
`no-new-privileges` 和移除 Linux capabilities 的配置，且不挂载 Docker socket。

```bash
./deploy.sh up --instance team --port 12347 --non-interactive
./deploy.sh --instance team worker-add account-a
./deploy.sh --instance team worker-add account-b
```

然后由两个账号分别登录并启动：

```bash
./deploy.sh --instance team worker-run account-a hapla auth login
./deploy.sh --instance team worker-run account-a codex login --device-auth
./deploy.sh --instance team worker-up account-a

./deploy.sh --instance team worker-run account-b hapla auth login
./deploy.sh --instance team worker-run account-b codex login --device-auth
./deploy.sh --instance team worker-up account-b
```

每个执行器对应独立 Compose 项目 `hapla-team-worker-<name>`，因此下列卷不会混用：

- `worker-home`：`HOME`、`HAPLA_HOME_DIR`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR` 及其凭据、缓存、用户 Skills。
- `worker-workspace`：仅该用户的工作文件，容器内固定为 `/workspace`。

两个执行器只共用 `hapla-team_default` 中继网络和同一构建镜像。模板用服务名
`server:3005` 连接中继，不绑定固定容器 IP；通过 `HAPLA_WORKSPACE_ROOT=/workspace`
约束机器文件和终端 RPC。执行器不接收中继的 `HAPLA_MASTER_SECRET`。

`worker-add` 只生成 `.runtime/selfhost/team/workers/<name>.env`；不会复制宿主机
或其他账号的认证目录，不会迁移现有 `hapla-account-a`、`hapla-account-b`。
`worker-run` 用一次性容器执行登录等操作，状态卷继续保留；运行普通命令时也会拥有
该用户的工作区权限。`worker-up` 启动前台 daemon，由 Docker 负责生命周期。

可用 `worker-run NAME sh` 查看自己的工作区，也可在审查过的本地 Compose 覆盖文件中
把 `worker-workspace` 换成用户专属 bind mount。此时要确认目录属主/ACL 与 UID 1000
兼容；不要给容器挂载整个宿主 home、共享凭据目录或其他用户的工作区。
一键入口仅管理生成的标准文件，额外的自定义覆盖文件需要自行使用完整 Compose 命令。

## 账号隔离与运行边界

服务端按认证账号校验会话、机器、RPC 和文件归属。共享中继并不等于共享账号；
配对时打开正确账号的浏览器页面。即使工作区为空，复用另一用户的 Hapla 状态卷
仍会把机器绑定到错误账号。

容器提供进程、文件和凭据分离，但共用宿主内核。拥有 Docker 管理权的人能访问卷；
对于互不信任的租户，应使用独立宿主或虚拟机，并审查网络与 agent 权限。
更换 `HOME` 或 `HAPLA_HOME_DIR` 只是路径隔离，不能单独构成安全沙箱。

## 更新、停止与恢复

先确认具体实例、账号、在线会话和原机器标识，再更新目标执行器。不要用测试提问
验证真实用户会话，也不要自动唤醒用户手动休眠的会话。daemon 作为容器前台进程时，
重启容器可能终止会话子进程；需要按原 conversation/thread 标识恢复。

`./deploy.sh --instance team worker-down account-b` 只停止 account-b 执行器，不删除状态和
工作区卷；不影响 account-a 或中继。停止整套 Web/Server 使用 `down --instance team`，
不会自动清除独立执行器。回退旧容器时先将其重启策略设为 `no`，避免与现役进程竞争。
备份和恢复必须同时保留配置、主密钥、账号状态与对应的数据卷。
