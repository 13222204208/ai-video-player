import type {
  Library,
  LlmStatus,
  LlmTranslatePayload,
  ModelProgress,
  PipelineProgress,
  RunPipelineOptions,
  SaveSubtitlesPayload,
  SaveSubtitlesResult,
  StreamProgress,
  StreamResult,
  SubtitleSegment,
  TranscribeResult,
  WhisperModelInfo
} from './types'

/** remux:log 事件负载 */
export interface RemuxLog {
  data: string
  ext: string
}

/** preload 暴露给渲染进程的桥接 API（window.api） */
export interface Api {
  getPathForFile(file: File): string
  runPipeline(videoPath: string, options: RunPipelineOptions): Promise<TranscribeResult>
  cancelPipeline(): Promise<void>
  onPipelineProgress(cb: (p: PipelineProgress) => void): () => void

  startStreaming(videoPath: string, options: RunPipelineOptions): Promise<StreamResult>
  cancelStreaming(): Promise<void>
  onStreamSegment(cb: (seg: SubtitleSegment) => void): () => void
  onStreamProgress(cb: (p: StreamProgress) => void): () => void
  onStreamLog(cb: (line: string) => void): () => void

  listModels(): Promise<WhisperModelInfo[]>
  downloadModel(name: string): Promise<string>
  onModelProgress(cb: (p: ModelProgress) => void): () => void

  saveSubtitles(payload: SaveSubtitlesPayload): Promise<SaveSubtitlesResult>
  loadSavedSubtitles(videoPath: string): Promise<SubtitleSegment[] | null>

  getLibrary(): Promise<Library>
  addToPlaylist(path: string, title: string): Promise<Library>
  removeFromPlaylist(path: string): Promise<Library>
  addToHistory(path: string, title: string): Promise<Library>
  clearHistory(): Promise<Library>
  addVideoFiles(): Promise<{ library: Library; added: number } | null>
  addFolderToPlaylist(): Promise<{ library: Library; added: number } | null>
  saveProgress(path: string, seconds: number): Promise<void>
  getProgress(path: string): Promise<number>

  llmTranslate(payload: LlmTranslatePayload): Promise<string[]>
  llmStatus(): Promise<LlmStatus>
  downloadLlmModel(): Promise<string>
  onLlmLog(cb: (line: string) => void): () => void

  remuxVideo(videoPath: string): Promise<{ outputPath: string }>
  onRemuxLog(cb: (p: RemuxLog) => void): () => void
  transcodeVideo(videoPath: string): Promise<{ outputPath: string }>
  onTranscodeLog(cb: (p: RemuxLog) => void): () => void

  openVideoDialog(): Promise<string | null>
}
