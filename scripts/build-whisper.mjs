/**
 * 编译 whisper.cpp 的 whisper-cli 二进制到 resources/bin/<platform-arch>/。
 *
 * 前置依赖：
 *   - git
 *   - cmake
 *   - C/C++ 编译器（macOS: Xcode CLT；Windows: Visual Studio Build Tools 或 MinGW）
 *
 * macOS（Apple Silicon）自动启用 Metal GPU；Windows 默认 CPU（如需 CUDA 参考 whisper.cpp 文档）。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cacheDir = join(root, '.cache', 'whisper.cpp')
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
    'https://github.com/ggerganov/whisper.cpp.git',
    cacheDir
  ])
} else {
  console.log('whisper.cpp 已存在，复用缓存')
}

// 2. cmake 配置（保留 examples 以编译 whisper-cli）
const configureArgs = ['-B', 'build', '-DCMAKE_BUILD_TYPE=Release']
if (platform === 'darwin') {
  configureArgs.push('-DGGML_METAL=ON')
}
configureArgs.push('-DWHISPER_BUILD_TESTS=OFF')
run('cmake', configureArgs, { cwd: cacheDir })

// 3. 编译
run('cmake', ['--build', 'build', '--config', 'Release', '-j'], { cwd: cacheDir })

// 4. 拷贝二进制（whisper-cli 用于整片识别，whisper-server 用于流式逐段识别）
mkdirSync(binDir, { recursive: true })
const releaseBin = isWin ? join(cacheDir, 'build', 'bin', 'Release') : join(cacheDir, 'build', 'bin')
const wanted = isWin ? ['whisper-cli.exe', 'whisper-server.exe'] : ['whisper-cli', 'whisper-server']

let copied = 0
for (const name of wanted) {
  const src = join(releaseBin, name)
  if (existsSync(src)) {
    copyFileSync(src, join(binDir, name))
    if (!isWin) chmodSync(join(binDir, name), 0o755)
    console.log(`\n✅ 已生成：${join(binDir, name)}`)
    copied++
  } else {
    console.warn(`⚠️  未找到 ${name}（不影响已拷贝的其他二进制）`)
  }
}
if (copied === 0) {
  throw new Error(`未在 ${releaseBin} 找到编译产物（whisper-cli / whisper-server）`)
}

// 5. 拷贝动态库并修正 rpath（macOS）——二进制是动态链接 ggml/whisper 的，
//    必须把 .dylib 一起放到旁边，并把 rpath 改成 @loader_path，否则打包后无法运行。
if (!isWin) {
  const absBuild = spawnSync('sh', ['-c', `cd "${releaseBin}" && pwd`], { encoding: 'utf8' })
    .stdout.trim()
  for (const name of readdirSync(releaseBin)) {
    if (name.endsWith('.dylib')) {
      const src = join(releaseBin, name)
      const dst = join(binDir, name)
      // 用 cp -a 保留符号链接（libggml.0.dylib -> libggml.0.22.0.dylib）
      spawnSync('cp', ['-a', src, dst], { stdio: 'inherit' })
    }
  }
  const targets = ['whisper-cli', 'whisper-server']
  for (const name of targets) {
    const p = join(binDir, name)
    if (existsSync(p)) {
      spawnSync('install_name_tool', ['-delete_rpath', absBuild, p], { stdio: 'ignore' })
      spawnSync('install_name_tool', ['-add_rpath', '@loader_path', p], { stdio: 'inherit' })
    }
  }
  for (const name of readdirSync(binDir)) {
    if (/\.[0-9]+\.[0-9]+\.dylib$/.test(name)) {
      const p = join(binDir, name)
      spawnSync('install_name_tool', ['-delete_rpath', absBuild, p], { stdio: 'ignore' })
      spawnSync('install_name_tool', ['-add_rpath', '@loader_path', p], { stdio: 'inherit' })
    }
  }
  console.log('✅ 已拷贝动态库并修正 rpath 为 @loader_path')
} else {
  // Windows：把 DLL（若存在）拷到 exe 旁，Windows 加载器会自动在同目录查找
  for (const name of readdirSync(releaseBin)) {
    if (name.endsWith('.dll')) copyFileSync(join(releaseBin, name), join(binDir, name))
  }
}
