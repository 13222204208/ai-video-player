import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { SaveSubtitlesPayload, SaveSubtitlesResult, SubtitleSegment } from '@shared/types'

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const mm = ms % 1000
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(mm, 3)}`
}

function vttTime(seconds: number): string {
  return srtTime(seconds).replace(',', '.')
}

/** 拼接双语行（原文在上，译文在下） */
function cueText(seg: SubtitleSegment): string {
  return seg.translation ? `${seg.text}\n${seg.translation}` : seg.text
}

export function buildSrt(segments: SubtitleSegment[]): string {
  return segments
    .map(
      (s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${cueText(s)}`
    )
    .join('\n\n')
}

export function buildVtt(segments: SubtitleSegment[]): string {
  const cues = segments
    .map((s) => `${vttTime(s.start)} --> ${vttTime(s.end)}\n${cueText(s)}`)
    .join('\n\n')
  return `WEBVTT\n\n${cues}\n`
}

/** 将双语字幕写入视频同目录的 .srt / .vtt 文件 */
export function saveSubtitles(payload: SaveSubtitlesPayload): SaveSubtitlesResult {
  const { videoPath, segments } = payload
  const base = basename(videoPath).replace(/\.[^.]+$/, '')
  const dir = videoPath.slice(0, videoPath.length - basename(videoPath).length)

  const srtPath = join(dir, `${base}.zh.srt`)
  const vttPath = join(dir, `${base}.zh.vtt`)
  writeFileSync(srtPath, buildSrt(segments), 'utf8')
  writeFileSync(vttPath, buildVtt(segments), 'utf8')
  return { srtPath, vttPath }
}

/** 解析 SRT 文本为字幕片段（支持双语：第一行原文，第二行译文） */
export function parseSrt(content: string): SubtitleSegment[] {
  const blocks = content.trim().split(/\n\s*\n/)
  const segments: SubtitleSegment[] = []
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0)
    const timeIdx = lines.findIndex((l) => l.includes('-->'))
    if (timeIdx === -1) continue
    const m = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/.exec(lines[timeIdx])
    if (!m) continue
    const start = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0').slice(0, 3) / 1000
    const end = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8].padEnd(3, '0').slice(0, 3) / 1000
    const textLines = lines.slice(timeIdx + 1)
    segments.push({
      index: segments.length,
      start,
      end,
      text: textLines[0] ?? '',
      translation: textLines.length > 1 ? textLines[1] : undefined
    })
  }
  return segments
}

/** 读取视频同目录已保存的 .zh.srt 字幕（若有），返回片段；无则返回 null */
export function loadSavedSubtitles(videoPath: string): SubtitleSegment[] | null {
  const base = basename(videoPath).replace(/\.[^.]+$/, '')
  const dir = videoPath.slice(0, videoPath.length - basename(videoPath).length)
  const srtPath = join(dir, `${base}.zh.srt`)
  if (!existsSync(srtPath)) return null
  try {
    const segments = parseSrt(readFileSync(srtPath, 'utf8'))
    return segments.length > 0 ? segments : null
  } catch {
    return null
  }
}
