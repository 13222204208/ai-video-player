/**
 * 跨进程共享的类型定义（主进程 / 渲染进程共用）。
 */

/** 一条字幕片段（原文 + 可选译文），时间单位为秒 */
export interface SubtitleSegment {
  index: number
  /** 开始时间（秒） */
  start: number
  /** 结束时间（秒） */
  end: number
  /** 原文（Whisper 识别结果） */
  text: string
  /** 中文翻译（翻译阶段填充） */
  translation?: string
}

/** 流水线阶段 */
export type PipelineStage = 'idle' | 'extract' | 'transcribe' | 'done' | 'error'

/** 主进程流水线进度事件（extract / transcribe） */
export interface PipelineProgress {
  stage: PipelineStage
  message: string
  /** 0-100 */
  percent: number
  detectedLanguage?: string
}

/** pipeline:run 的返回值 */
export interface TranscribeResult {
  segments: SubtitleSegment[]
  detectedLanguage: string
}

export interface RunPipelineOptions {
  /** whisper 模型名，如 small / medium / large-v3-turbo */
  model: string
  /** 'auto' | 'ja' | 'en' */
  language: string
}

export interface SaveSubtitlesPayload {
  videoPath: string
  segments: SubtitleSegment[]
}

export interface SaveSubtitlesResult {
  srtPath: string
  vttPath: string
}

/** 流式识别状态 */
export type StreamStatus = 'starting' | 'listening' | 'done' | 'error'

export interface StreamProgress {
  status: StreamStatus
  message: string
  percent: number
  segmentCount?: number
  detectedLanguage?: string
}

export interface StreamResult {
  detectedLanguage: string
  segmentCount: number
}

/** LLM 翻译请求 */
export interface LlmTranslatePayload {
  lines: string[]
  srcLang: string
  context?: string[]
}

export interface LlmStatus {
  modelExists: boolean
  running: boolean
}

export interface LibraryEntry {
  path: string
  title: string
  addedAt: number
}

export interface Library {
  playlist: LibraryEntry[]
  history: LibraryEntry[]
  progress: Record<string, number>
}

export interface ModelProgress {
  name: string
  percent: number
  message: string
}

export interface WhisperModelInfo {
  name: string
  label: string
  installed: boolean
  sizeMb: number
}

export interface RemuxResult {
  outputPath: string
}

/** 可选 whisper 模型（ggml-*.bin，来自 huggingface.co/ggerganov/whisper.cpp） */
export const WHISPER_MODELS: { name: string; sizeMb: number; label: string }[] = [
  { name: 'medium', sizeMb: 1500, label: 'Medium（较准）' },
  { name: 'large-v3-turbo', sizeMb: 1600, label: 'Large v3 Turbo（推荐 / 快且准）' },
  { name: 'large-v3', sizeMb: 3000, label: 'Large v3（最准 / 吃内存）' }
]

/** whisper 检测语言代码 -> NLLB-200 语言代码 */
export const NLLB_LANG: Record<string, string> = {
  ja: 'jpn_Jpan',
  en: 'eng_Latn',
  zh: 'zho_Hans',
  ko: 'kor_Hang'
}

/** Chromium <video> 可直接播放的容器（其余如 mkv/avi 需要无损转 MP4） */
export const PLAYABLE_EXT = ['.mp4', '.m4v', '.mov', '.webm', '.m4a', '.ogv']
