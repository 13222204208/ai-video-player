export interface TranslateProgress {
  done: number
  total: number
}

export interface ModelLoadProgress {
  status: string
  file: string
  progress: number
}

interface WorkerMessage {
  type: string
  done?: number
  total?: number
  translations?: string[]
  message?: string
  status?: string
  file?: string
  progress?: number
}

let worker: Worker | null = null

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../worker/translate.worker.ts', import.meta.url), {
      type: 'module'
    })
  }
  return worker
}

/**
 * 调用翻译 Worker（NLLB-200 / transformers.js）。
 * 首次调用会自动下载模型（约 2.4GB，q8 量化更小），通过 onModelProgress 回传进度。
 */
export function translate(
  texts: string[],
  srcLang: string,
  tgtLang: string,
  callbacks: {
    onModelProgress?: (p: ModelLoadProgress) => void
    onProgress?: (p: TranslateProgress) => void
  } = {}
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const w = getWorker()
    const onMessage = (e: MessageEvent<WorkerMessage>): void => {
      const msg = e.data
      switch (msg.type) {
        case 'model-progress':
          callbacks.onModelProgress?.({
            status: msg.status ?? '',
            file: msg.file ?? '',
            progress: msg.progress ?? 0
          })
          break
        case 'progress':
          callbacks.onProgress?.({ done: msg.done ?? 0, total: msg.total ?? 0 })
          break
        case 'done':
          w.removeEventListener('message', onMessage)
          resolve(msg.translations ?? [])
          break
        case 'error':
          w.removeEventListener('message', onMessage)
          reject(new Error(msg.message ?? '翻译失败'))
          break
      }
    }
    w.addEventListener('message', onMessage)
    w.postMessage({ type: 'translate', texts, srcLang, tgtLang })
  })
}
