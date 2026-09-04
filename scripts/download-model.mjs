/**
 * 下载 whisper ggml 模型到 resources/models/。
 * 用法：node scripts/download-model.mjs [tiny|base|small|medium|large-v3-turbo|large-v3]
 */
import { createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const modelsDir = join(root, 'resources', 'models')
const name = process.argv[2] || 'small'
// 优先国内镜像，失败自动回退官方站
const bases = (process.env.HF_ENDPOINT || process.env.HF_MIRROR)
  ? [(process.env.HF_ENDPOINT || process.env.HF_MIRROR).replace(/\/+$/, '')]
  : ['https://hf-mirror.com', 'https://huggingface.co']
const dest = join(modelsDir, `ggml-${name}.bin`)

mkdirSync(modelsDir, { recursive: true })
if (existsSync(dest)) {
  console.log('已存在：', dest)
  process.exit(0)
}

// 依次尝试镜像 / 官方站
let res = null
for (const base of bases) {
  const url = `${base}/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`
  console.log('尝试下载：', url)
  try {
    const r = await fetch(url)
    if (r.ok && r.body) {
      res = r
      break
    }
    console.warn('  失败：HTTP', r.status)
  } catch (e) {
    console.warn('  失败：', e.message)
  }
}
if (!res) {
  console.error('所有源均下载失败。可尝试设置：HF_ENDPOINT=https://hf-mirror.com')
  process.exit(1)
}
const total = Number(res.headers.get('content-length') ?? 0)
let received = 0
const sink = createWriteStream(dest + '.part')

await new Promise((resolve, reject) => {
  const reader = res.body.getReader()
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (!sink.write(Buffer.from(value))) {
          await new Promise((r) => sink.once('drain', r))
        }
        if (total) {
          process.stdout.write(
            `\r${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`
          )
        }
      }
      sink.end()
      resolve()
    } catch (e) {
      sink.destroy()
      reject(e)
    }
  }
  void pump()
})

renameSync(dest + '.part', dest)
console.log('\n✅ 完成：', dest)
