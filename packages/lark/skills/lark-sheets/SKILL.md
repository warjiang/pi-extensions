---
name: lark-sheets
description: "飞书电子表格：创建和操作电子表格。支持创建表格、管理工作表与行列结构（增删/合并/调整尺寸/隐藏/冻结）、读写单元格（值/公式/样式/批注/单元格图片）、查找替换、多操作批量更新，以及图表、透视表、条件格式、筛选器、迷你图、浮动图片等对象的创建与维护。当用户需要创建电子表格、管理工作表、批量读写或编辑数据、统计汇总与可视化、表格美化、公式计算（含 Excel 公式迁移）、金融/财务建模（DCF、三张表、预算、Sensitivity 等）等任务时使用。若用户是想按名称或关键词搜索云空间（云盘/云存储）里的表格文件，请改用 lark-drive 的 drive +search 先定位资源。当用户给出 doubao.com 的 /sheets/ URL/token 时，也应直接使用本 skill，不要因为域名不是飞书而回退到 WebFetch；路由依据是 URL 路径模式和 token，而不是域名。"
---

# Lark Sheets

Use the `lark` tool for this domain.

Before the first operation, call it with `args: ["skills", "read", "lark-sheets"]`.
Read an upstream reference with `args: ["skills", "read", "lark-sheets", "<relative-path>"]`.

Follow the upstream identity guidance and set `identity` explicitly when it requires user access.
Pi manages authentication. Never invoke CLI auth, config, update, or profile commands.
