import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import type { SubtitleSegment } from '@shared/types'
import { resolveWhisperBinary } from './paths'

export interface TranscribeOutput {
  segments: SubtitleSegment[]
  detectedLanguage: string
}

interface WhisperJson {
  result?: { language?: string }
  transcription?: Array<{
    text?: string
    offsets?: { from?: number; to?: number }
    timestamps?: { from?: string; to?: string }
  }>
}

/** 解析 whisper.cpp 输出的 "HH:MM:SS,mmm" 时间戳为毫秒 */
function parseTimestampToMs(ts: string): number {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(ts)
  if (!m) return 0
  const [, h, min, s, ms] = m
  return (+h * 3600 + +min * 60 + +s) * 1000 + +ms.padEnd(3, '0').slice(0, 3)
}

/**
 * 调用 whisper.cpp 二进制进行整段识别。
 * 使用 `-oj` 输出带时间轴的 JSON，解析出带起止时间的字幕片段。
 */
export function transcribe(
  wavPath: string,
  modelPath: string,
  options: { language?: string; onProgress?: (percent: number) => void } = {}
): Promise<TranscribeOutput> {
  const { language = 'auto', onProgress } = options
  return new Promise((resolve, reject) => {
    const bin = resolveWhisperBinary()
    const outPrefix = join(
      process.platform === 'win32' ? process.env.TEMP ?? '.' : '/tmp',
      `whisper-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    const args = [
      '-m',
      modelPath,
      '-f',
      wavPath,
      '-l',
      language,
      '-oj',
      '-of',
      outPrefix,
      '-t',
      String(Math.max(4, os.cpus().length))
    ]

    const proc = spawn(bin, args)
    let stderrTail = ''

    proc.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      stderrTail = (stderrTail + text).slice(-4000)
      // 解析进度：whisper_print_progress_callback: progress =  N%
      const m = /progress\s*=\s*(\d{1,3})%/.exec(text)
      if (m) onProgress?.(Math.min(100, Number(m[1])))
    })

    proc.on('error', (err) => {
      reject(
        new Error(`无法启动 whisper 二进制：${err.message}（请运行 pnpm run build:whisper）`)
      )
    })

    proc.on('close', (code) => {
      const jsonPath = outPrefix + '.json'
      try {
        if (code !== 0) {
          reject(new Error(`whisper 识别失败（退出码 ${code}）\n${stderrTail.slice(-800)}`))
          return
        }
        const raw = readFileSync(jsonPath, 'utf8')
        const json = JSON.parse(raw) as WhisperJson
        const detectedLanguage = json.result?.language ?? language

        const seen = new Set<string>()
        const segments: SubtitleSegment[] = (json.transcription ?? [])
          .map((seg, i) => {
            const fromMs =
              seg.offsets?.from ?? (seg.timestamps?.from ? parseTimestampToMs(seg.timestamps.from) : 0)
            const toMs =
              seg.offsets?.to ?? (seg.timestamps?.to ? parseTimestampToMs(seg.timestamps.to) : 0)
            return {
              index: i,
              start: fromMs / 1000,
              end: toMs / 1000,
              text: (seg.text ?? '').trim()
            }
          })
          .filter((s) => s.text.length > 0)
          .filter((s) => {
            if (seen.has(s.text)) return false
            seen.add(s.text)
            return true
          })

        resolve({ segments, detectedLanguage })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      } finally {
        try {
          rmSync(jsonPath, { force: true })
        } catch {
          /* ignore */
        }
      }
    })
  })
}
