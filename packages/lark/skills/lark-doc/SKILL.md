---
name: lark-doc
description: "飞书云文档（Docx / Wiki）内容操作：读取、创建、编辑文档，插入或下载图片附件，以及操作思维笔记。用户提供文档 URL/token（包括 doubao.com 的 /docx/、/wiki/）时使用；按 URL 路径/token 而非域名路由。文档内嵌资源按读取参考中的统一规则分流。文档评论走 lark-drive；表格或 Base 内部数据操作不在本 skill。"
---

# Lark Doc

Use the `lark` tool for this domain.

Before the first operation, call it with `args: ["skills", "read", "lark-doc"]`.
Read an upstream reference with `args: ["skills", "read", "lark-doc", "<relative-path>"]`.

Follow the upstream identity guidance and set `identity` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
