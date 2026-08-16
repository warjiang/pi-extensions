---
name: lark-base
description: "飞书多维表格（Base）操作：建表、字段、记录、视图、统计、公式/lookup、表单、仪表盘、应用模式（BaseApp/AppMode 页面与组件）、Workspace 目录、workflow、角色权限；遇到 Base/多维表格/bitable、BaseApp/AppMode，或应用模式的 /app/ 链接（可能同时包含 /base/workspace/{workspace_token}）时使用。BaseApp 不走 lark-apps；文件导入/导出转 lark-drive，认证/授权转 lark-shared。"
---

# Lark Base

Use the `lark` tool for this domain.

Before the first operation, call it with `args: ["skills", "read", "lark-base"]`.
Read an upstream reference with `args: ["skills", "read", "lark-base", "<relative-path>"]`.

Follow the upstream identity guidance and set `identity` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
