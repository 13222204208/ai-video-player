import { join } from 'node:path'
import type { PipelineProgress, RunPipelineOptions, TranscribeResult } from '@shared/types'
import { extractAudio } from './ffmpeg'
import { transcribe } from './whisper'
import { modelExists, whisperModelFile } from './models'
import { getTempDir } from './paths'

let cancelled = false

export function cancelPipeline(): void {
  cancelled = true
}

/** 解析 ffmpeg stderr 里的 `time=HH:MM:SS` 与 `Duration:` 用于估算进度 */
function createFfmpegProgress(onProgress: (p: PipelineProgress) => void) {
  let durationSec = 0
  return (data: string): void => {
    const dm = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(data)
    if (dm && durationSec === 0) {
      durationSec = +dm[1] * 3600 + +dm[2] * 60 + +dm[3]
    }
    const tm = /time=\s*(\d+):(\d+):(\d+\.?\d*)/.exec(data)
    if (tm && durationSec > 0) {
      const cur = +tm[1] * 3600 + +tm[2] * 60 + +tm[3]
      onProgress({
        stage: 'extract',
        message: '抽取音频中',
        percent: Math.min(100, Math.round((cur / durationSec) * 100))
      })
    }
  }
}

/**
 * 主进程流水线：抽取音频 -> whisper.cpp 识别。
 * 翻译在渲染进程的 Web Worker 中完成（NLLB / onnxruntime-web）。
 */
export async function runPipeline(
  videoPath: string,
  options: RunPipelineOptions,
  onProgress: (p: PipelineProgress) => void
): Promise<TranscribeResult> {
  cancelled = false
  const modelName = options.model ?? 'small'

  if (!modelExists(modelName)) {
    throw new Error(
      `模型 ggml-${modelName}.bin 尚未下载。请先在界面中点击「下载模型」，或运行 pnpm run download:model。`
    )
  }

  const wavPath = join(getTempDir(), `audio-${Date.now()}.wav`)

  // 1. 抽取音频
  onProgress({ stage: 'extract', message: '正在抽取音频', percent: 0 })
  const ffmpegProgress = createFfmpegProgress(onProgress)
  await extractAudio(videoPath, wavPath, ({ data }) => ffmpegProgress(data))
  if (cancelled) throw new Error('已取消')

  // 2. 识别
  onProgress({ stage: 'transcribe', message: '正在识别语音（Whisper）', percent: 0 })
  const { segments, detectedLanguage } = await transcribe(wavPath, whisperModelFile(modelName), {
    language: options.language === 'auto' ? 'auto' : options.language,
    onProgress: (percent) =>
      onProgress({ stage: 'transcribe', message: '正在识别语音（Whisper）', percent })
  })
  if (cancelled) throw new Error('已取消')

  onProgress({ stage: 'done', message: '识别完成', percent: 100, detectedLanguage })
  return { segments, detectedLanguage }
}
