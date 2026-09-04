import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { getModelsDir, resolveLlamaServerBinary } from './paths'

const LLM_MODEL_FILE = 'Qwen2.5-7B-Instruct-Q4_K_M.gguf'

export function llmModelFile(): string {
  return join(getModelsDir(), LLM_MODEL_FILE)
}

export function llmModelExists(): boolean {
  return existsSync(llmModelFile())
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
 * 管理 llama-server（本地 LLM，OpenAI 兼容接口），做上下文感知的字幕翻译。
 */
export class LlmServer {
  private proc: ChildProcess | null = null
  private port = 0

  get isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null
  }

  async start(opts: { onLog?: (line: string) => void } = {}): Promise<void> {
    const bin = resolveLlamaServerBinary()
    const modelPath = llmModelFile()
    if (!existsSync(modelPath)) {
      throw new Error(`翻译模型 ${LLM_MODEL_FILE} 尚未下载。请在界面点击「下载翻译模型」。`)
    }
    this.port = await freePort()
    this.proc = spawn(bin, [
      '-m',
      modelPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(this.port),
      '-ngl',
      '99', // 全部层放到 GPU（Metal）
      '--ctx-size',
      '4096',
      '--batch-size',
      '512'
    ])
    this.proc.stderr?.on('data', (d: Buffer) => opts.onLog?.(d.toString()))
    this.proc.stdout?.on('data', (d: Buffer) => opts.onLog?.(d.toString()))
    this.proc.on('error', () => {
      /* 由 waitReady 通过退出码捕获 */
    })
    await this.waitReady()
  }

  private async waitReady(timeoutMs = 300000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.proc && this.proc.exitCode !== null) {
        throw new Error(`llama-server 启动失败（退出码 ${this.proc.exitCode}）`)
      }
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`)
        if (res.ok) return
      } catch {
        /* 尚未就绪 */
      }
      await sleep(500)
    }
    throw new Error('llama-server 启动超时')
  }

  /** 上下文感知的批量翻译：返回与 lines 一一对应的译文 */
  async translate(
    lines: string[],
    opts: { srcLang: string; context?: string[] }
  ): Promise<string[]> {
    if (!this.isRunning) throw new Error('llama-server 未运行')

    const srcLabel =
      opts.srcLang === 'jpn_Jpan' ? '日语' : opts.srcLang === 'eng_Latn' ? '英语' : '外语'
    const system = `你是影视字幕翻译专家，负责把${srcLabel}对白翻译成简体中文。要求：口语化自然、贴合上下文、保持人物语气与称呼一致。只输出译文，每行对应一行原文，不要编号、不要解释、不要输出原文。`

    let user = ''
    if (opts.context && opts.context.length > 0) {
      user += '上文（仅供理解上下文，不要翻译）：\n' + opts.context.join('\n') + '\n\n'
    }
    user += '待翻译（逐行输出对应译文）：\n' + lines.join('\n')

    const res = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: 0.3,
        max_tokens: 2048,
        stream: false
      })
    })
    if (!res.ok) {
      throw new Error(`LLM 翻译请求失败：HTTP ${res.status}`)
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = (json.choices?.[0]?.message?.content ?? '').trim()
    return this.parseLines(content, lines.length)
  }

  /** 解析模型输出为逐行译文；行数不匹配时按顺序填充/截断 */
  private parseLines(content: string, expected: number): string[] {
    const cleaned = content
      .split('\n')
      .map((l) => l.trim().replace(/^\d+[.、:：)）]\s*/, '').replace(/^[-*]\s*/, ''))
      .filter((l) => l.length > 0)

    if (cleaned.length === expected) return cleaned
    if (cleaned.length === 0) return Array(expected).fill('')
    if (cleaned.length === 1) {
      // 模型输出了一整段：作为第一句，其余留空（下一轮可重试）
      return [cleaned[0], ...Array(expected - 1).fill('')]
    }
    const out = cleaned.slice(0, expected)
    while (out.length < expected) out.push('')
    return out
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }
}

// ---- 单例管理 ----
let singleton: LlmServer | null = null
let loading: Promise<LlmServer> | null = null

export async function getLlmServer(onLog?: (line: string) => void): Promise<LlmServer> {
  if (singleton?.isRunning) return singleton
  if (!loading) {
    loading = (async () => {
      const s = new LlmServer()
      await s.start({ onLog })
      singleton = s
      return s
    })()
  }
  return loading
}

export function stopLlmServer(): void {
  singleton?.stop()
  singleton = null
  loading = null
}

export function isLlmRunning(): boolean {
  return singleton?.isRunning ?? false
}
