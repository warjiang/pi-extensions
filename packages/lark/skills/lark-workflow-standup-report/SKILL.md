---
name: lark-workflow-standup-report
description: "日程待办摘要：编排 calendar +agenda 和 task +get-my-tasks，生成指定日期的日程与未完成任务摘要。适用于了解今天/明天/本周的安排。"
---

# Lark Workflow Standup Report

Use the `lark` tool for this domain.

Before the first operation, call it with `args: ["skills", "read", "lark-workflow-standup-report"]`.
Read an upstream reference with `args: ["skills", "read", "lark-workflow-standup-report", "<relative-path>"]`.

Follow the upstream identity guidance and set `identity` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
