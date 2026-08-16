---
name: lark-calendar
description: "飞书日历：管理日历日程和会议室。查看/搜索日程、创建/更新日程、管理参会人、查询忙闲和推荐时段、预定会议室。当用户需要查看日程安排、创建/修改会议、查询/预定会议室时使用。不负责：查询过去的视频会议记录（走 lark-vc）、待办任务（走 lark-task）。"
---

# Lark Calendar

Use the `lark` tool for this domain.

Before the first operation, call it with `args: ["skills", "read", "lark-calendar"]`.
Read an upstream reference with `args: ["skills", "read", "lark-calendar", "<relative-path>"]`.

Follow the upstream identity guidance and set `identity` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
