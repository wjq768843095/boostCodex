---
name: bc-develop
description: Explicitly develop a numbered boostCodex task under its execution lease when the user invokes this skill.
---

# 任务开发

{{COMMON_WORKFLOW_RULES}}

必须使用用户明确提供的 taskRef 读取目标任务、关联项目与当前已确认项目总纲，确认任务允许开发。claim `develop` 阶段取得执行租约后再修改业务代码。按任务 requirements、acceptance 和 scopePaths 实现；必要变更超出范围时停止该部分，说明原因等待用户调整任务。

保留其他执行者及用户的改动。运行与行为相关、且项目允许的检查，不为工作流验收调用模型业务请求。记录改动和具体证据，并标明仍需手工执行的验收。

提交前 renew，调用 `{{TOOL_PREFIX}}bc_task_submit`，参数为 `{taskRef,summary,evidence,executionId,leaseToken,expectedRevision,requestId}`，summary 描述实现、证据和未验证项，evidence 如实列出检查。服务成功接受后任务进入待自动审查；不得直接称为人工验收通过。回读确认状态并告知任务编号及下一步审查入口。
