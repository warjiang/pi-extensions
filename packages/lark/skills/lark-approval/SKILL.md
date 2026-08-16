---
name: lark-approval
description: "飞书审批：查询和处理审批待办/已办/实例，搜索可发起审批定义、查看定义详情并发起原生审批实例。当用户要处理审批任务、查看审批实例、搜索或发起审批时使用。审批待办不是飞书任务；非审批类待办走 lark-task。不负责创建审批定义；三方审批定义不走原生提单。"
---

# Lark Approval

Use the `lark` tool for this domain.

Before the first operation, call it with `args: ["skills", "read", "lark-approval"]`.
Read an upstream reference with `args: ["skills", "read", "lark-approval", "<relative-path>"]`.

Follow the upstream identity guidance and set `identity` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
