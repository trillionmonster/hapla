# Codex 原始协议日志

原始协议日志与会话消息分开保存。普通消息只接收明确映射的可展示事件；未经标记的推理内容不会进入普通消息或思考摘要卡片。

CLI 在私有日志目录写入 `codex-<uuid>.jsonl`，保留双向 JSON-RPC 和规范化事件。每条记录包含 `version`、CLI 版本、adapter，以及带有 `epoch`、`epochStartedAt`、`seq`、时间和 thread/turn/item/request 关联的 `protocol`。日志和旁边的 `.index` 文件权限为 `0600`；索引只记录字节范围及关联信息，不复制输出正文。

运行时通过 `ApiSessionClient.attachCodexProtocolJournal(client.protocolJournalPath)` 关联日志。上传器使用固定大小的字节读取，每个原始记录按 24 KiB 切片，将原始字节的 Base64 表示和关联信息一起使用会话密钥加密。单次上传最多 200 KiB 密文、32 个分片。

`logs/protocol-outbox/<server-and-session-hash>/` 保存上传游标及待确认批次。发送前先原子保存实际密文；超时、断网或进程重启后重发相同密文，收到每片的持久化回执后才推进游标。重新关联同一 server/session 会自动发现之前未确认的日志。失败不删除原始日志或待确认批次。

服务端只保存密文及分页所需的 epoch/seq/part 元数据：

- `GET /v1/sessions/:sessionId/protocol/epochs`：每页最多 20 个连接 epoch，按 `before_at`、`before_epoch` 游标向前读取。
- `POST /v1/sessions/:sessionId/protocol/:epoch/chunks`：保存 `{epochStartedAt, chunks:[{seq,part,parts,content}]}`。会话、epoch、seq、part 构成唯一键；相同内容重试幂等，冲突返回 409 并回滚整批。
- `GET /v1/sessions/:sessionId/protocol/:epoch/chunks`：按 `after_seq`、`after_part` 游标向后读取。最多 32 片，响应不超过 256 KiB。要读取某个序号的开头，使用该序号和 `after_part=-1`。

所有接口都验证登录用户对会话的所有权。删除会话会级联删除协议日志。协议写入不会分配消息序号，也不会广播 `new-message`。

诊断组件只保存当前页，校验解密后的 session/epoch/seq/part 关联。它不拼接大型原始记录；用户逐片查看，跳转或翻页会替换旧页。关闭、导航失焦或切换会话会取消读取并释放正文。诊断接口和浏览器读取器均有字节限制。

`lastSeq` 表示服务端见到的最大序号，不代表该序号的所有分片都已上传。重建原始记录时应验证 `parts` 片齐全、按 `part` 排序拼接原始字节，再进行 UTF-8 解码；不能分别解码后拼接，UTF-8 字符可能跨片边界。

回归覆盖真实 PGlite/Fastify 的授权、幂等、冲突回滚、字节分页和级联删除，CLI 的多兆 UTF-8 字节一致性、未知回执后的重启重发和会话隔离，以及浏览器读取上限和解密关联校验。
