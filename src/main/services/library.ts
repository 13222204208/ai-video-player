import { app } from 'electron'
import { existsSync, readFileSync, readdirSync, writeFileSync, type Dirent } from 'node:fs'
import { basename, extname, join } from 'node:path'

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

function libFile(): string {
  return join(app.getPath('userData'), 'library.json')
}

function load(): Library {
  try {
    if (existsSync(libFile())) {
      const data = JSON.parse(readFileSync(libFile(), 'utf8')) as Partial<Library>
      return {
        playlist: data.playlist ?? [],
        history: data.history ?? [],
        progress: data.progress ?? {}
      }
    }
  } catch {
    /* 损坏则重置 */
  }
  return { playlist: [], history: [], progress: {} }
}

function save(lib: Library): void {
  try {
    writeFileSync(libFile(), JSON.stringify(lib, null, 2), 'utf8')
  } catch {
    /* 忽略写失败 */
  }
}

export function getLibrary(): Library {
  return load()
}

export function addToPlaylist(path: string, title: string): Library {
  const lib = load()
  if (!lib.playlist.some((e) => e.path === path)) {
    lib.playlist.unshift({ path, title, addedAt: Date.now() })
    save(lib)
  }
  return lib
}

export function removeFromPlaylist(path: string): Library {
  const lib = load()
  lib.playlist = lib.playlist.filter((e) => e.path !== path)
  save(lib)
  return lib
}

export function addToHistory(path: string, title: string): Library {
  const lib = load()
  lib.history = lib.history.filter((e) => e.path !== path)
  lib.history.unshift({ path, title, addedAt: Date.now() })
  if (lib.history.length > 100) lib.history = lib.history.slice(0, 100)
  save(lib)
  return lib
}

export function clearHistory(): Library {
  const lib = load()
  lib.history = []
  save(lib)
  return lib
}

/** 保存播放进度（秒） */
export function saveProgress(path: string, seconds: number): void {
  const lib = load()
  lib.progress[path] = Math.max(0, Math.floor(seconds))
  save(lib)
}

/** 读取播放进度（秒），无记录返回 0 */
export function getProgress(path: string): number {
  const lib = load()
  return lib.progress[path] ?? 0
}

const VIDEO_EXT = [
  '.mp4', '.mkv', '.mov', '.webm', '.avi', '.m4v', '.ts', '.flv', '.wmv', '.m2ts', '.ogv', '.m4a'
]

/** 递归扫描文件夹（含子文件夹）里的视频文件 */
export function scanVideoFiles(dir: string): string[] {
  const results: string[] = []
  const walk = (d: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && VIDEO_EXT.includes(extname(e.name).toLowerCase())) results.push(full)
    }
  }
  walk(dir)
  return results
}

/** 把选中的视频文件批量加入播放列表，返回新增数量 */
export function addFilesToPlaylist(files: string[]): { library: Library; added: number } {
  const lib = load()
  let added = 0
  for (const f of files) {
    if (!lib.playlist.some((e) => e.path === f)) {
      lib.playlist.unshift({ path: f, title: basename(f), addedAt: Date.now() })
      added++
    }
  }
  save(lib)
  return { library: lib, added }
}

/** 把文件夹（含子文件夹）里的视频批量加入播放列表，返回新增数量 */
export function addFolderToPlaylist(dir: string): { library: Library; added: number } {
  const files = scanVideoFiles(dir)
  const lib = load()
  let added = 0
  for (const f of files) {
    if (!lib.playlist.some((e) => e.path === f)) {
      lib.playlist.unshift({ path: f, title: basename(f), addedAt: Date.now() })
      added++
    }
  }
  save(lib)
  return { library: lib, added }
}
