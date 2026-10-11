# 工作空间资料恢复通道的超时修复（2026-10-11）

复发时，已应用版本与源码一致，恢复计数为 34 次尝试、29 次成功、5 次拒绝。拒绝包含主动取消，不能把这五次全部归为代理或节点故障。

实际 usage-settings/accounts-check 错误的 betterCodexDiagnostics 指向本地 `/api/dev/account-metadata` POST，source 为 cdp_bridge_request、failure_type 为 transport。它已经进入备用传输；backend bridgeRequest 固定 8 秒中断，短于账户传输模块的 12 秒总期限和前端的 15 秒等待。因此上一版仍可能提前丢弃合法的较慢响应。当前动态系统代理下，单次直接账户 metadata GET 为 HTTP 200，约 1.5 秒，TLS 验证通过。

此次对齐这一通道的期限：账户模块仍为 12 秒，本地 metadata 桥接为 15 秒，前端为 18 秒；cancel 仍为 5 秒，其他桥接路径保留原有期限。后端固定有界期限，不接受调用方任意延长等待；认证、个人工作空间限制、原生策略、取消和身份复核继续生效。Clash 节点、端口、TUN、草稿和附件均未修改。

继续实际验证发现，另一次原生 v4 请求总计 272739ms 才在备用通道恢复。源码核实原生 readiness 已 ready，HTTP 发送链无自带单次 deadline，只支持外部 signal；retry:'never' 只影响401刷新重发，不能解决这个长等待，因此未采用。对已确认个人身份且原生请求仍携带认证标志的 metadata GET，增加10秒自有 AbortController：原生请求流程照常执行，实际取消并 reject 后才进入既有备用读取，使用原 caller signal。timer/listener 在 primary settle 时清理；外部取消、身份变化、组织请求和原生真实401/403政策拒绝均不作为超时恢复。取消不等于政策检查通过，最终仍由新响应的完整真实权限字段和原生 guard 处理。

原生 accounts/check 的独立 RPC 曾出现 10 秒超时。它返回账户数组并走另一个固定官方接口。源码核实此错误不是本次工作空间 banner 的直接条件，本轮没有改该 RPC、没有把账户 map 塞入数组查询，也没有改工作空间 guard。

新增 account-bridge-deadline 测试使用虚拟时钟及真实 AbortController，确认 9 秒合法响应能到达页面，12 秒上游安全错误能被完整返回，15 秒超时取消并释放连接，cancel 保持短期限，其他路径不能被调用方延长。测试不发网络或模型请求、不进行实际长等待。原有桌面桥接、原生会话恢复与源码重载检查继续通过。

新增 account-primary-deadline 无网测试确认10秒超时仅在原生请求实际 reject 后才单次恢复，外部取消和身份变化不重发，401/403政策错误即使与timer同时到达仍保留，普通接口、访客、组织账户没有额外timer，原caller signal及其他options引用保持，timer/listener及时清理。源码及运行进程已核对一致；修复后的实际原生工作空间刷新成功，耗时14201ms，触发备用读取一次、成功一次、无拒绝，查询为success/idle，无未完成备用请求。没有将此前272739ms的成功等待写成速度已合格。

真实原生工作空间查询验证及应用状态保存在 `C:\Users\admin\.codex\network\workspace-settings-deadline-20261011.json`，仅含状态和计数，不含令牌、账户 ID 或账户资料。该修复解决本地提前截断，不将短时成功当作所有代理线路的长期可用性保证。
