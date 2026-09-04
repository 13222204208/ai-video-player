import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { Api } from '@shared/api'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: Api = {
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  runPipeline: (videoPath, options) => ipcRenderer.invoke('pipeline:run', videoPath, options),
  cancelPipeline: () => ipcRenderer.invoke('pipeline:cancel'),
  onPipelineProgress: (cb) => subscribe('pipeline:progress', cb),

  startStreaming: (videoPath, options) => ipcRenderer.invoke('stream:start', videoPath, options),
  cancelStreaming: () => ipcRenderer.invoke('stream:cancel'),
  onStreamSegment: (cb) => subscribe('stream:segment', cb),
  onStreamProgress: (cb) => subscribe('stream:progress', cb),
  onStreamLog: (cb) => subscribe('stream:log', cb),

  listModels: () => ipcRenderer.invoke('models:list'),
  downloadModel: (name) => ipcRenderer.invoke('models:download', name),
  onModelProgress: (cb) => subscribe('models:progress', cb),

  saveSubtitles: (payload) => ipcRenderer.invoke('subtitle:save', payload),
  loadSavedSubtitles: (videoPath) => ipcRenderer.invoke('subtitle:load', videoPath),

  getLibrary: () => ipcRenderer.invoke('library:get'),
  addToPlaylist: (path, title) => ipcRenderer.invoke('library:add-playlist', path, title),
  removeFromPlaylist: (path) => ipcRenderer.invoke('library:remove-playlist', path),
  addToHistory: (path, title) => ipcRenderer.invoke('library:add-history', path, title),
  clearHistory: () => ipcRenderer.invoke('library:clear-history'),
  addVideoFiles: () => ipcRenderer.invoke('library:add-files'),
  addFolderToPlaylist: () => ipcRenderer.invoke('library:add-folder'),
  saveProgress: (path, seconds) => ipcRenderer.invoke('library:save-progress', path, seconds),
  getProgress: (path) => ipcRenderer.invoke('library:get-progress', path),

  llmTranslate: (payload) => ipcRenderer.invoke('llm:translate', payload),
  llmStatus: () => ipcRenderer.invoke('llm:status'),
  downloadLlmModel: () => ipcRenderer.invoke('llm:download'),
  onLlmLog: (cb) => subscribe('llm:log', cb),

  remuxVideo: (videoPath) => ipcRenderer.invoke('media:remux', videoPath),
  onRemuxLog: (cb) => subscribe('remux:log', cb),
  transcodeVideo: (videoPath) => ipcRenderer.invoke('media:transcode', videoPath),
  onTranscodeLog: (cb) => subscribe('transcode:log', cb),

  openVideoDialog: () => ipcRenderer.invoke('dialog:openVideo')
}

contextBridge.exposeInMainWorld('api', api)
