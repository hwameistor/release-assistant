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

上述模型响应测试使用本地模拟服务，不代表真实 Copilot 推理已经通过。实际 Copilot 预览需要配置 `COPILOT_GITHUB_TOKEN` 后运行 `Preview release notes`。真实 GitHub Release/Chart 索引/镜像发布未执行；发布集成 PR 必须在启用产品发布前审阅和验证。
