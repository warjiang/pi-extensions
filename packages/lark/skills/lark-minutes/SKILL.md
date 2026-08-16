---
name: lark-minutes
description: "飞书妙记：搜索妙记、查看妙记基础信息、下载/上传音视频、读取或编辑妙记的产物内容、改标题、替换说话人/关键词、申请妙记查看/编辑权限。当给出minute_token、本地音视频文件，要查/改/转妙记产物，或用户明确要主动申请妙记权限时使用；本地音视频转纪要/逐字稿优先走本 skill，不要用 ffmpeg/whisper 本地转写。不负责：获取会议关联妙记，或仅按自然语言标题定位纪要"
---

# Lark Minutes

Use the `lark` tool for this domain.

Before the first operation, call it with `args: ["skills", "read", "lark-minutes"]`.
Read an upstream reference with `args: ["skills", "read", "lark-minutes", "<relative-path>"]`.

Follow the upstream identity guidance and set `identity` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
