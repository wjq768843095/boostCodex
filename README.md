# Better Codex 本地开发版

基于 Better Codex 0.4.18 的本地定制版本。项目资料、任务元信息和看板由 Better Codex 管理；总纲、任务规划及工作任务的聊天打开完整 Codex 原生界面，使用原生模型、权限和模式设置。

## 使用流程

1. 选择项目，核对工作目录及资料，在规划页打开总纲会话。已有项目依据实际目录和代码整理资料，新项目依据已知需求建立总纲。
2. 在总纲原生会话中阅读、修订并明确确认当前总纲。确认必须来自绑定会话中的真实用户消息；总纲变更后需要重新确认。
3. 总纲确认后，从项目规划页打开独立的任务规划会话。计划包含目标、范围、架构契约、目录职责、依赖、交付物和人工验收步骤。
4. 返回规划页，以单份文档阅读总纲章节和任务列表。勾选条目并转入待办池（backlog）；转换不会自动执行任务，重复转换不会重复创建。
5. 在工作看板编辑任务元信息、架构和验收内容，按现有启动方式执行任务。聊天使用完整原生界面；返回入口可回到项目规划或任务详情。

总纲、规划和工作会话各自绑定，不复制聊天到规划页，也不提供另一个聊天输入框。

总纲修订后，已转换任务继续引用原确认版本。需要同步时，在任务规划会话明确选择更新相应条目的规划资料；未开始执行的任务按当前版本更新，重复转换本身不会覆盖任务。

## Skill 管理

Skill 管理优先展示托管条目，可新建、编辑和删除；内置总纲及规划 Skill 可编辑、不能删除。保存和删除检查版本，避免覆盖较新的修改。外部 Skill 只读展示调用信息，不由 Better Codex 修改其文件。

任务可以选择 Skill；模型、推理强度、Fast 模式和权限由原生 Codex 管理。旧角色配置保留兼容读取，不再提供角色配置写入入口。

## MCP 与数据

保留 `board` 工具，并提供五项项目工具：

| 工具 | 用途 |
| --- | --- |
| `project_context_read` | 读取目录证据、总纲、计划和确认候选 |
| `project_charter_save` | 保存单份总纲的草稿章节 |
| `project_charter_confirm` | 使用真实用户消息确认当前总纲 |
| `project_plan_save` | 依据已确认总纲保存计划，不执行任务 |
| `project_plan_convert` | 把明确选中的计划条目转为 backlog 任务 |

工具校验项目和会话绑定、资料版本及操作范围。确认记录只保存必要的消息标识、摘要校验和版本证据；原生聊天仍由 Codex 保存。

`C:\Users\admin\.better-codex` 是现有唯一权威数据目录，保存项目总纲、计划、任务及托管 Skill 元数据。托管 Skill 按本机 Skill 目录导出；外部 Skill 不迁入、不覆盖。不复制数据库、凭据或聊天到源码。

本版本移除了远程 Web 页面、远程登录、Relay、Sync 的服务和命令入口；保留本地 Runtime、MCP、原生会话中继及本地固定版本启动入口。

## 本轮保留的执行限制

1. 依赖用于规划展示和提示，没有新增依赖执行约束，任务仍可能提前启动。
2. 计划写明验收内容，但完成状态沿用原判断，没有新增统一验收门槛。
3. 原生直接续聊与看板启动的状态回流沿用原机制，二者仍可能不同。
4. 旧调度结果仍可能覆盖较新回合状态，没有新增调度版本防护。
5. 多任务修改共享模块时，通过规划明确责任和顺序，没有新增文件锁或隔离机制。

## 编辑位置

- `src/ui/better-codex-ui.js`：已提取的界面代码和样式，保存后自动校验并重新注入。
- `src/backend/better-codex.cjs`：保留现有打包代码的后台入口，保存后自动重载。后续可逐步拆分模块。
- `src/modules/`：总纲、计划、托管 Skill、工作目录及原生会话模块。
- `src/skills/`：内置总纲和规划 Skill 源码。
- `integration/`：启动器、注入、监听、重载协调和迁移/恢复工具。
- `integration/codex-compatibility.json`：已迁出的 Codex 界面选择器、属性、路由及能力适配配置；修改后自动校验并重载。

生成程序、恢复快照和日志在 `.dev/`，不手动编辑。数据仍在 `C:\Users\admin\.better-codex`，不复制进项目，不提交数据库或凭据。

## 日常使用

从原来的 Better Codex 桌面入口启动即可。监听器自动运行；保存 `src` 或 `integration` 下的 JS/CJS 文件后自动生效，无需复制文件或手动编译。连续保存会合并处理。

界面更新保留选中的项目、页签、输入草稿、焦点与滚动位置。后台有运行中的工作时等待空闲，空闲后重载。语法错误保留当前程序；新后台启动失败恢复上一版。

本轮已通过原生 `config/mcpServer/reload` 加载项目工具，两个内置 Skill 与迁移 Skill 均可被宿主发现，无需为本轮改动重启 Codex。核对结果见 [VALIDATION.md](VALIDATION.md)。后续改动 MCP 定义时需刷新宿主工具；如果刷新不可用再重启 Codex，源码监听不会强制结束当前聊天。

## 命令

在本项目目录运行（无需安装 npm 依赖）：

```powershell
npm start        # 启动本地服务、监听并接入当前 Codex
npm run launch   # 从固定入口打开 Codex
npm run status   # 查看程序、监听器和最近重载状态
npm run repair   # Codex 更新后重新发现安装位置并重新接入
npm test         # 源码、重载及独立 fixture 检查
npm run stop     # 停止本地服务和监听器
npm run rollback # 恢复迁移前安装入口，保留数据库
```

也可以双击项目根目录的 `repair.cmd` 修复接入。`npm run repair` 针对当前环境重新发现并接入；新版 Codex 如果改变界面或会话接口，需要调整接入层，不能保证所有未来版本自动兼容。

独立 HTTP 接线测试为 `node tests/native-backend.cjs`，使用临时 HOME、数据库和工作目录，不发送模型请求。`tests/ui-smoke.cjs` 和 `tests/acceptance.cjs` 对应历史自绘聊天界面，不作为本轮验收步骤。

当前桌面可使用 `node tests/installed-native.cjs --refresh-mcp --check-reload` 核对工具、Skill 和界面重载。它只读取宿主信息、刷新注入并恢复视图，不新建聊天、不发送消息；结果保存为 `.dev/native-planning-acceptance.json`。

历史迁移记录在 `.dev/acceptance.json`、`.dev/startup-acceptance.json` 与 `.dev/data-acceptance.json`，重载诊断在 `.dev/status.json` 与 `.dev/events.jsonl`。原程序、启动配置和经过完整性检查的数据库备份在 `.dev/backups/`。恢复程序不会用旧数据库覆盖当前数据。

本轮实际验收结果及未验证范围见 [VALIDATION.md](VALIDATION.md)。
