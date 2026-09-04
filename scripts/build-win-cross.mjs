/**
 * 在 macOS/Linux 上用 llvm-mingw 交叉编译 Windows 版 whisper.cpp + llama.cpp 二进制。
 * 产物输出到 resources/bin/win32-x64/。
 *
 * 前置：先下载 llvm-mingw（macOS 通用版）到 .cache/llvm-mingw.tar.xz：
 *   https://github.com/mstorsjo/llvm-mingw/releases
 *
 * 注意：交叉编译产物为 CPU 版（无 CUDA/Metal），是可行的 Windows 分发方案，
 * 但要获得 GPU 加速仍需在 Windows 上用 MSVC/CUDA 原生编译。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cacheDir = join(root, '.cache')
const mingwDir = join(cacheDir, 'llvm-mingw')
const binDir = join(root, 'resources', 'bin', 'win32-x64')

function run(cmd, args, opts = {}) {
  console.log('>', cmd, args.join(' '))
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.error) throw new Error(`无法执行 ${cmd}：${r.error.message}`)
  if (r.status !== 0) throw new Error(`${cmd} 退出码 ${r.status}`)
}

// 1. 解压 llvm-mingw
if (!existsSync(join(mingwDir, 'bin', 'x86_64-w64-mingw32-clang'))) {
  const tarball = join(cacheDir, 'llvm-mingw.tar.xz')
  if (!existsSync(tarball)) {
    throw new Error(
      '未找到 .cache/llvm-mingw.tar.xz。请先下载：\n' +
        '  curl -L -o .cache/llvm-mingw.tar.xz https://github.com/mstorsjo/llvm-mingw/releases/download/20260826/llvm-mingw-20260826-ucrt-macos-universal.tar.xz'
    )
  }
  mkdirSync(mingwDir, { recursive: true })
  run('tar', ['-xf', tarball, '-C', mingwDir, '--strip-components=1'])
  console.log('✅ llvm-mingw 已解压')
}

// 2. 写 CMake toolchain 文件
const toolchain = join(cacheDir, 'win-toolchain.cmake')
writeFileSync(
  toolchain,
  [
    'set(CMAKE_SYSTEM_NAME Windows)',
    'set(CMAKE_SYSTEM_PROCESSOR x86_64)',
    `set(MINGW_PREFIX "${mingwDir}/bin/x86_64-w64-mingw32-")`,
    'set(CMAKE_C_COMPILER "${MINGW_PREFIX}clang")',
    'set(CMAKE_CXX_COMPILER "${MINGW_PREFIX}clang++")',
    'set(CMAKE_RC_COMPILER "${MINGW_PREFIX}windres")',
    'set(CMAKE_AR "${MINGW_PREFIX}llvm-ar")',
    'set(CMAKE_RANLIB "${MINGW_PREFIX}llvm-ranlib")',
    `set(CMAKE_FIND_ROOT_PATH "${mingwDir}")`,
    'set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)',
    'set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)',
    'set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)',
    'set(CMAKE_EXE_LINKER_FLAGS "-fuse-ld=lld")',
    ''
  ].join('\n')
)

const commonCmake = ['-DCMAKE_TOOLCHAIN_FILE=' + toolchain, '-DCMAKE_BUILD_TYPE=Release', '-DGGML_NATIVE=OFF']

// 3. 交叉编译 whisper.cpp
const whisperSrc = join(cacheDir, 'whisper.cpp')
if (!existsSync(join(whisperSrc, 'CMakeLists.txt'))) {
  run('git', [
    'clone', '--depth', '1', '--recurse-submodules', '--shallow-submodules',
    'https://github.com/ggerganov/whisper.cpp.git', whisperSrc
  ])
}
// 修补：common.cpp 在 libc++（llvm-mingw）下缺少 <algorithm>
{
  const commonCpp = join(whisperSrc, 'examples', 'common.cpp')
  let c = readFileSync(commonCpp, 'utf8')
  if (!c.includes('#include <algorithm>')) {
    c = c.replace('#include "common.h"', '#include "common.h"\n\n#include <algorithm>')
    writeFileSync(commonCpp, c)
    console.log('✅ 已修补 common.cpp（添加 <algorithm>）')
  }
}
run('cmake', ['-B', 'build-win', ...commonCmake, '-DWHISPER_BUILD_TESTS=OFF'], { cwd: whisperSrc })
run('cmake', ['--build', 'build-win', '--config', 'Release', '-j', '--target', 'whisper-cli', 'whisper-server'], { cwd: whisperSrc })

// 4. 交叉编译 llama.cpp
const llamaSrc = join(cacheDir, 'llama.cpp')
if (!existsSync(join(llamaSrc, 'CMakeLists.txt'))) {
  run('git', [
    'clone', '--depth', '1', '--recurse-submodules', '--shallow-submodules',
    'https://github.com/ggml-org/llama.cpp.git', llamaSrc
  ])
}
const winVerFlags = ['-DCMAKE_C_FLAGS=-D_WIN32_WINNT=0x0A00', '-DCMAKE_CXX_FLAGS=-D_WIN32_WINNT=0x0A00']
run('cmake', ['-B', 'build-win', ...commonCmake, ...winVerFlags, '-DLLAMA_BUILD_TESTS=OFF'], { cwd: llamaSrc })
run('cmake', ['--build', 'build-win', '--config', 'Release', '-j', '--target', 'llama-server'], { cwd: llamaSrc })

// 5. 拷贝二进制 + DLL 到 resources/bin/win32-x64/
mkdirSync(binDir, { recursive: true })
function copyTree(srcDir) {
  for (const name of readdirSync(srcDir)) {
    if (name.endsWith('.exe') || name.endsWith('.dll')) {
      copyFileSync(join(srcDir, name), join(binDir, name))
    }
  }
}
copyTree(join(whisperSrc, 'build-win', 'bin'))
copyTree(join(llamaSrc, 'build-win', 'bin'))

console.log('\n✅ Windows 二进制已生成：', binDir)
for (const name of readdirSync(binDir)) console.log('  -', name)
