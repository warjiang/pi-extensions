---
name: lark-workflow-meeting-summary
description: "会议纪要整理工作流：汇总指定时间范围内的会议纪要并生成结构化报告。当用户需要整理会议纪要、生成会议周报、回顾一段时间内的会议内容时使用。"
---

# Lark Workflow Meeting Summary

Use the `lark` tool for this domain.

Before the first operation, call it with `args: ["skills", "read", "lark-workflow-meeting-summary"]`.
Read an upstream reference with `args: ["skills", "read", "lark-workflow-meeting-summary", "<relative-path>"]`.

Follow the upstream identity guidance and set `identity` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
