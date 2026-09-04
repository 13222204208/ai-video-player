import { app, shell, BrowserWindow, protocol, net } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promises as fsp, existsSync, cpSync } from 'node:fs'
import { registerIpc } from './ipc'
import { ensureDirs } from './services/paths'

/** 旧版本 productName 为 LocalAIVideoPlayer，改名后把已下载的模型迁移过来 */
function migrateOldModels(): void {
  try {
    const appData = app.getPath('appData')
    const oldModels = join(appData, 'LocalAIVideoPlayer', 'models')
    const newModels = join(appData, 'AIVideoPlayer', 'models')
    if (existsSync(oldModels) && !existsSync(newModels)) {
      cpSync(oldModels, newModels, { recursive: true })
      console.log('已迁移旧模型目录：', oldModels, '->', newModels)
    }
  } catch (err) {
    console.warn('模型迁移失败（忽略）：', err)
  }
}

// 允许无用户手势自动播放（本地媒体播放器场景）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// 注册自定义 media:// 协议（用于「打开文件」场景的视频流式播放，支持 Range 拖动）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

function mimeOf(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    ogv: 'video/ogg',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    m4a: 'audio/mp4'
  }
  return map[ext] ?? 'application/octet-stream'
}

/** 处理 media://f/<encodeURIComponent(absPath)> 请求，支持 Range */
async function mediaHandler(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''))
  try {
    const stat = await fsp.stat(filePath)
    const size = stat.size
    const range = request.headers.get('range')

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      let start = 0
      let end = size - 1
      if (m) {
        if (m[1]) start = parseInt(m[1], 10)
        if (m[2]) end = parseInt(m[2], 10)
      }
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      end = Math.min(end, size - 1)
      const chunkSize = end - start + 1
      const buf = Buffer.alloc(chunkSize)
      const fh = await fsp.open(filePath, 'r')
      try {
        await fh.read(buf, 0, chunkSize, start)
      } finally {
        await fh.close()
      }
      return new Response(new Uint8Array(buf), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
          'Content-Type': mimeOf(filePath)
        }
      })
    }

    return net.fetch(pathToFileURL(filePath).toString())
  } catch {
    return new Response('Not found', { status: 404 })
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    title: 'AIVideoPlayer',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  migrateOldModels()
  ensureDirs()
  protocol.handle('media', mediaHandler)
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
