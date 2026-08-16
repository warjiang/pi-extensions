---
name: lark-skill-maker
description: "创建 lark-cli 的自定义 Skill。当用户需要把飞书 API 操作封装成可复用的 Skill（包装原子 API 或编排多步流程）时使用。"
---

# Lark Skill Maker

Use the `lark` tool for this domain.

Before the first operation, call it with `args: ["skills", "read", "lark-skill-maker"]`.
Read an upstream reference with `args: ["skills", "read", "lark-skill-maker", "<relative-path>"]`.

Follow the upstream identity guidance and set `identity` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
