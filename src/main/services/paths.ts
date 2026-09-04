import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

/** 平台-架构 标识，与 resources/bin 下的目录名一致 */
export function platformArch(): string {
  return `${process.platform}-${process.arch}`
}

/** whisper.cpp 二进制所在目录（打包后来自 extraResources -> resourcesPath/bin） */
export function getBinDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin')
    : join(app.getAppPath(), 'resources', 'bin')
}

/** 模型目录：开发时放项目内，打包后放 userData */
export function getModelsDir(): string {
  const dir = app.isPackaged
    ? join(app.getPath('userData'), 'models')
    : join(app.getAppPath(), 'resources', 'models')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 临时工作目录（音频抽取、转码产物） */
export function getTempDir(): string {
  const dir = join(app.getPath('temp'), 'local-ai-video-player')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 解析 whisper 二进制路径，按优先级：
 * 1. 环境变量 WHISPER_BIN
 * 2. resources/bin/<platform>/{whisper-cli,main}[.exe]
 * 3. 系统 PATH 里的 whisper-cli / main
 */
export function resolveWhisperBinary(): string {
  if (process.env.WHISPER_BIN && existsSync(process.env.WHISPER_BIN)) {
    return process.env.WHISPER_BIN
  }

  const names =
    process.platform === 'win32'
      ? ['whisper-cli.exe', 'main.exe', 'whisper.exe']
      : ['whisper-cli', 'main', 'whisper']

  const localDir = join(getBinDir(), platformArch())
  for (const n of names) {
    const p = join(localDir, n)
    if (existsSync(p)) return p
  }
  for (const n of names) {
    const p = join(getBinDir(), n)
    if (existsSync(p)) return p
  }
  // 回退到系统 PATH
  for (const n of names) {
    const found = findInPath(n)
    if (found) return found
  }

  throw new Error(
    [
      '未找到 whisper.cpp 二进制。',
      '请先运行 `pnpm run build:whisper` 编译，',
      `或将二进制放入 ${localDir} 目录，或设置 WHISPER_BIN 环境变量。`
    ].join('')
  )
}

/** 解析 whisper-server 二进制（流式逐段识别用） */
export function resolveWhisperServerBinary(): string {
  if (process.env.WHISPER_SERVER_BIN && existsSync(process.env.WHISPER_SERVER_BIN)) {
    return process.env.WHISPER_SERVER_BIN
  }
  const names = process.platform === 'win32' ? ['whisper-server.exe'] : ['whisper-server']
  const localDir = join(getBinDir(), platformArch())
  for (const n of names) {
    const p = join(localDir, n)
    if (existsSync(p)) return p
  }
  for (const n of names) {
    const p = join(getBinDir(), n)
    if (existsSync(p)) return p
  }
  for (const n of names) {
    const found = findInPath(n)
    if (found) return found
  }
  throw new Error(
    `未找到 whisper-server 二进制。请先运行 \`pnpm run build:whisper\`，或将二进制放入 ${localDir} 目录。`
  )
}

/** 解析 llama-server 二进制（本地 LLM 翻译用） */
export function resolveLlamaServerBinary(): string {
  if (process.env.LLAMA_SERVER_BIN && existsSync(process.env.LLAMA_SERVER_BIN)) {
    return process.env.LLAMA_SERVER_BIN
  }
  const names = process.platform === 'win32' ? ['llama-server.exe'] : ['llama-server']
  const localDir = join(getBinDir(), platformArch())
  for (const n of names) {
    const p = join(localDir, n)
    if (existsSync(p)) return p
  }
  for (const n of names) {
    const p = join(getBinDir(), n)
    if (existsSync(p)) return p
  }
  for (const n of names) {
    const found = findInPath(n)
    if (found) return found
  }
  throw new Error(
    `未找到 llama-server 二进制。请先运行 \`pnpm run build:llama\`，或将二进制放入 ${localDir} 目录。`
  )
}

function findInPath(name: string): string | null {
  const pathVar = process.env.PATH ?? ''
  for (const dir of pathVar.split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return null
}

export function ensureDirs(): void {
  getModelsDir()
  getTempDir()
  mkdirSync(join(getBinDir(), platformArch()), { recursive: true })
}
