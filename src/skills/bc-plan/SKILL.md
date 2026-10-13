---
name: bc-plan
description: Explicitly plan Better Codex tasks from the confirmed charter when the user invokes this skill.
---

# 任务规划

{{COMMON_WORKFLOW_RULES}}

读取最新项目及人工确认的章程版本。没有已确认版本时停止规划，并说明应先完成章程确认。

按可独立交付的业务行为拆解任务。每项填写 `title`、`requirements`、`acceptance` 与相对项目根目录的 `scopePaths`；requirements 和 acceptance 使用完整字符串，路径限制在项目内。写明依赖或执行顺序，不靠聊天上下文隐含关键要求，不创建超出章程范围的任务。

通过 `{{TOOL_PREFIX}}bc_plan_tasks` 一次提交本轮任务，带明确的已确认 `charterVersion` 和项目 revision；成功后回读 context 核对新任务永久编号、范围和状态，再报告规划结果。此 Skill 只规划任务；开发需用户明确调用开发 Skill。
