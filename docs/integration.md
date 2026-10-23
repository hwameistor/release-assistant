# HwameiStor 发布接入

准备阶段生成可审核的 Release PR；发布阶段从本次固定提交读取已审核的版本日志，作为 GitHub Release 正文。Chart、二进制和镜像继续按原有触发条件构建，使用相同的源代码 SHA 和版本。

## 接入位置

| 仓库 | 配置中声明的 Chart | 发布工作流 |
| --- | --- | --- |
| `hwameistor/hwameistor` | `helm/hwameistor/Chart.yaml` | `.github/workflows/release-chart.yaml` |
| `hwameistor/hwameistor-operator` | `helm/operator/Chart.yaml` | `.github/workflows/release-image.yaml` |

两仓库各自安装 Prepare/Validate 工作流、配置、规范和模板。先在默认分支安装 Prepare，目标 release 分支也要有 Validate。X.Y 由维护者保持对应，补丁版本独立，不自动更新另一仓库版本。生成器只更新 Chart 的 `version` 和 `appVersion`，不替换 values 中的依赖/工具镜像 tag。

需要配置 `RELEASE_ASSISTANT_TOKEN` 和 `COPILOT_GITHUB_TOKEN`，或改用兼容端点及 `RELEASE_ASSISTANT_API_KEY`。推荐 App installation token；如使用 PAT，限定目标仓库权限。模型凭据与创建 PR 的凭据分开。

Copilot 主动调查使用独立的只读 GitHub 工具。Prepare 工作流声明 `contents: read`、`issues: read`、`pull-requests: read`；Action 的 `research-token` 默认使用 `github.token`，无需新增 Secret。保持 `token` 作为发布 PR 的凭据，不把它传入 `research-token`。运行产物 `research.json` 用于审阅实际查询证据；跨仓库补充资料当前仅支持明确关联的公开仓库。

## 合并和发布

Release PR 内容和排除理由评审通过后，人工合并。Chart 变更按原有触发条件进入发布链路，测试 PR 应保持草稿，不能为了验证正文而触发真实产品发布。

1. 检出发布源代码并记录完整 SHA。Operator 手动发布使用输入分支，之后的镜像任务复用该 SHA。
2. 调用 Release Assistant 的 `release-body`，传入完整 SHA、Chart 路径；Operator 还传入手动指定的 release_tag 并核对它与 Chart 版本一致。
3. 从该提交读取 `changelogs/released/<version>/changelog`，检查非空、Chart version/appVersion、manifest 中的仓库/版本/正文哈希，并拒绝已有版本 tag 指向另一个提交的情况。
4. 把验证后的原文复制为 Chart 根目录的 `RELEASE_NOTES.md`。`helm/.cr/config.yaml` 配置 `release-notes-file: RELEASE_NOTES.md`，Chart Releaser 在创建 Release 时读取包内该文件作为正文。
5. 后续镜像及 hwameictl 使用 Chart 任务输出的 SHA 和版本；上传 CLI 附件保留既有 Release 正文。

GitHub Release 正文与版本日志一致，不包含 PR 中的生成详情，也不在发布时再次调用 AI 或最新模板。临时复制的日志只存在于 CI 工作区和 Chart 包中，不额外提交到仓库。历史 Release 不自动改写。

发布前缺少日志或 manifest、正文哈希不符、版本不符时明确失败。**手动准备发布也要提交匹配的版本日志和 manifest，仅修改 Chart 版本已不满足新流程。** 正常使用 Prepare release 生成并审核这些文件即可；对生成结果进行修改后，应重新生成并审核。

`release-body` 输出 `body-path`、`prerelease`、`make-latest`、`version`、`source-sha`，自身只读取 GitHub：

```bash
node dist/cli.js release-body \
  --repository hwameistor/hwameistor-operator \
  --source-ref <本次发布的完整提交SHA> \
  --chart-path helm/operator/Chart.yaml
```

该接入保留现有 Chart Releaser 和附件上传的重试行为，未增加已有 Release 和附件的完整幂等校验。以下预发布属性和更完整的重试保护仍是独立方案。

## 后续可选：预发布兼容性

2026-10-23 检查到两仓库使用 `helm/chart-releaser-action@v1.3.0`。该版本支持 `release-notes-file`，但没有 `prerelease`、`make-latest` 选项。不能仅加入生成工作流就宣称 alpha/beta 发布流程已完整接通。

后续若改造发布流程，需要满足：

1. 在创建 GitHub Release 时即设置预发布标志，并禁止把预发布标成最新稳定版。
2. 稳定维护分支的新补丁也不能把比它更新的稳定系列挤出 latest。
3. 保留 Chart 包发布、索引更新、CLI 二进制和镜像构建之间的依赖。
4. 发布失败重跑不得重复或覆盖已有发布资产；已有 Release 的处理需要明确检查 tag/提交关系。

核查到 chart-releaser v1.8.1 提供 `make-release-latest`，仍没有 `pre-release`；上游 main 已有后者，但不能把尚未发布的实现当作可用稳定依赖。[publish-chart.py](../examples/publish-chart.py) 是后续发布改造的参考实现，可配合 `cr` 打包和更新索引。本次业务仓库接入 PR 不安装或调用该脚本。

发布伴随脚本在创建时设置预发布标志及 latest，重跑时核对 tag 指向、正文、预发布属性和 Chart 内容，不覆盖不同资产。Helm 打包时间戳可能变化，因此对归档的文件内容、类型、权限和链接进行比较；相同内容保留已经发布的字节，并用这些字节计算索引校验值。后续二进制和镜像任务使用 Chart 任务输出的同一版本和提交，不再用 `git describe` 推测版本。

CLI 二进制使用伴随脚本的 `upload-binary` 命令附加到已经创建的 Release：校验 tag 与构建提交一致，相同字节跳过，不同字节报错。该命令不修改 Release 正文、prerelease 或 latest 属性。

## 重跑与合并保护

- 普通重跑只更新同一个 Release PR；新模板、新模型、新输出覆盖旧生成文件。
- 发布范围在推理前保存到专用生成分支。目标分支前进时停止，用新执行及明确的新截止 SHA 刷新。
- 当刷新范围需要合并新的目标历史时，工具添加新提交并保留原有父提交；若生成分支有生成文件以外的修改则停止。
- 将 Validate release PR 配置为 required check，并要求与目标分支保持最新。仅在 PR 更新时验证不能消除验证完成后目标分支再次前进的时间窗口。
- 工具读取 PR 及 refs 后再次检查发布条件，更新分支不使用 force。来自多个执行器的相同版本任务仍应使用示例 concurrency 串行运行。

## 首次上线顺序

1. 审阅并固定工具版本；先运行离线测试及真实历史采集。
2. 配置推理凭据，运行真实 Copilot 预览并审阅生成质量。
3. 安装两个仓库的 Prepare/Validate 配置与规范，生成草稿 Release PR 验证重跑。
4. 接入 PR 不改 Chart 版本，不触发产品发布。验证日志读取、缺失/篡改阻断和两个实际 Chart 包内的日志内容，真实测试 Release PR 保持草稿。
5. 人工决定实际版本发布；工具不会自动合并、打 tag 或发布镜像。发布阶段如需预发布控制或替换发布器，另行评审。
