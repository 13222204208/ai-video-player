/// <reference lib="webworker" />
import { pipeline, env } from '@huggingface/transformers'

// 单线程 WASM 后端：避免 onnxruntime 嵌套 worker 的打包/路径问题，更稳定
env.backends.onnx.wasm!.numThreads = 1
env.backends.onnx.wasm!.proxy = false

// 国内网络访问 huggingface.co 经常失败，改用镜像（路径完全一致）
env.remoteHost = 'https://hf-mirror.com'

const MODEL = 'Xenova/nllb-200-distilled-600M'

interface LoadProgress {
  status: string
  file?: string
  progress: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let translator: any = null

const post = (msg: unknown): void => (self as unknown as Worker).postMessage(msg)

interface TranslateRequest {
  type: 'translate'
  texts: string[]
  srcLang: string
  tgtLang: string
}

async function getTranslator(
  onProgress: (p: LoadProgress) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  if (!translator) {
    translator = await pipeline('translation', MODEL, {
      dtype: 'q8',
      progress_callback: (p) => {
        if (p.status === 'progress') {
          onProgress({ status: 'progress', file: p.file, progress: p.progress })
        } else if (p.status === 'initiate' || p.status === 'download') {
          onProgress({ status: p.status, file: p.file, progress: 0 })
        } else if (p.status === 'done') {
          onProgress({ status: 'done', file: p.file, progress: 100 })
        } else if (p.status === 'ready') {
          onProgress({ status: 'ready', file: p.model, progress: 100 })
        }
      }
    })
  }
  return translator
}

self.onmessage = async (e: MessageEvent<TranslateRequest>) => {
  const msg = e.data
  if (!msg || msg.type !== 'translate') return
  try {
    const { texts, srcLang, tgtLang } = msg
    const pipe = await getTranslator((p) => post({ type: 'model-progress', ...p }))

    const translations: string[] = []
    const GROUP = 4 // 每 N 句拼成一块整块翻译，块内句子共享上下文，翻译更连贯
    for (let i = 0; i < texts.length; i += GROUP) {
      const group = texts.slice(i, i + GROUP)
      let groupTranslations: string[] | null = null

      if (group.length > 1) {
        // 上下文整块翻译：用换行拼接，让模型在块内做跨句注意力
        try {
          const out = await pipe(group.join('\n'), { src_lang: srcLang, tgt_lang: tgtLang })
          const lines = (out[0].translation_text as string)
            .split('\n')
            .map((l: string) => l.trim())
            .filter((l: string) => l.length > 0)
          if (lines.length === group.length) {
            groupTranslations = lines
          }
        } catch {
          /* 行数不匹配则回退逐句翻译 */
        }
      }

      if (!groupTranslations) {
        const out = await pipe(group, { src_lang: srcLang, tgt_lang: tgtLang })
        groupTranslations = (out as Array<{ translation_text: string }>).map(
          (o) => o.translation_text
        )
      }

      translations.push(...groupTranslations)
      post({ type: 'progress', done: Math.min(i + GROUP, texts.length), total: texts.length })
    }
    post({ type: 'done', translations })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

export {}
