---
name: lark-whiteboard
description: "飞书画板：查询和编辑飞书云文档中的画板。支持导出画板为预览图片、导出原始节点结构、使用多种格式更新画板内容。 当用户需要查看画板内容、导出画板图片、编辑画板时使用此 skill。不负责：飞书云文档内容编辑（lark-doc）、文档内嵌电子表格/Base（lark-sheets / lark-base）。\n"
---

# Lark Whiteboard

Use the `lark` tool for this domain.

Before the first operation, call it with `args: ["skills", "read", "lark-whiteboard"]`.
Read an upstream reference with `args: ["skills", "read", "lark-whiteboard", "<relative-path>"]`.

Follow the upstream identity guidance and set `identity` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
