cask "ai-video-player" do
  version "0.1.0"
  sha256 "215890daf0b3d48abc5684aa25c3e2a0a94f536516bfa73e1781a5d9675f4632"

  url "https://github.com/13222204208/ai-video-player/releases/download/v#{version}/AIVideoPlayer-#{version}-arm64-mac.zip"
  name "AIVideoPlayer"
  desc "本地 AI 视频播放器：无字幕日语/英语视频实时生成原文 + 中文字幕（完全离线）"
  homepage "https://github.com/13222204208/ai-video-player"

  # Apple Silicon 专用（whisper.cpp 为 arm64 Metal 构建）
  depends_on arch: :arm64
  depends_on macos: ">= :monterey"

  app "AIVideoPlayer.app"

  # 首次启动需要联网下载 Whisper 模型与 Qwen 翻译模型，后续离线可用
  caveats <<~EOS
    首次打开若被 Gatekeeper 拦截，右键点击 App →「打开」。
    首次使用需在应用内点击「下载模型」与「下载翻译模型」（约 4.4GB），之后离线可用。
  EOS

  zap trash: [
    "~/Library/Application Support/AIVideoPlayer",
    "~/Library/Caches/AIVideoPlayer"
  ]
end
