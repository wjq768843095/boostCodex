---
name: bc-project-review
description: Explicitly run a boostCodex project review batch and record repair issues when the user invokes this skill.
---

# 项目验收

{{COMMON_WORKFLOW_RULES}}

按用户明确给出的永久编号分流：projectRef 用于开始新批次，batchRef 用于继续原批次。

- `$bc-project-review P001 start`：context `{projectRef:"P001"}` 读取项目最新总纲、任务与批次。调用 `{{TOOL_PREFIX}}bc_batch_start`，参数为 `{projectRef,expectedRevision,requestId}`，使用项目 revision。服务提示任务或人工验收未就绪时停止，不绕过条件。
- `$bc-project-review P001-A001 continue`：只 context `{batchRef:"P001-A001"}` 读取原批次及关联项目，不调用 batch.start。核对原批次状态、任务集和基线仍可验收，再继续该 batchRef；awaiting_confirmation 时说明等待人工确认，不重复报告创建问题；confirmed 时只报告已确认结果，不重新写入。
- 只有项目编号却要求继续、或缺少编号：只列原批次候选并要求用户给出 batchRef，不新建替代批次或推断。

按项目总纲业务流程和验收条件进行整体检查，记录实际执行层面的 evidence。通过 `{{TOOL_PREFIX}}bc_batch_report` 提交，参数为 `{batchRef,passed,summary,evidence,issues,expectedRevision,requestId}`，使用最新批次 revision。每项 issues 包含 title、description、severity（low、medium、high、critical）；这些问题均阻断通过，仅无需修复的信息记录可使用 informational。缺少约定证据或有阻断问题时 passed=false；成功报告后仍等待用户在 boostCodex 页面人工确认批次。

用户本次明确要求登记单项问题且给出 projectRef 时使用 `{{TOOL_PREFIX}}bc_issue_create`，参数为 `{projectRef,title,description,expectedRevision,requestId}`，可以增加用户已选定的 batchRef/taskRef，使用项目 revision。用户明确要求修复且给出 issueRef 时，从其所属项目 context 读取问题，调用 `{{TOOL_PREFIX}}bc_issue_repair`，参数为 `{issueRef,expectedRevision,requestId}`，使用问题 revision，成功后报告服务返回的永久修复任务编号；此 Skill 不代替开发流程直接修改业务代码。问题重测和最终确认需由用户在 boostCodex 页面完成。
