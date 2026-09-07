import { ipcMain, dialog, BrowserWindow } from 'electron'
import { extname, join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
import { remuxToMp4, transcodeToH264, probeVideo } from './services/ffmpeg'
import { getTranscodeCacheDir } from './services/paths'

const CACHE_LIMIT_BYTES = 20 * 1024 * 1024 * 1024 // 20GB

/** 转换缓存：app 缓存目录下，文件名 = 源路径 SHA1 哈希（确定性、可复用、不污染源目录） */
function cacheKey(videoPath: string): string {
  return createHash('sha1').update(videoPath).digest('hex')
}

function convertedPath(videoPath: string): string {
  return join(getTranscodeCacheDir(), `${cacheKey(videoPath)}.mp4`)
}

function sidecarPath(videoPath: string): string {
  return join(getTranscodeCacheDir(), `${cacheKey(videoPath)}.json`)
}

/** 缓存是否仍有效（源文件大小 + 修改时间未变） */
function hasValidCache(videoPath: string): boolean {
  const out = convertedPath(videoPath)
  const side = sidecarPath(videoPath)
  if (!existsSync(out) || !existsSync(side)) return false
  try {
    const src = statSync(videoPath)
    const meta = JSON.parse(readFileSync(side, 'utf8')) as { size?: number; mtimeMs?: number }
    return meta.size === src.size && meta.mtimeMs === Math.floor(src.mtimeMs)
  } catch {
    return false
  }
}

/** 转换成功后记录源文件指纹，并触发 LRU 清理 */
function markCache(videoPath: string): void {
  try {
    const src = statSync(videoPath)
    writeFileSync(
      sidecarPath(videoPath),
      JSON.stringify({ size: src.size, mtimeMs: Math.floor(src.mtimeMs) }),
      'utf8'
    )
  } catch {
    /* 忽略 */
  }
  enforceCacheLimit()
}

/** 超过大小上限时，按修改时间删除最旧的缓存文件（LRU） */
function enforceCacheLimit(): void {
  try {
    const dir = getTranscodeCacheDir()
    const files = readdirSync(dir).map((name) => {
      const p = join(dir, name)
      const st = statSync(p)
      return { p, mtime: st.mtimeMs, size: st.size }
    })
    let total = files.reduce((s, f) => s + f.size, 0)
    if (total <= CACHE_LIMIT_BYTES) return
    files.sort((a, b) => a.mtime - b.mtime)
    for (const f of files) {
      if (total <= CACHE_LIMIT_BYTES) break
      try {
        unlinkSync(f.p)
        total -= f.size
      } catch {
        /* 忽略单个删除失败 */
      }
    }
  } catch {
    /* 忽略 */
  }
}

/** 转换缓存统计 */
function cacheStats(): { fileCount: number; totalBytes: number; dir: string } {
  const dir = getTranscodeCacheDir()
  try {
    const names = readdirSync(dir)
    let totalBytes = 0
    for (const name of names) {
      try {
        totalBytes += statSync(join(dir, name)).size
      } catch {
        /* 忽略 */
      }
    }
    return { fileCount: names.length, totalBytes, dir }
  } catch {
    return { fileCount: 0, totalBytes: 0, dir }
  }
}

/** 清空转换缓存 */
function clearCache(): { fileCount: number; totalBytes: number; dir: string } {
  const dir = getTranscodeCacheDir()
  try {
    for (const name of readdirSync(dir)) {
      try {
        unlinkSync(join(dir, name))
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* 忽略 */
  }
  return cacheStats()
}

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

  ipcMain.handle('media:probe', (_event, videoPath: string) => {
    return probeVideo(videoPath)
  })

  ipcMain.handle('cache:stats', () => cacheStats())
  ipcMain.handle('cache:clear', () => clearCache())

  ipcMain.handle('media:remux', (event, videoPath: string) => {
    const ext = extname(videoPath).toLowerCase()
    const outPath = convertedPath(videoPath)
    // 已有有效缓存则直接复用，不重复转换
    if (hasValidCache(videoPath)) return { outputPath: outPath, cached: true }
    const win = BrowserWindow.fromWebContents(event.sender)
    return remuxToMp4(videoPath, outPath, ({ data }) => {
      // ffmpeg 进度（copy 流通常很快），仅透传日志
      win?.webContents.send('remux:log', { data, ext })
    }).then(() => {
      markCache(videoPath)
      return { outputPath: outPath, cached: false }
    })
  })

  ipcMain.handle('media:transcode', (event, videoPath: string) => {
    const outPath = convertedPath(videoPath)
    if (hasValidCache(videoPath)) return { outputPath: outPath, cached: true }
    const win = BrowserWindow.fromWebContents(event.sender)
    return transcodeToH264(videoPath, outPath, ({ data }) => {
      win?.webContents.send('transcode:log', { data })
    }).then(() => {
      markCache(videoPath)
      return { outputPath: outPath, cached: false }
    })
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
