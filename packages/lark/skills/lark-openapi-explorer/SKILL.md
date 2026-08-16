---
name: lark-openapi-explorer
description: "飞书/Lark 原生 OpenAPI 探索：从官方文档库中挖掘未经 CLI 封装的原生 OpenAPI 接口。当用户的需求无法被现有 lark-* skill 或 lark-cli 已注册命令满足，需要查找并调用原生飞书 OpenAPI 时使用。"
---

# Lark Openapi Explorer

Use the `lark` tool for this domain.

Before the first operation, call it with `args: ["skills", "read", "lark-openapi-explorer"]`.
Read an upstream reference with `args: ["skills", "read", "lark-openapi-explorer", "<relative-path>"]`.

Follow the upstream identity guidance and set `identity` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
