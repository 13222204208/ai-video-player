import { ipcMain, dialog, BrowserWindow } from 'electron'
import { extname, join } from 'node:path'
import type { RunPipelineOptions, SaveSubtitlesPayload } from '@shared/types'
import { runPipeline, cancelPipeline } from './services/pipeline'
import { startStreaming, cancelStreaming } from './services/streaming'
import { listModels, downloadModel, downloadLlmModel, llmModelExists } from './services/models'
import { getLlmServer, isLlmRunning } from './services/llm'
import { saveSubtitles, loadSavedSubtitles } from './services/subtitle'
import {
  getLibrary,
  addToPlaylist,
  removeFromPlaylist,
  addToHistory,
  clearHistory,
  addFilesToPlaylist,
  addFolderToPlaylist,
  saveProgress,
  getProgress
} from './services/library'
import { remuxToMp4, transcodeToH264 } from './services/ffmpeg'
import { getTempDir } from './services/paths'

export function registerIpc(): void {
  ipcMain.handle('pipeline:run', (event, videoPath: string, options: RunPipelineOptions) => {
    return runPipeline(videoPath, options, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('pipeline:progress', progress)
    })
  })

  ipcMain.handle('pipeline:cancel', () => {
    cancelPipeline()
  })

  ipcMain.handle('stream:start', (event, videoPath: string, options: RunPipelineOptions) => {
    return startStreaming(videoPath, options, {
      onSegment: (segment) => {
        if (!event.sender.isDestroyed()) event.sender.send('stream:segment', segment)
      },
      onProgress: (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('stream:progress', progress)
      },
      onLog: (line) => {
        if (!event.sender.isDestroyed()) event.sender.send('stream:log', line)
      }
    })
  })

  ipcMain.handle('stream:cancel', () => {
    cancelStreaming()
  })

  ipcMain.handle('models:list', () => listModels())

  ipcMain.handle('models:download', (event, name: string) => {
    return downloadModel(name, (p) => {
      if (!event.sender.isDestroyed()) event.sender.send('models:progress', p)
    })
  })

  ipcMain.handle('subtitle:save', (_event, payload: SaveSubtitlesPayload) => {
    return saveSubtitles(payload)
  })

  ipcMain.handle('subtitle:load', (_event, videoPath: string) => {
    return loadSavedSubtitles(videoPath)
  })

  ipcMain.handle('library:get', () => getLibrary())
  ipcMain.handle('library:add-playlist', (_e, path: string, title: string) => addToPlaylist(path, title))
  ipcMain.handle('library:remove-playlist', (_e, path: string) => removeFromPlaylist(path))
  ipcMain.handle('library:add-history', (_e, path: string, title: string) => addToHistory(path, title))
  ipcMain.handle('library:clear-history', () => clearHistory())

  ipcMain.handle('library:add-files', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择视频文件（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '视频文件',
          extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'ts', 'flv', 'wmv', 'm2ts', 'ogv', 'm4a']
        },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || filePaths.length === 0) return null
    return addFilesToPlaylist(filePaths)
  })

  ipcMain.handle('library:add-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择视频文件夹（会递归扫描子文件夹）',
      properties: ['openDirectory']
    })
    if (canceled || filePaths.length === 0) return null
    return addFolderToPlaylist(filePaths[0])
  })

  ipcMain.handle('library:save-progress', (_e, path: string, seconds: number) => {
    saveProgress(path, seconds)
  })

  ipcMain.handle('library:get-progress', (_e, path: string) => getProgress(path))

  ipcMain.handle('llm:translate', async (event, payload: { lines: string[]; srcLang: string; context?: string[] }) => {
    const server = await getLlmServer((line) => {
      if (!event.sender.isDestroyed()) event.sender.send('llm:log', line)
    })
    return server.translate(payload.lines, { srcLang: payload.srcLang, context: payload.context })
  })

  ipcMain.handle('llm:status', () => ({
    modelExists: llmModelExists(),
    running: isLlmRunning()
  }))

  ipcMain.handle('llm:download', (event) => {
    return downloadLlmModel((p) => {
      if (!event.sender.isDestroyed()) event.sender.send('models:progress', p)
    })
  })

  ipcMain.handle('media:remux', (event, videoPath: string) => {
    const ext = extname(videoPath).toLowerCase()
    const outPath = join(getTempDir(), `remux-${Date.now()}.mp4`)
    const win = BrowserWindow.fromWebContents(event.sender)
    return remuxToMp4(videoPath, outPath, ({ data }) => {
      // ffmpeg 进度（copy 流通常很快），仅透传日志
      win?.webContents.send('remux:log', { data, ext })
    }).then(() => ({ outputPath: outPath }))
  })

  ipcMain.handle('media:transcode', (event, videoPath: string) => {
    const outPath = join(getTempDir(), `transcode-${Date.now()}.mp4`)
    const win = BrowserWindow.fromWebContents(event.sender)
    return transcodeToH264(videoPath, outPath, ({ data }) => {
      win?.webContents.send('transcode:log', { data })
    }).then(() => ({ outputPath: outPath }))
  })

  ipcMain.handle('dialog:openVideo', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '选择视频文件',
      properties: ['openFile'],
      filters: [
        { name: '视频文件', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'ts', 'flv'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (canceled || filePaths.length === 0) return null
    return filePaths[0]
  })
}
