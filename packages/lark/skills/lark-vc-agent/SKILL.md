---
name: lark-vc-agent
description: "飞书视频会议会中能力：用于让应用机器人真实加入或离开正在进行的会议，并读取当前身份可见的会中事件、发送会中文本消息或会中表情。适用于用户询问正在开的会议发生了什么、谁在发言、是否共享内容，或需要发现当前可读的进行中会议 ID。不负责已结束会议搜索、参会人快照、纪要、逐字稿或录制查询，这些使用 lark-vc 技能。"
---

# Lark Vc Agent

Use the `lark` tool for this domain.

Before the first operation, call it with `args: ["skills", "read", "lark-vc-agent"]`.
Read an upstream reference with `args: ["skills", "read", "lark-vc-agent", "<relative-path>"]`.

Follow the upstream identity guidance and set `identity` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
