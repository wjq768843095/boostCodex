---
name: bc-charter
description: Explicitly draft and submit a Better Codex project charter for human confirmation when the user invokes this skill.
---

# 项目章程

{{COMMON_WORKFLOW_RULES}}

读取项目最新状态，调用 `{{TOOL_PREFIX}}bc_charter_create` 创建或获取章程草稿任务。使用返回的任务编号和 revision claim `charter` 阶段；已有被其他执行者占用的草稿应停止，不能另建绕过。

围绕用户目标明确业务背景、目标、范围与排除项、关键流程、约束、可验证验收条件和未决事项。只在缺少决定性信息时向用户澄清，不擅自增加功能或上线授权。

通过 `{{TOOL_PREFIX}}bc_charter_save` 保存草稿，准备提交时 renew 取得最新任务 revision，再通过 `{{TOOL_PREFIX}}bc_charter_submit` 提交相同正文。提交成功仅表示等待人确认；告知用户在 Better Codex 项目页面查看并确认章程。未经人工确认不开始任务规划或开发。
