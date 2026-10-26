# Whaleagent

一个跑在自己电脑上的 B 站阅读助手：替你从关键词、关注动态和首页推荐里找视频，按你的口味挑出值得看的，写成报告；需要时还能替你回复评论和私信、写日记。

Windows x64 便携版，解压即用，不写注册表（除开机启动开关）、不装服务。所有数据——设置、API Key、登录态、报告、日记——都在程序目录下的 `WhaleagentData\` 里，整个文件夹复制走就能带走。

当前版本 **0.14.0**。模型服务用任何兼容 OpenAI `/chat/completions` 的接口，Key 由你自己填。

## 功能

| 页面 | 做什么 |
| --- | --- |
| 报告 | 本地 Markdown 报告的列表、编辑、另存、删除。自动读取生成的报告会自动落盘。 |
| 发现视频 | 扫码登录 B 站后，从关键词 / 关注动态 / 首页推荐取候选；勾选后交给模型筛选并生成报告。 |
| 日记 | 两本日记：给主人看的、给自己看的。可手动补写，也可每天定时自动写，按保留天数自动清理。 |
| 自动化 | 自动读取（时间窗 + 间隔）与互动监听（评论回复 / @ 提醒 / 私信）的全部开关。 |
| 模型设置 | 多模型档案，每个模型独立的地址、Key、温度和视觉能力；首选失败自动改用备用。 |
| 提示词 | 我的人设（称呼、语气）与内容偏好（想看什么）；系统提示词只读展示。 |
| 软件更新 | 从本项目 GitHub 发行版检查、下载、校验并重启安装。全部手动触发。 |
| 开机启动 | 一个滑块，决定登录 Windows 后是否自动打开 Whaleagent。 |
| 窗口与托盘 | 关闭时可选最小化到托盘或直接关闭，可记住选择；双击托盘唤回主界面，右键菜单可显示主界面、退出。 |

几个刻意的设计取舍：

- **代码管硬规则，模型管口味。** 无字幕、标题排除词、发布时间窗、候选条数上限都由代码执行，提示词里不让模型自己判断这些。
- **写操作要主人明说。** 推送视频只发私信，不点赞。只有你在私信里明确要求，才会对「最近推送过的视频」点赞或收藏，且 BV 必须能在本地推送台账里查到。
- **不自动安装更新，不自动联网。** 启动时不检查更新；检查、下载、安装三步都要你点。
- **关闭窗口不等于退出。** 默认询问「最小化到托盘」还是「直接关闭」；选托盘后后台任务继续跑，想彻底退出用托盘右键菜单的「退出」。
- **隐私边界写在代码里。** B 站 Cookie 不发往模型服务，聊天上下文不落盘，诊断日志只记条数与长度，不记正文、昵称和 Key。

## 下载与运行

1. 从 [Releases](https://github.com/chiaki3924/Whaleagent/releases) 下载 `Whaleagent-win32-x64.zip`，解压到**可写目录**（桌面、D 盘都行，不要放 `Program Files`）。
2. 双击 `Whaleagent.exe`。不需要安装 Node.js、Python 或 DeepSeek Harness。
3. 首次启动会在 exe 旁边创建 `WhaleagentData\`。之后升级只替换程序文件，这个文件夹要保留。

SmartScreen 可能提示未知发布者——当前构建没有代码签名。发行版里另有 `whaleagent-update.json`，其中记录了压缩包的大小与 SHA-256，可用来核对下载是否完整。

## 首次使用

1. **模型设置** → 新增模型 → 填 API 地址（到 `/v1` 这一级）、模型名称、API Key → 保存 → 测试连接。
2. **左侧账号区** → 扫码登录 B 站。
3. **提示词** → 填内容偏好和称呼方式（可选，但直接影响筛选质量）。
4. **发现视频** → 获取候选 → 勾选 1–3 条 → AI 筛选并生成报告。

详细步骤见 [USER_GUIDE.md](USER_GUIDE.md)。

## 开发

需要 Node.js 22+ 和 pnpm 11+。

```powershell
pnpm install
pnpm start          # 开发态运行
pnpm test           # 451 项单元测试（node --test）
pnpm pack:win       # 打包到 release/Whaleagent-win32-x64
pnpm pack:release   # 出更新包 + 更新清单
```

项目用 pnpm 的 hoisted node-linker，这样 Electron Packager 能正常解析和裁剪生产依赖。运行期只有 `qrcode` 一个依赖，其余全部是 Node 与 Windows 自带能力（PowerShell、robocopy、tar）。

改代码前请读 [代码说明.md](代码说明.md)，那里有模块职责、IPC 契约和一份踩坑清单——不少坑是实测踩出来的，重复踩一次的代价不低。

## 文档

- [USER_GUIDE.md](USER_GUIDE.md) —— 用户指南：每一页怎么用、数据存在哪、常见问题。
- [交接文档.md](交接文档.md) —— 当前版本的功能与行为约定，按页面组织。
- [代码说明.md](代码说明.md) —— 实现分层、模块职责、IPC、数据结构、踩坑清单。
- [release-notes.md](release-notes.md) —— 本版本发行说明（发版脚本读取）。
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) —— 第三方代码与许可。

## 安全与边界

- 非本机模型地址必须 HTTPS；检查连接时拒绝重定向；凭据不允许写进 URL。
- 渲染层不能直接发网络请求（CSP `connect-src 'none'`），只能调用 `src/preload/index.cjs` 显式暴露的方法。
- 更新包只接受「本项目 + 指定文件名 + 大小与 SHA-256 匹配」的包；更新清单缺失（404）时改用 GitHub API 记录的资产摘要，清单存在但内容不符时仍然直接拒绝。安装脚本只覆盖、不删除，数据目录被排除在复制之外，包内混进 `WhaleagentData` 直接拒绝安装。
- 开机启动只写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Whaleagent` 一个值，不需要管理员权限，关掉开关即删除。
- 诊断日志在 `WhaleagentData\logs\whaleagent.log`，1 MB 轮转，写入前会脱敏 Cookie、Key、Bearer、URL 与 data URL。

应用不是 B 站或任何模型供应商的官方产品。请遵守平台规则，并自行保管好 API Key。

## 许可

MIT，见 [LICENSE](LICENSE)。B 站 WBI 签名表与扫码流程参考了两个 MIT 项目，许可全文见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
