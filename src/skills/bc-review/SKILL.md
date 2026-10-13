---
name: bc-review
description: Explicitly review a numbered Better Codex task against its charter and acceptance criteria when the user invokes this skill.
---

# 任务审查

{{COMMON_WORKFLOW_RULES}}

读取目标任务、已确认章程、开发提交与证据，确认当前允许审查。claim `review` 阶段；服务拒绝自审或当前执行者无权审查时停止，不切换身份绕过。

检查实际代码和可复现证据是否覆盖 acceptance，关注范围偏离、行为缺陷、遗漏、兼容性和未验证项。按任务约定开展独立验证，不能仅复述开发者总结。发现问题时说明具体触发条件、影响和定位；此阶段不直接修复业务代码。

renew 后通过 `{{TOOL_PREFIX}}bc_task_review` 提交 `passed`、summary 和 evidence。有阻断问题时 passed=false；缺少约定的实际验证证据时不能标通过。服务接受的通过结果仍需用户在 Better Codex 页面人工验收；回读核对状态并报告真实结论。
