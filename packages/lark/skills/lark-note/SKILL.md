---
name: lark-note
description: "飞书会议纪要（Note）直查：已知 note_id 时查询纪要详情、展示类型、关联文档 token，并读取 unified 原始逐字记录。当用户已持有 note_id，或从文档显式 vc-node-id 获得 note_id 时使用。不负责会议/日程/妙记定位、文档标题搜索或 Docx 正文读取。"
---

# Lark Note

Use the `lark` tool for this domain.

Before the first operation, call it with `args: ["skills", "read", "lark-note"]`.
Read an upstream reference with `args: ["skills", "read", "lark-note", "<relative-path>"]`.

Follow the upstream identity guidance and set `identity` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
