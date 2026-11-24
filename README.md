# OpenSosen Model Fingerprint

OpenSosen 模型指纹是一款 Windows x64 桌面应用。它通过本机已登录的 Codex CLI 向目标模型发送三条数字挑战，用回复中的数字序列与参考库比较，列出相似候选。每次检测使用所选通道的额度。

## 快速使用

从 GitHub Releases 下载 Windows x64 便携版 `.exe`，双击即可打开。首次打开时，请稍候片刻，让程序将内置运行库展开到临时目录。关闭应用后，启动器会清理此次展开的文件。[下载最新版本](https://github.com/opensosen-ai/opensosen-model-fingerprint/releases/latest)
检测前请先在本机安装并登录官方 Windows x64 Codex CLI。应用默认按当前进程的 `PATH` 顺序查找 Codex，并使用第一个找到的 `codex.exe` 或官方 npm 原生程序。

如果本机有多个 Codex 版本，点击“选择 Codex…”选择具体的 `codex.exe`。选择会保存到应用用户目录，之后刷新连接和检测都会使用这个程序；程序路径、版本和通道会显示在界面中。点击“恢复 PATH 自动查找”即可取消固定选择，回到默认行为。检测运行中不能切换程序。

选择路径后，如果程序被移动或删除，应用不会静默改用 PATH 中的另一个版本；请重新选择，或点击“恢复 PATH 自动查找”。

应用支持原生 `codex.exe`，也能通过官方 npm 安装的 `codex.cmd` 定位其原生程序。

应用会保留已有的 `CODEX_HOME` / `CODEX_SQLITE_HOME` 设置；未设置 `CODEX_SQLITE_HOME` 时，会自动从 `%LOCALAPPDATA%\OpenSosen Model Fingerprint\sqlite\` 中为所选 Codex 可执行文件创建并复用独立数据库，Codex 文件更新后会使用新的数据库目录，避免不同版本共用迁移状态。若没设置 `CODEX_HOME`，软件会复用已有的 `%USERPROFILE%\.codex` 登录目录；若设置了显式 `sqlite_home` 配置，则仍按 Codex 自身的优先级使用该配置。首次连接可能需要等待较长时间完成数据库初始化。

## Codex 通道

- 连接检查调用本机 `app-server` 的 `initialize`、`account/read`、`modelProvider/list` 和 `model/list`。账号检查不会发起数字挑战。登录方式来自 Codex 报告，导出只含登录类型。
- ChatGPT 模式为采样子进程显式选择内置 `openai` 和 `https://chatgpt.com/backend-api/codex`。同一个用户可能把 Codex 的默认提供方设为自定义网关，因此界面分别显示默认提供方和该次检测的通道。若内置账号通道无法确认，界面会显示连接错误。
- API Key 模式保留 Codex 报告的 OpenAI API 地址或兼容的自定义 Responses 网关地址。自定义网关采样走 Codex 托管的 API Key。依赖额外 HTTP 头、查询参数或专用认证程序的网关配置可能无法在隔离模式使用。连接和采样结果会显示可确认的路由和错误状态。
- 采样使用 `codex exec --json --ephemeral --ignore-user-config --ignore-rules`。空的 `mcp_servers` 配置会与用户配置合并，所以采样使用 Codex 的忽略用户配置开关。每条挑战在单独的空目录与只读沙箱内运行。用 `codex debug models --bundled` 取得本机模型定义，只对采样进程去除模型附带的指令和工具。模型列表显示能映射到本机内置目录的文本模型。用户输入只有 SDK 生成的数字挑战。
- `exec` 公开事件给出会话、回复和终止状态。导出记录请求模型与配置通道，实际推理模型字段为空。认证和凭据仍由 Codex 自行管理。用户可在官方 Codex 完成登录后点击刷新。
- 桌面端对 Codex 文件存储和系统凭据库使用同一套公开账号检查。采样子进程排除认证环境变量覆盖，避免与本机账号检查报告的登录模式不一致。

## 数字证据

应用使用官方 npm 包 `lmfpd-sdk@0.2.0` 生成挑战、解析最长有效数字段并分析回复。界面保留每轮原始答复和解析数量。SDK 可用少于三个有效样本生成部分排名，部分排名会单独标识。取消、无有效数字或无法比较的结果不生成排名。[lmfpd-sdk](https://www.npmjs.com/package/lmfpd-sdk)

参考库来自 SDK 的默认数据站点或镜像，缓存放在应用的本地数据目录。下载更新时，应用会核对快照时间，并计算数据文件的 SHA-256，与清单中记录的值比对。候选排名仅反映与该参考库的相似程度。

## 构建与测试

在仓库根目录使用 Windows x64 Node.js 22.12 或更新版本执行。

```powershell
npm.cmd ci
node node_modules/electron/install.js
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

默认在 `out/` 中生成带版本号的应用目录。可直接运行目录内的 `OpenSosenModelFingerprint.exe`。要生成发布用的单文件 EXE，请先将 NSIS 3.13 的 `makensis.exe` 加入 PATH，再运行 `npm.cmd run build:portable`。生成的 `out/OpenSosenModelFingerprint-<版本>-win-x64.exe` 包含完整应用、Electron 运行时和第三方许可。

## 致谢

感谢 ModelTrace 及其贡献者对模型检测开源生态的贡献。 [ModelTrace](https://github.com/xqy2006/ModelTrace)
