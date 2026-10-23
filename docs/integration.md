# HwameiStor 发布接入

准备阶段增加 Release PR，发布阶段继续使用现有 Chart、二进制、镜像构建流程。生成和发布分开，发布时只使用已经评审过的版本日志。

## 接入位置

| 仓库 | 配置中声明的 Chart | 发布工作流 |
| --- | --- | --- |
| `hwameistor/hwameistor` | `helm/hwameistor/Chart.yaml` | `.github/workflows/release-chart.yaml` |
| `hwameistor/hwameistor-operator` | `helm/operator/Chart.yaml` | `.github/workflows/release-image.yaml` |

两仓库各自安装 Prepare/Validate 工作流、配置、规范和模板。先在默认分支安装 Prepare，目标 release 分支也要有 Validate。X.Y 由维护者保持对应，补丁版本独立，不自动更新另一仓库版本。生成器只更新 Chart 的 `version` 和 `appVersion`，不替换 values 中的依赖/工具镜像 tag。

需要配置 `RELEASE_ASSISTANT_TOKEN` 和 `COPILOT_GITHUB_TOKEN`，或改用兼容端点及 `RELEASE_ASSISTANT_API_KEY`。推荐 App installation token；如使用 PAT，限定目标仓库权限。模型凭据与创建 PR 的凭据分开。

## 合并和发布

Release PR 内容和排除理由评审通过后，人工合并。Chart 变更触发原有发布链路。发布工作流应在开始发布之前读取本次提交对应的版本日志，文件不存在就停止，不能退回默认 Chart 描述或再次调用 AI。

`release-body` 命令读取日志并输出 `body-path`、`prerelease`、`make-latest`、`version`、`source-sha`。它本身不修改 GitHub Release。已有 tag 可以按版本读取，初次发布使用固定提交及 Chart 路径：

```bash
node dist/cli.js release-body \
  --repository hwameistor/hwameistor-operator \
  --source-ref <本次构建的完整提交SHA> \
  --chart-path helm/operator/Chart.yaml
```

初次发布要从本次构建的提交读取 `changelogs/released/<version>/changelog`，并将同一提交用于 tag、Chart、镜像构建；不要使用分支上再次解析得到的较新 HEAD。发布正文不能引用最新模板重新渲染，必须与评审结果一致。

## 预发布兼容性

2026-10-23 检查到两仓库使用 `helm/chart-releaser-action@v1.3.0`。该版本支持 `release-notes-file`，但没有 `prerelease`、`make-latest` 选项。不能仅加入生成工作流就宣称 alpha/beta 发布流程已完整接通。

配套发布流程满足：

1. 在创建 GitHub Release 时即设置预发布标志，并禁止把预发布标成最新稳定版。
2. 稳定维护分支的新补丁也不能把比它更新的稳定系列挤出 latest。
3. 保留 Chart 包发布、索引更新、CLI 二进制和镜像构建之间的依赖。
4. 发布失败重跑不得重复或覆盖已有发布资产；已有 Release 的处理需要明确检查 tag/提交关系。

核查到 chart-releaser v1.8.1 提供 `make-release-latest`，仍没有 `pre-release`；上游 main 已有后者，但不能把尚未发布的实现当作可用稳定依赖。本实现使用 `cr` 打包和更新索引，将创建 Release 和上传 Chart 包交给 [publish-chart.py](../examples/publish-chart.py) 发布伴随脚本。该脚本复制到业务仓库，由原发布工作流在 Release PR 合并之后执行；生成工具不会调用它。

发布伴随脚本在创建时设置预发布标志及 latest，重跑时核对 tag 指向、正文、预发布属性和 Chart 内容，不覆盖不同资产。Helm 打包时间戳可能变化，因此对归档的文件内容、类型、权限和链接进行比较；相同内容保留已经发布的字节，并用这些字节计算索引校验值。后续二进制和镜像任务使用 Chart 任务输出的同一版本和提交，不再用 `git describe` 推测版本。

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
4. 审阅两个业务仓库中的发布伴随脚本及 CI 改造，在专用测试仓库验证真实发布链路。初次接入 PR 不改 Chart 版本，不触发产品发布。
5. 人工决定实际版本发布；工具不会自动合并、打 tag 或发布镜像。
