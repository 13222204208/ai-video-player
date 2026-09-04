/**
 * 编译 llama.cpp 的 llama-server 二进制到 resources/bin/<platform-arch>/。
 * 用于本地 LLM 翻译（Qwen 等），提供 OpenAI 兼容的 /v1/chat/completions 接口。
 *
 * 前置依赖：git、cmake、C/C++ 编译器（macOS: Xcode CLT；Windows: VS Build Tools 或 MinGW）
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cacheDir = join(root, '.cache', 'llama.cpp')
const platform = process.platform
const arch = process.arch
const isWin = platform === 'win32'
const binDir = join(root, 'resources', 'bin', `${platform}-${arch}`)

function run(cmd, args, opts = {}) {
  console.log('>', cmd, args.join(' '))
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin, ...opts })
  if (r.error) throw new Error(`无法执行 ${cmd}：${r.error.message}`)
  if (r.status !== 0) throw new Error(`${cmd} 退出码 ${r.status}`)
}

// 1. 克隆（浅克隆 + 子模块 ggml）
if (!existsSync(join(cacheDir, 'CMakeLists.txt'))) {
  run('git', [
    'clone',
    '--depth',
    '1',
    '--recurse-submodules',
    '--shallow-submodules',
    'https://github.com/ggml-org/llama.cpp.git',
    cacheDir
  ])
} else {
  console.log('llama.cpp 已存在，复用缓存')
}

// 2. cmake 配置
const configureArgs = ['-B', 'build', '-DCMAKE_BUILD_TYPE=Release']
if (platform === 'darwin') {
  configureArgs.push('-DGGML_METAL=ON')
}
configureArgs.push('-DLLAMA_BUILD_TESTS=OFF')
run('cmake', configureArgs, { cwd: cacheDir })

// 3. 只编译 llama-server（省时）
const serverTarget = 'llama-server'
run('cmake', ['--build', 'build', '--config', 'Release', '-j', '--target', serverTarget], {
  cwd: cacheDir
})

// 4. 拷贝二进制
mkdirSync(binDir, { recursive: true })
const releaseBin = isWin ? join(cacheDir, 'build', 'bin', 'Release') : join(cacheDir, 'build', 'bin')
const binName = isWin ? 'llama-server.exe' : 'llama-server'
const src = join(releaseBin, binName)
if (!existsSync(src)) {
  throw new Error(`未找到编译产物 ${src}`)
}
copyFileSync(src, join(binDir, binName))
if (!isWin) chmodSync(join(binDir, binName), 0o755)
console.log(`\n✅ 已生成：${join(binDir, binName)}`)

// 5. 拷贝动态库并修正 rpath（macOS）
if (!isWin) {
  const absBuild = spawnSync('sh', ['-c', `cd "${releaseBin}" && pwd`], { encoding: 'utf8' }).stdout.trim()
  for (const name of readdirSync(releaseBin)) {
    if (name.endsWith('.dylib')) {
      spawnSync('cp', ['-a', join(releaseBin, name), join(binDir, name)], { stdio: 'inherit' })
    }
  }
  const p = join(binDir, binName)
  spawnSync('install_name_tool', ['-delete_rpath', absBuild, p], { stdio: 'ignore' })
  spawnSync('install_name_tool', ['-add_rpath', '@loader_path', p], { stdio: 'inherit' })
  for (const name of readdirSync(binDir)) {
    if (/\.[0-9]+\.[0-9]+\.dylib$/.test(name)) {
      const dp = join(binDir, name)
      spawnSync('install_name_tool', ['-delete_rpath', absBuild, dp], { stdio: 'ignore' })
      spawnSync('install_name_tool', ['-add_rpath', '@loader_path', dp], { stdio: 'inherit' })
    }
  }
  console.log('✅ 已拷贝动态库并修正 rpath 为 @loader_path')
} else {
  for (const name of readdirSync(releaseBin)) {
    if (name.endsWith('.dll')) copyFileSync(join(releaseBin, name), join(binDir, name))
  }
}
