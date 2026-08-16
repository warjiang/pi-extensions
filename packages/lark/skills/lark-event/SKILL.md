---
name: lark-event
description: "Lark/Feishu real-time event listening / subscribing / consuming: stream events as NDJSON via `lark-cli event consume {EventKey}` (covers IM messages/reactions/chat changes, Approval status changes, Task updates, VC meeting started/joined/ended, Minutes generated, Whiteboard updated, etc.). Use for Lark bots, real-time message processing, long-running subscribers, streaming webhook/push handlers. Supports `--max-events` / `--timeout` bounded runs and a stderr ready-marker contract — designed for AI agents running as subprocesses."
---

# Lark Event

Use the `lark` tool for this domain.

Before the first operation, call it with `args: ["skills", "read", "lark-event"]`.
Read an upstream reference with `args: ["skills", "read", "lark-event", "<relative-path>"]`.

Follow the upstream identity guidance and set `identity` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
