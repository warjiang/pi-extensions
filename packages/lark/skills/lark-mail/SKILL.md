---
name: lark-mail
description: "飞书邮箱：Use when user mentions 起草邮件、写邮件、草稿、发送/回复/转发邮件、查阅邮件、看邮件、搜索邮件、邮件文件夹、邮件标签、邮件联系人、监听新邮件、邮件收信规则等；use for mail/email intent only. Do not use for docs/sheets/calendar/auth setup/pure contact lookup/IM chat tasks."
---

# Lark Mail

Use the `lark` tool for this domain.

Before the first operation, call it with `args: ["skills", "read", "lark-mail"]`.
Read an upstream reference with `args: ["skills", "read", "lark-mail", "<relative-path>"]`.

Follow the upstream identity guidance and set `identity` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
