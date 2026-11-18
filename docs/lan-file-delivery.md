# 局域网原文件交付

2026-09-20：浏览器访问私有地址时，工作区大文件和历史 R2 链接走 Hapla 同源 HTTP 文件接口，支持 Range、浏览器原生下载和账号隔离。公网访问保留 NAS 的 `/v1/upload`、`/v1/restore` 与 R2 直链。

## 如何判断

- 以浏览器地址栏和配置的 API 地址为准：RFC1918、回环、链路本地、Tailscale `100.64.0.0/10`、IPv6 ULA，以及 `.local`、`.localhost`、`.home.arpa`。
- 内网页面向当前 API 请求已认证的 `/v1/files/delivery-mode`，确认它也收到内网 Host。反向代理必须保留浏览器的 Host。
- 不用 Docker 对端 IP、`X-Forwarded-For` 或任意内网探测判断。公网域名即使在局域网内解析，也保守走公网通道；使用 `http://192.168.1.10:12345` 可明确选择局域网。
- 内网服务未准备好时明确报错，不把文件悄悄上传到 R2。

## 文件路径

1. 服务已有的 `/files/*` 附件直接读取原文件，不重传。
2. 工作台文件大于 1 MiB 时，通过所属 CLI 的 `file-direct-prepare/status/release` 将原文件流式传到 Hapla 服务。传输前后验证大小、修改时间和 SHA-256；完成后浏览器读取 `/files/direct/<id>`。同内容复用，上传中不会暴露半个文件。
3. 历史 R2 地址只接受当前桶的精确 origin 和路径前缀，参数化查询 NAS 本地索引，读取只读挂载的原片。过期签名也能查到原片，不调用 R2。路径和符号链接必须位于挂载目录内。
4. 封面从原片生成，保留原分辨率、比例、时长和字节数；NAS 不可写时，小型封面缓存写到 Hapla 数据目录。

同源文件请求同时需要系统访问 cookie 与账号媒体 cookie，或有效账号 bearer；每次都校验账号的文件授权。另一账号知道文件 ID 也无法读取。下载返回 `Content-Disposition: attachment`，由浏览器保存原字节。离开会话不会取消浏览器已经接管的下载。

临时传输目录为 `$DATA_DIR/direct-file-delivery`，每账号上限 32 GiB，4 个并发上传，24 小时到期，每小时清理。NAS 原片只保存授权映射，不复制到临时目录。大小、格式和上传限制继续在操作时校验，空输入框不再显示固定附件说明。

## 部署

前端、服务与各机器 CLI 需要一并更新。`deploy/compose.lan-files.yml` 是可选的 Compose 合并文件，需要提供：

- `HAPLA_NAS_ORIGINALS_DIR`：部署机器上的 NAS 原片目录。
- `HAPLA_R2_SOURCE_ORIGIN`：R2 endpoint 加桶名，不能只填写域名。
- `HAPLA_NAS_READER_DATABASE_URL_FILE`：连接字符串文件，使用独立只读账号；不要把它写入源码、镜像或前端配置。
- `HAPLA_NAS_DATABASE_NETWORK`：NAS PostgreSQL 所在 Docker 网络。

NAS PostgreSQL 账号仅授予 `assets`、`asset_versions`、`cache_copies` 的 SELECT 权限，并启用 `default_transaction_read_only=on`。这三个表是当前 NAS 服务的本地索引依赖；NAS 升级改变表结构时需要同步调整读取适配器。NAS 的两个公开 HTTP 接口没有变化。

服务需要能读取只读挂载的原片。不要通过 chmod 放宽整个 NAS 目录；使用正确的文件属主或 ACL。直接传输仍经过 Hapla 的认证和 Nginx，未公开 NAS 或 PostgreSQL 端口。

## 终端和滚动修复

Mac 的 node-pty 安装包可能把 `spawn-helper` 安装为 0644。CLI 启动终端前只补齐 helper 的属主执行位，权限修复失败时返回可理解的错误。

前端仅用明确的滚轮、触摸或键盘输入退出底部跟随；布局变化和延迟 scroll 事件不会关闭跟随。主动上滑保持阅读位置；滑回底部、点击回到最新或成功发送新问题时恢复跟随。切换视图若原来位于底部，也保留跟随。

## CLI 更新注意事项

本机和 Mac 的后台 daemon 可在替换构建时交接现有 worker。容器若直接以 daemon 为主进程，交接退出会触发 Docker 重启，不能假定 worker 进程会保留。更新前记录在线会话、确认空闲，更新后用原 conversationId 和 Codex threadId 恢复这些会话；不要恢复用户原本手动离线的会话，也不要发送测试提问。
