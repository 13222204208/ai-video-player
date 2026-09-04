import { createWriteStream, existsSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { ModelProgress, WhisperModelInfo } from '@shared/types'
import { WHISPER_MODELS } from '@shared/types'
import { getModelsDir } from './paths'

/**
 * HuggingFace 端点列表（优先国内镜像，失败自动回退官方站）。
 * 可通过环境变量 HF_ENDPOINT / HF_MIRROR 自定义，如：
 *   HF_ENDPOINT=https://hf-mirror.com pnpm dev
 */
function hfEndpoints(): string[] {
  const custom = (process.env.HF_ENDPOINT ?? process.env.HF_MIRROR ?? '').trim()
  if (custom) return [custom.replace(/\/+$/, '')]
  return ['https://hf-mirror.com', 'https://huggingface.co']
}

function modelUrl(base: string, name: string): string {
  return `${base}/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`
}

const VAD_MODEL_FILE = 'ggml-silero-v6.2.0.bin'
const LLM_MODEL_FILE = 'Qwen2.5-7B-Instruct-Q4_K_M.gguf'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function vadModelFile(): string {
  return join(getModelsDir(), VAD_MODEL_FILE)
}

export function vadModelExists(): boolean {
  return existsSync(vadModelFile())
}

/** 确保 Silero VAD 模型已下载（约 864KB），失败自动回退官方站 */
export async function ensureVadModel(): Promise<string> {
  const dest = vadModelFile()
  if (existsSync(dest)) return dest
  for (const base of hfEndpoints()) {
    try {
      const url = `${base}/ggml-org/whisper-vad/resolve/main/${VAD_MODEL_FILE}`
      const res = await fetch(url)
      if (res.ok) {
        writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
        return dest
      }
    } catch {
      /* 尝试下一个源 */
    }
  }
  throw new Error('Silero VAD 模型下载失败，请检查网络或设置 HF_ENDPOINT 镜像')
}

export function whisperModelFile(name: string): string {
  return join(getModelsDir(), `ggml-${name}.bin`)
}

export function modelExists(name: string): boolean {
  return existsSync(whisperModelFile(name))
}

/** 列出可选模型及本地安装状态 */
export function listModels(): WhisperModelInfo[] {
  return WHISPER_MODELS.map((m) => ({
    name: m.name,
    label: m.label,
    sizeMb: m.sizeMb,
    installed: modelExists(m.name)
  }))
}

export function llmModelFile(): string {
  return join(getModelsDir(), LLM_MODEL_FILE)
}

export function llmModelExists(): boolean {
  return existsSync(llmModelFile())
}

/** 流式写文件（支持追加续传），实时回传进度 */
async function streamToFile(
  res: Response,
  sink: ReturnType<typeof createWriteStream>,
  received: number,
  total: number,
  name: string,
  onProgress?: (p: ModelProgress) => void
): Promise<void> {
  const reader = (res.body as WebReadableStream<Uint8Array>).getReader()
  await new Promise<void>((resolve, reject) => {
    const pump = async (): Promise<void> => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.byteLength
          if (!sink.write(Buffer.from(value))) {
            await new Promise<void>((r) => sink.once('drain', () => r()))
          }
          if (total > 0) {
            onProgress?.({
              name,
              percent: Math.min(100, Math.round((received / total) * 100)),
              message: `${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`
            })
          }
        }
        sink.end()
        resolve()
      } catch (err) {
        sink.destroy()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    sink.on('error', reject)
    sink.on('finish', () => resolve())
    void pump()
  })
}

/**
 * 带断点续传 + 自动重试的下载：
 * - 下载到 .part，中断后下次从已下载的字节继续（HTTP Range）。
 * - 网络抖动时自动重试（最多 8 次），不会因一次断线而前功尽弃。
 */
async function downloadFileResumable(
  url: string,
  dest: string,
  name: string,
  onProgress?: (p: ModelProgress) => void
): Promise<void> {
  const tmp = dest + '.part'
  const maxAttempts = 8

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const existingSize = existsSync(tmp) ? statSync(tmp).size : 0
    const headers: Record<string, string> = {}
    if (existingSize > 0) headers['Range'] = `bytes=${existingSize}-`

    try {
      const res = await fetch(url, { headers })

      // 已完整：Range 请求返回 416，说明 .part 其实已经下完了
      if (existingSize > 0 && res.status === 416) {
        onProgress?.({ name, percent: 100, message: '已完整' })
        break
      }
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`)
      }

      const contentLength = Number(res.headers.get('content-length') ?? 0)
      const total = existingSize > 0 ? existingSize + contentLength : contentLength

      const sink = createWriteStream(tmp, existingSize > 0 ? { flags: 'a' } : {})
      await streamToFile(res, sink, existingSize, total, name, onProgress)
      break
    } catch (err) {
      if (attempt === maxAttempts - 1) throw err
      const doneMb = existsSync(tmp) ? (statSync(tmp).size / 1024 / 1024).toFixed(1) : '0'
      onProgress?.({
        name,
        percent: 0,
        message: `网络中断（已下 ${doneMb} MB），3 秒后自动重试（第 ${attempt + 1} 次）…`
      })
      await sleep(3000)
    }
  }

  renameSync(tmp, dest)
  onProgress?.({ name, percent: 100, message: '完成' })
}

/** 下载 whisper ggml 模型，实时回传进度（支持断点续传） */
export async function downloadModel(
  name: string,
  onProgress?: (p: ModelProgress) => void
): Promise<string> {
  const dest = whisperModelFile(name)

  if (existsSync(dest)) {
    onProgress?.({ name, percent: 100, message: '已存在' })
    return dest
  }

  let lastError: unknown = null
  for (const base of hfEndpoints()) {
    try {
      onProgress?.({ name, percent: 0, message: `连接 ${new URL(base).host} …` })
      await downloadFileResumable(modelUrl(base, name), dest, name, onProgress)
      return dest
    } catch (err) {
      lastError = err
      // 尝试下一个端点（.part 会保留，下一个端点可继续续传）
    }
  }
  throw new Error(
    `下载模型失败（${lastError instanceof Error ? lastError.message : String(lastError)}）。` +
      `可尝试设置镜像：HF_ENDPOINT=https://hf-mirror.com`
  )
}

/** 下载本地 LLM 翻译模型（Qwen2.5-7B，约 4.4GB），实时回传进度（支持断点续传） */
export async function downloadLlmModel(onProgress?: (p: ModelProgress) => void): Promise<string> {
  const dest = llmModelFile()
  const name = 'qwen2.5-7b'

  if (existsSync(dest)) {
    onProgress?.({ name, percent: 100, message: '已存在' })
    return dest
  }

  let lastError: unknown = null
  for (const base of hfEndpoints()) {
    try {
      onProgress?.({ name, percent: 0, message: `连接 ${new URL(base).host} …` })
      const url = `${base}/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/${LLM_MODEL_FILE}`
      await downloadFileResumable(url, dest, name, onProgress)
      return dest
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(
    `下载翻译模型失败（${lastError instanceof Error ? lastError.message : String(lastError)}）。` +
      `可尝试设置镜像：HF_ENDPOINT=https://hf-mirror.com`
  )
}
