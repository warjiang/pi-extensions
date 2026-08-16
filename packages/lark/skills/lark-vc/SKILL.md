---
name: lark-vc
description: "飞书视频会议：查询进行中的会议列表（含会议 ID）、读取会中实时内容（发言、聊天、共享等）、发送会中消息，以及搜索历史会议、查询会议纪要（总结/待办/章节/逐字稿）和参会人快照。Agent 真实入会/离会走 lark-vc-agent；查询未来日程走 lark-calendar。"
---

# Lark Vc

Use the `lark` tool for this domain.

Before the first operation, call it with `args: ["skills", "read", "lark-vc"]`.
Read an upstream reference with `args: ["skills", "read", "lark-vc", "<relative-path>"]`.

Follow the upstream identity guidance and set `identity` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
