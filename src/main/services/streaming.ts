import { spawn } from 'node:child_process'
import type { StreamProgress, SubtitleSegment } from '@shared/types'
import { resolveFfmpeg } from './ffmpeg'
import { ensureVadModel, modelExists, whisperModelFile } from './models'
import { WhisperServer } from './whisperServer'

/** 窗口时长（秒）：每窗口送给 whisper-server，由其内置 Silero VAD 做精确分段 */
const WINDOW_SEC = 15
/** 步进（秒）：窗口间保留 3 秒重叠，跨窗口句子在下一窗口完整识别 */
const STRIDE_SEC = 12

export interface StreamingCallbacks {
  onSegment: (segment: SubtitleSegment) => void
  onProgress: (p: StreamProgress) => void
  onLog: (line: string) => void
}

let cancelled = false

export function cancelStreaming(): void {
  cancelled = true
}

/** s16le 字节 -> Float32（-1..1），处理可能的字节对齐问题 */
function s16ToFloat32(chunk: Buffer): Float32Array {
  const n = Math.floor(chunk.length / 2)
  const copy = Buffer.allocUnsafe(n * 2)
  chunk.copy(copy, 0, 0, n * 2)
  const int16 = new Int16Array(copy.buffer, copy.byteOffset, n)
  const f32 = new Float32Array(n)
  for (let i = 0; i < n; i++) f32[i] = int16[i] / 32768
  return f32
}

/** Float32 采样 -> 16-bit PCM WAV buffer（whisper-server 输入） */
function float32ToWav(samples: Float32Array, sampleRate = 16000): Buffer {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    data.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/**
 * 流式识别：ffmpeg 持续解码音频 → 固定窗口 → whisper-server 内置 Silero VAD 精确分段。
 * Silero VAD 能区分人声与背景音乐，显著优于纯能量 VAD，减少漏识别。
 */
export async function startStreaming(
  videoPath: string,
  options: { model: string; language: string },
  cb: StreamingCallbacks
): Promise<{ detectedLanguage: string; segmentCount: number }> {
  cancelled = false
  const modelName = options.model ?? 'large-v3-turbo'
  if (!modelExists(modelName)) {
    throw new Error(`模型 ggml-${modelName}.bin 尚未下载。请先在界面点击「下载模型」。`)
  }
  const modelPath = whisperModelFile(modelName)
  const language = options.language === 'auto' ? 'auto' : options.language

  const server = new WhisperServer()
  let ffmpegProc: ReturnType<typeof spawn> | null = null

  let index = 0
  let detectedLanguage = ''
  let segmentCount = 0
  let durationSec = 0
  let lastPercent = 0

  const emitProgress = (percent: number, message = '实时识别中'): void => {
    lastPercent = percent
    cb.onProgress({
      status: 'listening',
      message,
      percent,
      segmentCount,
      detectedLanguage: detectedLanguage || undefined
    })
  }

  try {
    // 1. 确保 Silero VAD 模型（~864KB）
    cb.onProgress({ status: 'starting', message: '准备 VAD 模型', percent: 0 })
    const vadModel = await ensureVadModel()
    if (cancelled) throw new Error('已取消')

    // 2. 启动 whisper-server（带 Silero VAD）
    cb.onProgress({ status: 'starting', message: '正在加载语音模型', percent: 0 })
    await server.start(modelPath, {
      vad: true,
      vadModel,
      onLog: (l) => cb.onLog(l)
    })
    if (cancelled) throw new Error('已取消')

    // 3. 启动 ffmpeg PCM 流
    cb.onProgress({ status: 'listening', message: '实时识别中', percent: 0 })
    ffmpegProc = spawn(resolveFfmpeg(), [
      '-hide_banner',
      '-i',
      videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      's16le',
      'pipe:1'
    ])

    ffmpegProc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString()
      cb.onLog(text)
      const dm = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(text)
      if (dm && durationSec === 0) {
        durationSec = +dm[1] * 3600 + +dm[2] * 60 + +dm[3]
      }
      const tm = /time=\s*(\d+):(\d+):(\d+\.?\d*)/.exec(text)
      if (tm && durationSec > 0) {
        const cur = +tm[1] * 3600 + +tm[2] * 60 + +tm[3]
        emitProgress(Math.min(99, Math.round((cur / durationSec) * 100)))
      }
    })

    let ffmpegError = ''
    ffmpegProc.on('error', (err) => {
      ffmpegError = err.message
    })

    // 4. 固定窗口 + Silero VAD
    let windowBuffer = new Float32Array(0)
    let windowStartSample = 0

    const transcribeWindow = async (samples: Float32Array, startSample: number): Promise<void> => {
      const wav = float32ToWav(samples)
      const result = await server.transcribe(wav, language)
      if (result.language && !detectedLanguage) {
        detectedLanguage = result.language
        emitProgress(lastPercent)
      }
      const baseSec = startSample / 16000
      for (const s of result.segments) {
        if (!s.text) continue
        const absEnd = baseSec + s.end
        // 只跳过窗口最末尾（可能被截断）的片段，交给下一窗口完整识别
        if (absEnd > baseSec + WINDOW_SEC - 0.5) continue
        cb.onSegment({
          index: index++,
          start: baseSec + s.start,
          end: absEnd,
          text: s.text
        })
        segmentCount++
      }
    }

    if (ffmpegProc.stdout) {
      const windowSamples = WINDOW_SEC * 16000
      const strideSamples = STRIDE_SEC * 16000
      for await (const chunk of ffmpegProc.stdout) {
        if (cancelled) break
        const f32 = s16ToFloat32(chunk as Buffer)

        const merged = new Float32Array(windowBuffer.length + f32.length)
        merged.set(windowBuffer, 0)
        merged.set(f32, windowBuffer.length)
        windowBuffer = merged

        while (!cancelled && windowBuffer.length >= windowSamples) {
          const window = windowBuffer.subarray(0, windowSamples)
          await transcribeWindow(window, windowStartSample)
          windowBuffer = windowBuffer.subarray(strideSamples)
          windowStartSample += strideSamples
        }
      }
    }

    // 5. 处理最后一个不满窗口的片段
    if (!cancelled && windowBuffer.length > 0) {
      await transcribeWindow(windowBuffer, windowStartSample)
    }

    if (ffmpegError && !cancelled) {
      throw new Error(`ffmpeg 音频流错误：${ffmpegError}`)
    }
    if (cancelled) throw new Error('已取消')

    cb.onProgress({
      status: 'done',
      message: '识别完成',
      percent: 100,
      segmentCount,
      detectedLanguage
    })
    return { detectedLanguage, segmentCount }
  } finally {
    ffmpegProc?.kill()
    server.stop()
  }
}
