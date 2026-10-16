---
name: bc-charter
description: Explicitly draft and submit a boostCodex project charter for human confirmation when the user invokes this skill.
---

# 项目总纲

{{COMMON_WORKFLOW_RULES}}

按用户明确给出的编号和动作分流：

- `$bc-charter P001 create`：先 context `{projectRef:"P001"}` 检查最新项目及总纲草稿。仅在没有未确认草稿时调用 `{{TOOL_PREFIX}}bc_charter_create`，参数为 `{projectRef,expectedRevision,requestId}`；已有草稿时列出原 taskRef，要求用户用该任务编号继续，不另建或猜测。
- `$bc-charter P001-T001 continue`，或用户已明确提供总纲 taskRef：只 context `{taskRef:"P001-T001"}` 读取原任务及总纲，不调用 charter.create。确认 task.type 为 charter 且 task.status 为 draft 后，使用原 taskRef 调用 `{{TOOL_PREFIX}}bc_task_claim`，参数为 `{taskRef,phase:"charter",expectedRevision,requestId}`。已提交或已确认时说明现状，不继续改写；其他执行者占用时停止，不新建绕过。
- 缺少所需编号、只有项目编号却未明确 create、或要求 continue 却未给原 taskRef：只列候选并要求明确操作，不自动写入。

创建成功后用服务返回的 task.ref 和 task.revision claim `charter` 阶段。所有保存、续约和提交都使用同一个总纲任务编号及本次有效租约。

围绕用户目标明确业务背景、目标、范围与排除项、关键流程、约束、可验证验收条件和未决事项。只在缺少决定性信息时向用户澄清，不擅自增加功能或上线授权。

通过 `{{TOOL_PREFIX}}bc_charter_save` 保存正文，参数为 `{taskRef,content,executionId,leaseToken,expectedRevision,requestId}`。保存成功后核对服务返回的已保存正文和最新任务 revision；提交前 renew，再调用 `{{TOOL_PREFIX}}bc_charter_submit`，仅传 `{taskRef,executionId,leaseToken,expectedRevision,requestId}`，不传 content。submit 提交服务中已保存的正文，提交成功仅表示等待人确认；告知用户在 boostCodex 项目页面查看并确认项目总纲。未经人工确认不开始任务规划或开发。
