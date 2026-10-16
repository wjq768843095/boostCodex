---
name: bc-plan
description: Explicitly plan boostCodex tasks from the confirmed charter when the user invokes this skill.
---

# 任务规划

{{COMMON_WORKFLOW_RULES}}

必须使用用户明确提供的 projectRef 读取最新项目及人工确认的项目总纲版本。没有已确认版本时停止规划，并说明应先完成项目总纲确认。

按可独立交付的业务行为拆解任务。每项填写 `title`、`requirements`、`acceptance` 与相对项目根目录的 `scopePaths`；requirements 和 acceptance 使用完整字符串，路径限制在项目内。写明依赖或执行顺序，不靠聊天上下文隐含关键要求，不创建超出项目总纲范围的任务。

通过 `{{TOOL_PREFIX}}bc_plan_tasks` 一次提交本轮任务，参数为 `{projectRef,charterVersion,tasks,expectedRevision,requestId}`，charterVersion 为已确认版本整数；成功后回读 context 核对新任务永久编号、范围和状态，再报告规划结果。此 Skill 只规划任务；开发需用户明确调用开发 Skill。
