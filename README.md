# dsh-screen

[![test](https://github.com/zhanghao-lumen/dsh-screen/actions/workflows/test.yml/badge.svg)](https://github.com/zhanghao-lumen/dsh-screen/actions/workflows/test.yml)

> 给 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 的学习辅助插件：**看得见你的屏幕，记得住刚才讲了什么，还能听懂你说话。**

一个插件，换来输入框旁边的两个开关：**学习模式**和**语音**。

- **学习模式**：后台持续采样整屏，只在画面有变化时把最新一帧交给你的模型，让它用一两句话记下「在讲什么、进行到哪」。
- **语音**：点一下说话，本地转写后发出去；回答自动朗读。

它不改变 DSH 的对话，只是往对话里补上「此刻屏幕上是什么」这一层信息。

---

## 它解决什么

看网课、看 PPT、看别人写代码的时候，最费劲的是「刚才那页讲了什么」——你要一边看一边记，还得回头翻。

这个插件做的事很窄：**把屏幕当成对话的一部分。** 你不用描述自己在看什么，模型自己看。

| 你的困境 | 插件怎么接 |
| --- | --- |
| 屏幕上一直在变，不想每次都截图粘贴 | 后台 1.2 秒采样一次，画面变了才按 30 秒节奏把最新一帧交给模型 |
| 「刚才那页讲的什么来着」 | `study_notes` 翻最近 10 分钟的观察笔记；`screen_shot` 看当下这一帧 |
| 打字打断听课 | 语音按钮：说一句，转成文字发出去，顺带带上当时的画面 |
| 聊久了上下文爆掉 | 笔记只留 10 分钟，自动注入只带「上次之后新增的」，图片交给 DSH 自带的压缩 |

## 工作方式

```
屏幕 ──1.2s──> screencapture ──> 960 宽缓存帧 + 16px 缩略图
                                      │
                                 像素差 < 2.2 ──> 不动，什么都不发（省 token）
                                      │ 有变化
                                      v
                    每 30 秒注入一次：新笔记（≤3 条）+ 一帧图
                                      │
                                      v
                          模型回一两句话 ──> 存进滚动笔记（10 分钟窗口）
```

三个关键设计：

1. **变化驱动，不是定时驱动。** 画面不动就不发请求，静止时插件零成本。连续两次「没有实质变化」后间隔按 1.5 倍放慢（上限 5 分钟），一有变化立刻恢复，另有 5 分钟心跳兜底。
2. **笔记是滚动窗口。** 只保留最近 10 分钟（上限 40 条 / 2400 字），超出的从头部丢弃。
3. **注入只带增量。** 每次注入附上的是「自上次观察以来的新笔记（最多 3 条）」，不是重发整段摘要——这是插件最大的一处省 token 的改动。

## 安装

要求：**macOS**（依赖 `screencapture` / `sips` / `say`）、**Node.js ≥ 22**、**DSH ≥ 0.1.7**。

### 方式一：应用内安装（推荐）

1. 打开 DSH 桌面端 → **插件管理** → **本地目录**
2. 选择本仓库的绝对路径（例如 `~/code/dsh-screen`）
3. 重启应用或刷新页面

> 桌面端 profile 由 Electron 独占，`dsh plugin --profile desktop` 会被拒绝，只能用这个入口安装。

### 方式二：profile 补丁

在 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 数组里加上包名：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-screen"]
    }
  }
}
```

并把本包放进该 profile 的 `node_modules/dsh-screen`（或 `npm link`）。重启后生效。

### 方式三：本地开发直连源码

```bash
# 独立 home，不碰你的 ~/.dsh
export DSH_HOME=$PWD/.dsh-verify
dsh --patch $PWD/dev/cordis.patch.yml --profile web --no-open --port 64991
curl http://127.0.0.1:64991/dsh-screen-api/state
```

注意：这种方式只有宿主半生效，输入栏按钮（客户端半）需要包被装进 profile 才会被扫描到。

## 使用

### 输入栏的两个按钮

| 按钮 | 行为 |
| --- | --- |
| **学习模式 · 开/关** | 开启后模型按节奏自动观察；鼠标悬停显示上次刷新时间与累计变化次数 |
| **语音** | 点一下开始录音，再点一下结束并发送；录音时显示秒数 |

### 六个工具（模型按需调用）

| 工具 | 用途 |
| --- | --- |
| `screen_shot` | 现在看一眼屏幕。学习模式开着时直接返回 3 秒内的缓存帧，几乎零延迟 |
| `screen_watch` | 连拍 1–15 秒的若干帧（最多 8 帧），用来看一段连续操作；**未开启学习模式时会拒绝** |
| `screen_status` | 开关、节奏、绑定的会话、上次抓取时间、错误 |
| `study_notes` | 取最近 10 分钟的观察笔记（`limit` 可调） |
| `camera_shot` | 用摄像头拍一张照片给模型看：看题、看手上的东西、看白板 |
| `camera_watch` | 连拍 1–10 秒（最多 8 帧），只把变化最大的几帧交给模型，用来看动作 |

### 命令

```
/study on       开启自动观察
/study off      关闭
/study notes    看最近 10 分钟笔记
/study status   看状态（默认）
/study status   还会显示今日用量：观察次数 / 图片张数 / 估算 token
/study stats    只看今日用量（最近 7 天的日均也能看到）
/study doctor   自检：抓一帧 + 检查模型能否看图 + 真发一帧让模型描述

/voice on       开始录音（再说一次结束并发送）
/voice off      取消本次录音
/voice tts on   开启朗读
/voice tts off  关闭朗读
/voice status   语音状态
/voice doctor   自检：录音器/模型/输入音量/设备 + 录 1 秒测电平与转写

/camera         用摄像头拍一张，发给当前对话
/camera doctor  自检：列出摄像头 + 拍一帧 + 报告尺寸，用来确认权限
```

### 装完先跑一次自检

两个 doctor 命令解决「装好了但不知道通不通」：

```
/study doctor
```

会依次报告：抓屏尺寸与体积、当前模型是否支持图片输入，然后把这一帧真的发给模型，让它用一句话描述看到了什么。

- 说得出你屏幕上的窗口 → 抓屏与图片链路都通。
- 只说「只看到壁纸」 → 系统给它开了屏幕录制权限，但内容区没抓到（或 TCC 没生效，重启应用再试）。

```
/voice doctor
```

会报告：录音器/转写引擎/模型是否就位、系统输入音量、默认输入设备，然后录 1 秒做电平测试；有声音就顺带转写一句给你看。

### 多会话

学习模式只绑定**开启时所在的那个会话**：切到别的对话再开一次会重新绑定并清空旧笔记。绑定会话被关掉后，自动观察会跳过（日志里是 `bound-session-missing`），**不会**把某个对话的屏幕塞进另一个对话。

### HTTP 接口

按钮与命令写的是同一份状态，你也可以直接打 HTTP：

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/dsh-screen-api/state` | GET | 读状态 |
| `/dsh-screen-api/state` | POST | `{"enabled": true}` 开关学习模式 |
| `/dsh-screen-api/voice/state` | GET | 录音、服务就绪、朗读开关 |
| `/dsh-screen-api/voice/start` | POST | 开始录音 |
| `/dsh-screen-api/voice/stop` | POST | 结束录音、转写并发送 |
| `/dsh-screen-api/voice/tts` | POST | `{"enabled": true}` 开关朗读 |

## 上下文成本

一次自动注入 ≈ **2–2.5k token**：图 800–1400 + 说明 200 + 新增笔记 ≤100。

- **静止画面 = 0**：本地像素差去重挡住整块。
- **一直在变（视频 / 滚动文档）= 30 秒一次 = 120 次/小时 ≈ 25–30 万 token**。
- 笔记摘要改为差分后，相比每次重发 900 字（120 次/小时约 10 万 token）省掉约 **9.6 万 token/小时**。

觉得贵时，优先调整三处：注入节奏（`/dsh-screen-api/state` 的 `intervalMs`）、`DEFAULT_SCALE`（注入图宽度）、`DIFF_THRESHOLD`（多小的变化算变化）。

### 摄像头

摄像头是**显式动作**，不参与自动循环——相机指示灯亮起的每一秒都该是你要求的。

- 拍一张：`camera_shot` 或 `/camera`，约 0.6–1.5 秒（含相机启动与自动曝光稳定）。
- 看动作：`camera_watch`，拍 1–10 秒，帧间差分在 Swift 里算好，只有变化最大的几帧交给模型。
- 帧间差分为 0 附近说明画面静止；数值越大动作越剧烈。

第一次使用会弹摄像头授权。如果 `camera_shot` 报「摄像头权限被拒绝」，去
**系统设置 → 隐私与安全性 → 摄像头** 里允许宿主应用（DSH.app）后重试；`/camera doctor` 会把设备、权限和拍摄结果都列出来。

### 我到底花了多少

`/study status` 最后两行就是当天的账：

```
今日（2026-11-08）：自动观察 5 次 · 图片 12 张（按需 3 张）· ≈2.8k token
最近 3 天：11-05 12.4k · 11-06 0.6k · 11-07 8.9k
```

估算口径写在代码里：滚图片按 `宽×高/800`，文字按 `字符/1.6`。**它是估算，不是账单**——但你用它判断「开一天学习模式值不值」足够了。数据存在 `$DSH_HOME/dsh-screen-stats.json`，只留 14 天，不上传。

### 装进桌面应用（桌面 profile 被应用独占时）

Electron 应用独占 `desktop` profile，`dsh plugin --profile desktop` 会被拒绝。仓库里带了脚本，效果等同在应用内「插件管理 → 本地目录」装一次：

```bash
scripts/install-local.sh desktop   # 复制文件 + 把 dsh-screen 加进 dsh.profile.bundles
```

然后**重启应用**（bundle 列表在启动时读取）。脚本会先把 `package.json` 备份成 `package.json.bak-<时间戳>`。

> 注意：之后如果在应用里安装别的插件，pnpm 可能把不在依赖里的目录清掉；重新跑一次脚本即可。

## 笔记存在哪

笔记有两层，职责不同：

| | 位置 | 保留 | 用途 |
|---|---|---|---|
| 工作记忆 | 内存 `runtime.notes` | 最近 **10 分钟**、≤40 条、≤2400 字 | 每次自动观察时作为「自上次以来的新笔记」注入（最多 3 条） |
| 归档 | `~/.dsh/screen-notes/YYYY-MM-DD.jsonl` | **7 天**，按天分文件 | 回顾「这周在学什么」，不参与注入 |

归档的考虑：

- 不放在 `~/Documents`——那里可能同步到 iCloud，而笔记里可能出现密码、私信、未发布文档
- 目录 `0700`、文件 `0600`，只给当前用户读
- 一天一个文件，清理就是删文件；启动时顺手删掉 7 天前的
- 换会话或重启会清空**工作记忆**，但归档仍在

查看：

```text
/study notes            最近 10 分钟（内存）
/study notes --today    今天的归档
/study notes --days 3   最近 3 天
```

## 菜单栏小程序

不想开页面也能开关学习模式：`native/menubar.swift` 是一个常驻菜单栏的状态入口。

```bash
scripts/install-menubar.sh    # 编译 → 打包成 ~/Applications/DSH Screen.app → 注册登录自启
```

它显示：

- 图标旁的状态点（● 已开启 / ○ 未开启），点击展开菜单
- 菜单里能看到「每 N 秒观察 · 画面 X 秒前 · 笔记 N 条 · 变化 N 次」
- 一键开关、打开 DeepSeek Harness、在浏览器打开控制台
- 全局快捷键 **⌥⌘D**：不点图标也能开关（菜单栏图标被折叠时用它）

它怎么找到宿主：先读插件启动时写的 `~/.dsh/dsh-screen.api.json`（含端口），读不到就用
`lsof` 找 DeepSeek Harness 监听的端口，逐个试探 `/dsh-screen-api/state`。所以应用端口随机也不要紧。

> macOS 26 的菜单栏会折叠放不下的状态项（左侧的「»/«」箭头）。图标没出现时点一下箭头展开，
> 或者按住 ⌘ 把它拖到箭头右侧固定住。

## 权限与隐私

- **抓的是整屏**，包括通知、聊天窗口、密码框。开启前想清楚屏幕上会出现什么。
- 画面经 DSH 附件库保存（`ctx.attachments.saveImages`），和普通附件一样留在会话里；**关掉学习模式不会删掉已经抓过的图**。
- 关闭状态下 `screen_watch` 立即失效；`screen_shot` 仍然可以用，但需要你在对话里明确要求。
- macOS 需要「屏幕与系统音频录制」权限。没授权时 `screencapture` **不会报错**，只会返回一张只有壁纸的图——第一次务必让模型真的「看一眼」确认。
- 语音转写完全在本地（`native/bin/whisper-server`），**音频不出机器**；识别出的文字会作为一条普通消息进入对话。
- 朗读用系统 `say`，内容不出机器。
- 摄像头只在 `camera_shot` / `camera_watch` / `/camera` 被调用时打开，拍完立刻停止会话；连续帧最多 10 秒。
- 权限按**进程**授予：屏幕录制与麦克风属于宿主应用（DSH.app），不是插件自己能申请的。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_SCREEN_WHISPER_MODEL` | `$DSH_HOME/dsh-screen/models/ggml-base.bin` | 换成别的 whisper 模型（`.bin`） |
| `DSH_SCREEN_NO_SAMPLER` | 未设置 | 设为 `1` 关闭后台采样（测试用） |
| `DSH_HOME` | `~/.dsh` | 状态文件与模型缓存的位置 |

状态文件：`$DSH_HOME/dsh-screen.state.json`（只存 `enabled` 与 `intervalMs`）。

模型获取顺序：环境变量 → `$DSH_HOME/dsh-screen/models/` → 包内 `vendor/models/` → 从 hf-mirror 下载。

主要节奏参数（`lib/index.js` 顶部）：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `SAMPLE_MS` | 1200 | 后台采样间隔 |
| `DIFF_THRESHOLD` | 2.2 | 缩略图平均像素差阈值 |
| `CACHE_FRESH_MS` | 3000 | 缓存帧被认为「新鲜」的时长 |
| `AUTO_DEFAULT_MS` | 30000 | 自动注入基准间隔 |
| `HEARTBEAT_MS` | 300000 | 静止时的兜底心跳 |
| `NOTES_WINDOW_MS` | 600000 | 笔记窗口（10 分钟） |
| `VOICE_MAX_SECONDS` | 45 | 单次录音上限 |

## 已知限制

- **模型看到的是离散帧，不是视频流。** 这里的「实时」= 30 秒一次的快照 + 变化驱动，不是逐帧直播。
- **只在 macOS 上验证过。** 抓屏与录音都依赖 macOS 原生命令与框架。
- **没有 TCC 授权时抓屏「成功但无用」**：返回的是壁纸，不是报错。
- **语音端到端尚未在真实会话里验证**：本机测试时麦克风收到的音频近乎静音（系统输入音量 15/100），转写链路本身已验证（0.07–0.7 秒/次）。先跑 `/voice doctor` 能看到卡在哪一步。
- **朗读只验证了开关逻辑**，真实回合里没有完整听过。
- **自动注入只在 agent 空闲时投递**，模型正在回答时会跳过这一轮，不打断对话。

## 从源码开发

```bash
# 语法检查
npm run check

# 桩测试（不依赖真实 DSH）
npm test
```

测试覆盖：工具/命令注册、`tick` 注入与 assistant 回复回捞、摘要差分、`<no-change>` 退避、agent 忙碌跳过、采样与像素差、HTTP 全状态码、录音静音守护、客户端模块协议与 slot 注册。

原生依赖（whisper-server + 录音器）重新编译：

```bash
./native/build.sh
```

需要 `cmake` 与 Xcode Command Line Tools。脚本会把 `vendor/` 与模型下载到本地（两者都在 `.gitignore` 里，不进仓库）。

## 目录结构

```
lib/index.js       宿主半：采样、注入、笔记、工具、命令、HTTP、语音转写与朗读
lib/client.js      客户端半：输入栏两个按钮（普通脚本，走 window.__ModuleLoader__）
native/rec.swift   录音器（AVAudioEngine → 16kHz 单声道 WAV）
native/build.sh    构建 whisper-server 与 rec
native/bin/        预编译二进制（macOS arm64）
cordis.patch.yml   插件在 cordis 树里的插入点
test/              桩测试（`test:ci` 用固定帧，CI 里不需要屏幕权限）
test/fixtures/     CI 用的固定帧
.github/           GitHub Actions：语法检查 + 单元测试
dev/               直连源码调试用的 patch
```

## License

MIT
