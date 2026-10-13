只有用户明确调用当前 Skill 时才进入 Better Codex 工作流。普通开发、修复或测试请求不启用本工作流。当前适配客户端：{{CLIENT}}；工具前缀：{{TOOL_PREFIX}}。

先调用 `{{TOOL_PREFIX}}bc_context` 或 `{{TOOL_PREFIX}}bc_project_list` 读取最新项目编号、根目录、状态和 revision。context 筛选参数只接受 `projectRef`、`taskRef`、`batchRef`，均可省略；空 context 或 project.list 用于列候选，问题详情从其所属项目 context 读取。项目 `P001`、任务 `P001-T001`、验收批次 `P001-A001`、问题 `P001-I001` 是永久编号。不要以聊天、窗口、分支、会话 ID 或当前目录代替编号。缺少当前操作需要的永久编号时，只列候选并要求用户明确选定，即使只有一个候选也不能静默选择或写入。用户提供清楚的项目名称时可查询项目列表，展示对应编号供其选择；不要自行把名称或聊天推断转换为已授权编号。

检查实际工作区的绝对根目录与所选项目 local root 一致；存在符号链接或路径大小写差异时比较解析后的真实路径。未匹配时不得修改业务代码。读取该工作区 AGENTS.md 并遵守项目规则，禁止修改其他项目。

写调用带唯一 `requestId` 和目标最新 `expectedRevision`：`charter.create`、`plan.tasks`、`batch.start`、`issue.create` 用项目 revision，`charter.save`、`charter.submit`、`task.claim`、`task.renew`、`task.submit`、`task.review` 用任务 revision，`batch.report` 用批次 revision，`issue.repair` 用问题 revision。只发送工具 inputSchema 声明的参数，不添加 actor、conversationId 或 operation。遇到 revision 冲突先重新读 context，核对是否仍在用户范围内；请求结果不明时只用原 requestId 和完全相同的参数重试，不能生成新 ID 重复变更。

任务阶段需要先 `{{TOOL_PREFIX}}bc_task_claim`，参数为 `{taskRef,phase,expectedRevision,requestId}`，phase 只能为 charter、develop、review。保存服务返回的 `executionId`、`leaseToken`、租约到期时间和最新任务 revision。租约为 30 分钟，在到期前调用 `{{TOOL_PREFIX}}bc_task_renew`，参数为 `{taskRef,executionId,leaseToken,expectedRevision,requestId}`；每次业务文件修改前再次 renew 验证租约及读取返回的任务 revision，长操作期间及时续租。租约失效、撤销、编号不存在或状态不允许时立即停止新的业务修改和提交，重新读取状态；不得越过其他执行者的租约。禁止将 leaseToken 写入代码提交、日志或面向用户的回复；只在需要它的工作流工具参数中传递。

证据数组使用 `{kind,result,detail,required}`，required 可省略并默认 true；result 写为已执行通过 `passed`、已执行不通过 `failed`、未执行 `not_run`。如实区分源码检查、自动测试、浏览器、设备、部署与人工验收，不把未执行验证写成 passed。根据任务验收标准、项目总纲和现有项目规则确定 required：必需检查保持 true；由项目规则留给人工、且本阶段未要求执行的设备或部署验证可记录 `{result:"not_run",required:false}`，detail 和 summary 明确尚未执行。不能因这些非本阶段必需项未执行就判定整个任务失败，也不能自行把必需项改成 false 避开验收。passed=true 至少需要一条 required=true 的 passed，任何 failed 都阻止通过，required=true 的 not_run 也阻止通过；required=false 的 not_run 只表示待人工补验，不意味着已通过。调用报错、超时、返回 isError 或服务未确认写入时，不宣称任务已完成；交付说明准确状态、证据与需要人操作的下一步。不得自动发起模型业务请求作为测试。

人工确认由 Better Codex 页面完成。本 Skill 无权确认项目总纲、人工验收任务、确认批次、撤销租约或重测问题；不要通过其他 API、脚本、数据库或修改配置绕过。工具 unavailable 时停止工作流写入并说明无法记录结果，不能用普通聊天记录替代状态。
