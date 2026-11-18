# 一键配置与部署

准备 Node.js 22+、Docker Desktop，或 Docker Engine + Compose v2。Linux 用户需能
直接运行 `docker info`。从仓库根目录执行，无需先安装 pnpm 或应用依赖：

```bash
./deploy.sh
```

首次运行询问端口、是否允许局域网访问、浏览器访问地址。直接回车使用本机模式。
脚本生成随机主密钥，以 0600 权限保存配置，校验资源归属，构建镜像并启动 Web 与
Server，最后等待 `/health` 确认数据库和代理链路就绪。第一次构建需要联网拉取镜像
和依赖，可能持续数分钟。成功后会打印可打开的地址。

默认仅监听 `127.0.0.1`，新配置从 12345 开始寻找可用端口。重复运行保留原端口、
原主密钥和数据库；只在明确指定参数时更新对应配置。不会自动替换其他项目的容器。

## 常用操作

```bash
./deploy.sh configure                 # 只配置，不启动
./deploy.sh up --non-interactive      # 无人值守，使用默认值
./deploy.sh check                     # 检查配置、端口、项目归属和 Compose
./deploy.sh status                    # 查看容器状态
./deploy.sh logs                      # 最近 100 行日志
./deploy.sh down                      # 停止服务，保留数据库卷
./deploy.sh --help
```

`configure` 也会只读检查 Docker 和既有数据库卷，防止配置丢失后误生成新密钥。

已安装 pnpm 时，也可用 `pnpm selfhost:setup`、`pnpm selfhost:up`、
`pnpm selfhost:check`、`pnpm selfhost:status`、`pnpm selfhost:logs`、`pnpm selfhost:down`。
两种入口使用同一份实现，不会额外建立一套配置。

## 局域网和远程入口

```bash
./deploy.sh up --bind 0.0.0.0 --port 12345 \
  --url http://YOUR_LAN_IP:12345 --non-interactive
```

`--url` 填浏览器真正可访问的地址；从手机访问时不能填 `localhost`。
公网服务请先准备可信 HTTPS 反向代理，再把 `--url` 设置为对应域名。
`--bind` 控制宿主机监听地址，`--url` 不会自动配置 DNS、证书或代理。

可选的入口密码从私有文件读取，命令行不出现明文；配置只保存哈希：

```bash
./deploy.sh configure --password-file /path/outside/repository/password.txt
./deploy.sh up --non-interactive
```

入口密码不替代各用户账号登录。已有配置中的 `HAPLA_MASTER_SECRET` 是持久数据的
密钥，不是可随意更换的登录密码。若脚本发现示例密钥或数据卷存在但配置缺失，会
拒绝启动；已有数据请恢复原配置，新安装请使用新的 `--instance` 名称。

## 正式与测试环境分开

```bash
./deploy.sh up --instance production --port 12345 --non-interactive
./deploy.sh up --instance staging --port 12346 --non-interactive
./deploy.sh status --instance staging
./deploy.sh down --instance staging
```

每个实例有独立配置、主密钥、Compose 项目、网络、镜像标签和数据库卷。
后续操作始终带上同一个 `--instance`。默认实例使用 `.env.selfhost`；命名实例使用
`.runtime/selfhost/<instance>/.env`，均不提交 Git。详见 [环境与账号隔离](environment-isolation.md)。

在已有旧式部署或自定义执行器 的机器上，先用 `--instance demo`
配置新环境。脚本不会自动接管没有正确 Compose 标签的旧容器，也不会复制其凭据。

## 可选服务

```bash
./deploy.sh configure --asr-url http://YOUR_ASR_HOST:8765 \
  --file-service https://files.example.com
./deploy.sh up --non-interactive
```

ASR 地址必须能从 Server 容器访问。外部文件服务通过 `--file-service` 配置后，一键
入口会在所有操作中自动合并相应覆盖文件；R2 密钥仍由外部服务管理。
直接使用 `docker compose` 时，需自行保留完整文件列表。
其他设置见 [配置参考](configuration.md) 和 [Cloudflare](cloudflare.md)。

## 接入用户执行器

Web 和 Server 启动后，每个用户还需要自己的机器执行器。可以在个人电脑上连接
Hapla CLI，也可以使用仓库提供的隔离容器：

```bash
./deploy.sh worker-add account-a
./deploy.sh worker-run account-a hapla auth login
./deploy.sh worker-run account-a codex login --device-auth
./deploy.sh worker-up account-a
```

第一步生成独立配置并打印完整命令。Hapla 配对时必须使用该用户自己的 Web 账号；
Codex 登录也由该用户独立完成。登录后在 Web 机器列表确认在线，再创建真实会话。
构建默认安装冻结协议对应的 Codex；Claude Code 需在执行器私有配置中填写明确的
`HAPLA_CLAUDE_CODE_VERSION` 后重新构建，并执行自己的 Claude 登录。

使用命名实例时，在所有命令前添加相同的 `--instance NAME`，例如
`./deploy.sh --instance production worker-add account-b`。不要给不同用户复用同一个执行器名称。

## 故障和数据保留

构建或健康检查失败会返回非零状态并保留配置和数据。用同实例的 `status`、`logs`
定位错误；检查网络、Docker 空间、端口、原主密钥和镜像构建输出。修复后重新执行
`up`。如果 Docker 默认地址池用满，可以为新实例显式选择一个与宿主路由和 Docker
网络都不重叠的私有网段，例如 `./deploy.sh up --instance staging --subnet 10.251.33.0/24`。
容器仍使用动态地址。已有实例更改网段需先停掉该实例及连接到它的执行器。

`down` 不带 `--volumes`，也不会停止独立的用户执行器；需要停止执行器时使用
`worker-down NAME`。更新已有在线环境前应先检查用户会话和备份，参见
[维护 Skill](../.agents/skills/hapla-maintenance/SKILL.md)。
