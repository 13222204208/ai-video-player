// Electron 43+ 的 npm 包不再通过 postinstall 自动下载二进制（install.js 需手动执行）。
// 这里在 `pnpm install` / `npm install` 后自动补齐二进制，保证 `pnpm run dev` 可立即运行。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const installScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'electron', 'install.js')

if (!existsSync(installScript)) {
  // electron 尚未安装（例如首次安装中途），跳过即可
  process.exit(0)
}

// GitHub Releases 在国内直连经常超时，默认走 npmmirror 镜像；可通过 ELECTRON_MIRROR 覆盖
const mirror = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'

execFileSync(process.execPath, [installScript], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_MIRROR: mirror }
})
