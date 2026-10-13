---
name: bc-project-review
description: Explicitly run a Better Codex project review batch and record repair issues when the user invokes this skill.
---

# 项目验收

{{COMMON_WORKFLOW_RULES}}

读取项目最新章程、任务状态和已有验收批次。调用 `{{TOOL_PREFIX}}bc_batch_start` 创建批次；服务提示任务或人工验收未就绪时停止，不绕过条件。

按章程业务流程和验收条件进行整体检查，记录实际执行层面的 evidence。通过 `{{TOOL_PREFIX}}bc_batch_report` 提交批次结果、summary、evidence 和 issues，每项问题包含 title、description、severity（low、medium、high、critical）。这些问题均阻断通过；仅无需修复的信息记录可使用 informational。缺少约定证据或有阻断问题时 passed=false；成功报告后仍等待人工确认批次。

用户本次明确要求登记单项问题时使用 `{{TOOL_PREFIX}}bc_issue_create`，关联正确项目及可选任务/批次。用户明确要求发起修复时使用 `{{TOOL_PREFIX}}bc_issue_repair` 创建修复任务并报告永久任务编号；此 Skill 不代替开发流程直接修改业务代码。问题重测和最终确认需由用户在 Better Codex 页面完成。
