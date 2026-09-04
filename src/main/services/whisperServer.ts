import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { resolveWhisperServerBinary } from './paths'

export interface ServerSegment {
  start: number
  end: number
  text: string
}

export interface ServerResult {
  text: string
  language: string
  segments: ServerSegment[]
}

interface VerboseJson {
  text?: string
  language?: string
  segments?: Array<{ text?: string; start?: number; end?: number; no_speech_prob?: number }>
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * 管理 whisper-server 进程（模型只加载一次），逐段调用 /inference 进行识别。
 * 相比每段都 spawn whisper-cli，避免了反复加载模型（快几个数量级）。
 */
export class WhisperServer {
  private proc: ChildProcess | null = null
  private port = 0

  get isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null
  }

  async start(
    modelPath: string,
    opts: { port?: number; onLog?: (line: string) => void; vad?: boolean; vadModel?: string } = {}
  ): Promise<void> {
    const bin = resolveWhisperServerBinary()
    this.port = opts.port ?? (await freePort())

    const args = [
      '-m',
      modelPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(this.port),
      '-nlp'
    ]
    // 启用内置 Silero VAD：能区分人声与背景音乐，显著减少漏识别
    if (opts.vad && opts.vadModel) {
      args.push('--vad', '-vm', opts.vadModel)
    }

    this.proc = spawn(bin, args)
    this.proc.stderr?.on('data', (d: Buffer) => opts.onLog?.(d.toString()))
    this.proc.stdout?.on('data', (d: Buffer) => opts.onLog?.(d.toString()))
    this.proc.on('error', () => {
      /* 错误由 waitReady 通过退出码捕获 */
    })

    await this.waitReady()
  }

  private async waitReady(timeoutMs = 120000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.proc && this.proc.exitCode !== null) {
        throw new Error(`whisper-server 启动失败（退出码 ${this.proc.exitCode}）`)
      }
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`)
        if (res.ok && (await res.text()).includes('"ok"')) return
      } catch {
        /* 尚未就绪 */
      }
      await sleep(250)
    }
    throw new Error('whisper-server 启动超时')
  }

  /** 识别一段 WAV（16kHz 单声道 PCM） */
  async transcribe(wavBuffer: Buffer, language = 'auto'): Promise<ServerResult> {
    if (!this.proc || this.proc.exitCode !== null) {
      throw new Error('whisper-server 未运行')
    }
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' }), 'audio.wav')
    form.append('language', language)
    form.append('response_format', 'verbose_json')

    const res = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: 'POST',
      body: form
    })
    if (!res.ok) {
      throw new Error(`whisper-server 识别失败：HTTP ${res.status}`)
    }
    const json = (await res.json()) as VerboseJson
    // 过滤幻觉：空文本、疑似非语音（no_speech_prob 高）、连续重复句
    const seen = new Set<string>()
    const segments = (json.segments ?? [])
      .map((s) => ({
        start: s.start ?? 0,
        end: s.end ?? 0,
        text: (s.text ?? '').trim(),
        noSpeechProb: s.no_speech_prob ?? 0
      }))
      .filter((s) => s.text.length > 0 && s.noSpeechProb < 0.5)
      .filter((s) => {
        const key = s.text
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    return {
      text: json.text ?? '',
      language: json.language ?? language,
      segments
    }
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }
}
