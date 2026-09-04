/**
 * 对已打包的 .app 做 ad-hoc 签名（免费、零依赖）。
 * 作用：把 bundle 正确密封（绑定 Info.plist、密封资源、写入正确的 bundle id），
 * 使应用在 Apple Silicon 上稳定运行。注意：ad-hoc 签名不能消除分发给他人时的
 * Gatekeeper「无法验证开发者」提示（那需要 $99/年的 Developer ID + 公证）。
 *
 * 用法：node scripts/adhoc-sign.mjs [app路径]
 * 默认：dist/mac-arm64/LocalAIVideoPlayer.app
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// 自动检测 dist/mac-arm64 下的 .app（若指定了路径则优先）
function defaultAppPath() {
  const dir = join(root, 'dist', 'mac-arm64')
  const found = readdirSync(dir).find((n) => n.endsWith('.app'))
  return found ? join(dir, found) : join(dir, 'AIVideoPlayer.app')
}
const appPath = resolve(process.argv[2] ?? defaultAppPath())

if (!existsSync(appPath)) {
  console.error(`未找到 .app：${appPath}\n请先运行 pnpm run build:mac:adhoc 或 electron-builder --mac --dir`)
  process.exit(1)
}

console.log('ad-hoc 签名：', appPath)
try {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit'
  })
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=1', appPath], {
    stdio: 'inherit'
  })
  console.log('\n✅ ad-hoc 签名完成，签名状态：')
  execFileSync('codesign', ['-dv', appPath], { stdio: 'inherit' })
} catch (err) {
  console.error('ad-hoc 签名失败：', err.message)
  process.exit(1)
}
