# 本地 AI 视频播放器（Mac + Windows）

拖入一部没有字幕的日语/英语视频，点击播放，AI 实时识别语音并生成**原文 + 中文字幕**，全程本地运行、不联网上传。

```
用户拖入视频 → 点击播放/生成字幕
      ↓
主进程：FFmpeg 抽取 16kHz 音频 → whisper.cpp 识别（日语/英语原文 + 时间轴）
      ↓
本地 LLM：Qwen2.5-7B（llama.cpp）翻译成中文
      ↓
双语字幕叠加显示，可导出 .srt / .vtt
```

## 📦 下载安装（已打包程序，无需编译）

安装包发布在 GitHub Releases：https://github.com/13222204208/ai-video-player/releases/tag/v0.1.0

- macOS (Apple Silicon)：[AIVideoPlayer-0.1.0-arm64-mac.zip](https://github.com/13222204208/ai-video-player/releases/download/v0.1.0/AIVideoPlayer-0.1.0-arm64-mac.zip)
- Windows (x64)：[AIVideoPlayer.Setup.0.1.0.exe](https://github.com/13222204208/ai-video-player/releases/download/v0.1.0/AIVideoPlayer.Setup.0.1.0.exe)

### macOS（Apple Silicon）

1. 下载 `AIVideoPlayer-0.1.0-arm64-mac.zip`。
2. 双击解压，把 `AIVideoPlayer.app` 拖到「应用程序」文件夹。
3. 首次打开若弹出「**Apple 无法验证 “AIVideoPlayer” 是否包含可能危害 Mac 安全或泄漏隐私的恶意软件**」，请任选其一放行（当前为免费 ad-hoc 签名、未做 Apple 公证，属正常现象）：

   - **方式 A（右键打开）**：在「应用程序」文件夹里**右键点击 App →「打开」→ 弹窗再点「打开」**。
   - **方式 B（系统设置放行）**：若右键没有「打开」按钮（macOS Sequoia 15 及以上常见），按下面操作：
     1. 先尝试打开一次，让它被拦截；
     2. 打开 **系统设置 → 隐私与安全性**；
     3. 在「安全性」一栏找到「AIVideoPlayer 已被阻止使用」的提示，点 **「仍要打开」**，输入密码确认。
   - **方式 C（终端去除隔离属性，最彻底）**：打开「终端」粘贴并回车，直接移除下载时附加的隔离标记：
     ```bash
     xattr -dr com.apple.quarantine /Applications/AIVideoPlayer.app
     ```
     执行后双击即可正常打开（每次重新下载/替换 App 后需再执行一次）。

   通过 Homebrew 安装可自动剥离隔离属性、免去上述步骤（见下文）。
4. 首次使用请在应用内点「下载模型」（Whisper，约 1.6GB）和「下载翻译模型」（Qwen，约 4.4GB），下载一次后完全离线可用。

### Windows（x64）

1. 下载 `AIVideoPlayer.Setup.0.1.0.exe`。
2. 双击运行安装程序，按提示完成安装。
3. 若 Windows SmartScreen 拦截（当前为未签名安装包），点「更多信息 → 仍要运行」。
4. 首次使用请在应用内下载模型（同 macOS）。

### Homebrew（macOS，可选）

已内置 Cask 文件 `homebrew/Casks/ai-video-player.rb`，可自行搭建 tap 仓库分发，详见 [`homebrew/README.md`](homebrew/README.md)。

> 安装程序默认**不内置**识别/翻译模型（体积过大）。首次运行请联网下载一次，之后完全离线。
> 模型存放位置：macOS `~/Library/Application Support/AIVideoPlayer/models`，Windows `%APPDATA%\AIVideoPlayer\models`。
> 若国内下载模型失败，应用会自动走镜像 `hf-mirror.com`。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Electron 33 |
| 界面 | Vue 3 + TypeScript（electron-vite） |
| 播放 & 字幕渲染 | HTML5 `<video>` + 自定义字幕叠加层 |
| 进程通信 | Electron IPC（contextBridge） |
| 音频抽取 / 转码 | FFmpeg（`ffmpeg-static`） |
| 语音识别 | [whisper.cpp](https://github.com/ggerganov/whisper.cpp)：整片用 `whisper-cli`（`-oj` JSON），流式用 `whisper-server`（HTTP `/inference`，模型常驻） |
| 流式 VAD | 自研轻量能量 VAD（纯 JS，`vad.ts`），可按需换成 Silero VAD |
| 翻译 | **Qwen2.5-7B-Instruct**（本地 LLM，[llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server`，OpenAI 兼容接口，上下文感知、口语化） |

## 目录结构

```
src/
├── main/                  # Electron 主进程
│   ├── index.ts           # 窗口创建 + media:// 协议（Range 流式播放）
│   ├── ipc.ts             # IPC handler 注册
│   └── services/
│       ├── paths.ts       # 二进制/模型/临时目录解析
│       ├── ffmpeg.ts      # 抽音频 + 无损转 MP4
│       ├── whisper.ts     # whisper-cli 整片识别 + JSON 解析
│       ├── whisperServer.ts # whisper-server 进程管理（流式逐段）
│       ├── streaming.ts   # 流式：ffmpeg PCM 流 → VAD → 逐段识别
│       ├── vad.ts         # 能量 VAD 分段器（纯 JS）
│       ├── models.ts      # whisper 模型下载/管理
│       ├── subtitle.ts    # SRT / WebVTT 生成
│       └── pipeline.ts    # 整片：抽音频 → 识别 编排
├── preload/               # contextBridge 桥接（window.api）
├── shared/                # 主/渲染进程共享类型与常量
└── renderer/
    ├── index.html
    └── src/
        ├── App.vue            # 编排：拖拽/流水线/翻译/导出
        ├── components/        # DropZone / VideoPlayer / SubtitleOverlay / ControlPanel
        ├── lib/translator.ts  # 翻译 Worker 客户端
        └── worker/translate.worker.ts  # NLLB 翻译 Worker
```

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

> 若 pnpm 提示忽略构建脚本，需放行 `electron`、`ffmpeg-static` 的 install 脚本
> （本项目已在 `package.json` 的 `pnpm.onlyBuiltDependencies` 中配置）。

### 2. 编译 whisper.cpp 二进制（首次必需）

```bash
pnpm run build:whisper
```

- **macOS**：需要 Xcode Command Line Tools + cmake；Apple Silicon 自动启用 Metal GPU。
- **Windows**：需要 Visual Studio Build Tools（C++ 负载）或 MinGW + cmake。
- 产物位于 `resources/bin/<platform>-<arch>/whisper-cli[.exe]`。
- 也可手动编译后把二进制放到该目录，或设置环境变量 `WHISPER_BIN` 指向二进制。

### 3. 下载 Whisper 模型 + 翻译模型（首次必需）

```bash
pnpm run download:model large-v3-turbo   # Whisper 识别模型（约 1.6GB）
pnpm run download:llm                    # Qwen2.5-7B 翻译模型（约 4.4GB）
```

或在启动应用后，界面里分别点「下载模型」「下载翻译模型」。

- Whisper 模型可选：`medium / large-v3-turbo / large-v3`
- 翻译模型：Qwen2.5-7B-Instruct（Q4_K_M 量化）

> 翻译引擎也需要编译 llama.cpp：`pnpm run build:llama`（和 whisper 一样，一次即可）。

### 4. 运行

```bash
pnpm dev
```

### 5. 使用

1. 把视频文件拖入窗口（或点击「选择视频文件」）。
2. 若视频是 MKV/AVI 等容器，点击「无损转 MP4 播放」（FFmpeg copy 流，很快）。
3. 选择「识别模式」——**流式实时**（默认，边识别边出字幕）或 **整片批量**（先整段识别再显示）。
4. 选择 Whisper 模型与原声语言（自动检测 / 日语 / 英语），点击「开始实时识别」/「生成字幕」。
5. 首次翻译会下载 Qwen2.5-7B 翻译模型（约 4.4GB），之后离线可用。
6. 识别完成后双语字幕随播放显示；点击「导出字幕」在同目录生成 `.zh.srt` / `.zh.vtt`。

## 打包分发

```bash
pnpm run build:mac         # macOS dmg（需开发者证书才会签名；无证书则跳过）
pnpm run build:mac:adhoc   # macOS .app + ad-hoc 签名（免费，本机可用）
pnpm run build:win         # Windows nsis
```

### Windows 安装包

Windows 版依赖 Windows 原生编译的 whisper.cpp / llama.cpp 二进制，**必须在 Windows 环境（或 CI）里构建**，不能跨平台交叉编译。

**方式一：GitHub Actions（推荐，最省事）**

已内置 [`.github/workflows/build.yml`](.github/workflows/build.yml)。把代码推到 GitHub 后：

1. GitHub 仓库 → Actions 标签页。
2. 手动点「Run workflow」（或推一个 `v*` 标签）。
3. 等几分钟，Windows 的 `.exe` 安装包和 macOS 的 `.dmg` 会作为 Artifact 下载。

**方式二：本地 Windows 机器**

前置：Git、Node 20+、pnpm 10、[Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（C++ 桌面开发负载）或 MinGW、CMake。

```powershell
.\scripts\build-win.ps1   # 一条命令：装依赖 → 编译 whisper/llama → 出 NSIS 安装包
```

产物在 `dist/*.exe`。

**方式三：macOS 上交叉编译（llvm-mingw）**

在 macOS 上下载 llvm-mingw 后用交叉编译产出 Windows 二进制（CPU 版，无 GPU 加速），再 `electron-builder --win --x64`：

```bash
curl -L -o .cache/llvm-mingw.tar.xz https://github.com/mstorsjo/llvm-mingw/releases/download/20260826/llvm-mingw-20260826-ucrt-macos-universal.tar.xz
node scripts/build-win-cross.mjs   # 交叉编译 whisper.cpp + llama.cpp
```

> 注：交叉编译为 CPU 版；要 GPU 加速（CUDA）仍需 Windows 原生编译。

### 签名与分发（免费方案）

- **ad-hoc 签名（免费）**：`pnpm run build:mac:adhoc` 会生成 `.app` 并用 `codesign --deep --sign -` 正确密封（正确 bundle id + 密封资源）。本机可正常使用。
- **分发给他人（免费）**：见 [`homebrew/README.md`](homebrew/README.md)，走 Homebrew Cask，`brew` 自动处理隔离属性，用户无警告安装。
- **双击即用、零警告**：需 $99/年的 Apple Developer Program（Developer ID + 公证），这是唯一官方信任来源，无免费替代。

注意事项：

- 打包前需先执行 `pnpm run build:whisper`，把目标平台的二进制放入 `resources/bin/<platform>-<arch>/`（`electron-builder` 会随 `extraResources` 打包）。
- `ffmpeg-static` 的二进制按当前安装平台下载，**跨平台打包需在对应平台（或 CI）各跑一次依赖安装**，或改为手动放置 ffmpeg 二进制。
- whisper 模型与 Qwen 翻译模型体积较大，默认不打包进安装包；用户首次运行按需下载，或自行预置到 `resources/models/`。

## 已知限制 / 后续方向

- 流式识别采用「ffmpeg 持续解码 + 能量 VAD 分段 + whisper-server 逐段」，边识别边出字幕（近实时）。能量 VAD 对背景音乐/噪声的鲁棒性一般，可换成 Silero VAD（`vad.ts` 接口保持不变）。
- Chromium 内核原生仅支持 MP4/WebM/MOV 等容器；MKV/AVI 走「无损转 MP4」。若源视频是 HEVC/10bit 等浏览器不支持的编码，需转码（可扩展 FFmpeg 重编码流程）。
- NLLB 翻译为通用模型，对口语/动漫台词偶有直译；可替换为更强的本地模型或在线 API（架构上翻译层已隔离，改 `translate.worker.ts` 即可）。
- 可增强：字幕样式（ASS）、断句优化、Windows CUDA 加速、Silero VAD、字幕编辑器。

## 常见问题

- **提示找不到 whisper 二进制**：先运行 `pnpm run build:whisper`。
- **提示模型未下载**：运行 `pnpm run download:model medium` 或在界面点击「下载模型」。
- **下载模型报 `fetch failed`**：国内访问 huggingface.co 经常超时，本项目已默认走镜像 `hf-mirror.com`（路径与官方一致），并自动回退官方站；也可自行设置 `HF_ENDPOINT=https://hf-mirror.com`。
- **翻译模型首次加载慢**：NLLB 首次从 HuggingFace 下载（已走镜像），之后缓存到本地，离线可用。
- **ONNX WASM 需要联网**：当前 `onnxruntime-web` 的 `.wasm` 默认从 CDN 加载；如需完全离线，请把 `node_modules/onnxruntime-web/dist/*.wasm` 复制到本地并通过 `env.backends.onnx.wasm.wasmPaths` 指定（见 `translate.worker.ts`）。
