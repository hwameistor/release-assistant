# 首版验证记录

2026-10-23，本地 Node.js 24、Git、Python 3 环境，无 GPU、未连接测试集群。

- TypeScript 类型检查、构建通过。
- 15 项 Node 测试通过：真实临时 Git 历史、重跑/失败恢复、过期范围、引用覆盖、路径、两个模型适配器、发布元数据。
- 7 项 Python 发布伴随脚本测试通过：预发布创建参数、相同资产重跑、tag/正文/内容冲突、Helm 时间戳变化、二进制上传不修改发布元数据且不覆盖不同内容。
- Actions 工作流通过 actionlint v1.7.7 检查。
- 固定版本的 Copilot SDK 自带运行时成功启动；不依赖全局 CLI。
- npm audit 未报告已知漏洞。

真实只读采集：`hwameistor/hwameistor-operator` 的 `v1.1.1`（`e0b6bc166135f42c4afe5080983dd3e2e9d71949`）至 `release/v1.1` 的 `61fe6fbadf53a46e375208ca24c52af7c16c48b0`。

- 14 个提交，归入 PR #395、#398、#399、#400。
- 最终 diff 为 30,316 字节；去重后的完整证据 JSON 为 89,922 字节，保留全部提交来源。
- 此次只读采集没有创建源仓库 PR、tag、Release 或修改集群资源。

## 真实 Copilot 预览和重跑

已配置仓库 Actions Secret `COPILOT_GITHUB_TOKEN`，使用有 Copilot Requests 权限的个人 token。

- [运行 39939664002](https://github.com/hwameistor/release-assistant/actions/runs/39939664002)，工具提交 `18d98a5`，模型 `gpt-4.1`。首次执行和原生 Re-run all jobs 均成功。
- 预览版本为 `v1.1.2-alpha1`，范围与上面的 Operator 采集一致。两次均生成 3 条摘要，覆盖全部 4 个 PR，无排除项；结构及来源校验通过。
- 两次 `snapshot.json` 字节完全一致，SHA-256 为 `d96de8669c3c02aa6db725ac4525542e104c4c04e86bde70455bb666aeabcbf1`；输入证据也一致。
- 生成时间分别为北京时间 2026-10-23 18:31:40、18:32:46，摘要措辞不同，确认重跑重新调用模型。
- 最新产物为该运行的 `release-preview-39939664002-2` artifact，其中包括版本日志、完整证据和 manifest。

首次尝试暴露了重跑时上次 artifact 不可用的问题。预览现使用以 run ID 为键的不可变 Actions cache 保存范围，artifact 仅用于输出。缓存丢失时重跑明确失败，不自动推进范围。正式 Release PR 的范围仍保存在 Git 分支中。

内容审阅：模型归纳了环境变量配置、迁移配置和 CI 行为，而非照抄 PR 标题。但部分 JuiceFS 运行时及特殊文件行为来自 PR 描述，当前 Operator diff 不足以独立证明；模型也没有为所有这类表述设置 `needsReview`。发布前应核对这些外部组件行为，或删除无法支持的表述。结构/来源校验不代表每条 AI 解释均准确。

本次真实测试为只读预览，没有创建业务 Release PR、tag 或 Release。相同 PR 更新、最新模板和失败恢复的生成器测试目前仍为本地 Git/模拟 GitHub 验证。真实 GitHub Release/Chart 索引/镜像发布未执行；发布集成 PR 必须在启用产品发布前审阅和验证。
