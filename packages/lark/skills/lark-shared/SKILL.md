---
name: lark-shared
description: "Use for lark-cli setup/auth tasks: auth login/status/logout, user vs bot identity, business-domain permissions (--domain, including all/docs/drive), missing scopes, revoking authorization, or handling _notice JSON."
---

# Lark Shared

Use the `lark` tool for this domain.

Before the first operation, call it with `args: ["skills", "read", "lark-shared"]`.
Read an upstream reference with `args: ["skills", "read", "lark-shared", "<relative-path>"]`.

Follow the upstream identity guidance and set `identity` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
