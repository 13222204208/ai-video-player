/**
 * 轻量能量 VAD（纯 JS，零依赖）。
 * 把连续的 16kHz 单声道 PCM 流按语音活动切成片段，供 whisper-server 逐段识别。
 *
 * 说明：这是基于 RMS 能量的简单 VAD，对纯人声效果尚可；若需更好的抗噪/音乐鲁棒性，
 * 可替换为 Silero VAD（onnxruntime）——本模块接口保持不变即可。
 */

export interface VadOptions {
  sampleRate?: number
  /** 帧长（毫秒） */
  frameMs?: number
  /** 触发语音所需的最短持续（毫秒） */
  minSpeechMs?: number
  /** 结束语音所需的静音持续（毫秒） */
  minSilenceMs?: number
  /** 语音前的预滚 padding（帧数） */
  padFrames?: number
  /** 单段最大时长（毫秒），超长强制切分 */
  maxSegmentMs?: number
  /** 判定语音的能量倍数（rms > noiseFloor * ratio） */
  energyRatio?: number
  /** 静音能量的绝对下限 */
  absoluteFloor?: number
}

export interface VadSegmentResult {
  /** 该片段 PCM 样本（Float32，-1..1） */
  samples: Float32Array
  /** 片段在整段音频中的起始样本索引 */
  startSample: number
  /** 结束样本索引 */
  endSample: number
}

function concatFloat(arrays: Float32Array[]): Float32Array {
  let total = 0
  for (const a of arrays) total += a.length
  const out = new Float32Array(total)
  let offset = 0
  for (const a of arrays) {
    out.set(a, offset)
    offset += a.length
  }
  return out
}

export class VadSegmenter {
  private sampleRate: number
  private frameSize: number
  private minSpeechFrames: number
  private minSilenceFrames: number
  private padFrames: number
  private maxSegmentFrames: number
  private energyRatio: number
  private absoluteFloor: number

  /** 语音前的预滚环形缓冲（最近 padFrames 帧） */
  private ring: Float32Array[] = []
  /** 当前累积的语音片段帧 */
  private segment: Float32Array[] = []
  /** 当前语音片段起始帧的绝对索引 */
  private segmentStartFrame = 0
  /** 从第一个候选语音帧开始累积的待定帧（含预滚） */
  private pending: Float32Array[] = []
  private candidateStartFrame = 0
  /** 已处理的完整帧总数 */
  private frameCounter = 0
  private inSpeech = false
  private onsetFrames = 0
  private onsetSilentFrames = 0
  private silenceRun = 0
  private noiseFloor = 0.008
  /** 不足一帧的残余样本（跨 chunk 累积，避免丢样本导致时间戳漂移） */
  private remainder = new Float32Array(0)

  constructor(opts: VadOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 16000
    this.frameSize = Math.round(((opts.frameMs ?? 30) / 1000) * this.sampleRate)
    this.minSpeechFrames = Math.max(1, Math.round((opts.minSpeechMs ?? 150) / (opts.frameMs ?? 30)))
    this.minSilenceFrames = Math.max(1, Math.round((opts.minSilenceMs ?? 600) / (opts.frameMs ?? 30)))
    this.padFrames = Math.max(0, opts.padFrames ?? 7)
    this.maxSegmentFrames = Math.round((opts.maxSegmentMs ?? 15000) / (opts.frameMs ?? 30))
    this.energyRatio = opts.energyRatio ?? 4
    this.absoluteFloor = opts.absoluteFloor ?? 1e-4
  }

  private rms(frame: Float32Array): number {
    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
    return Math.sqrt(sum / frame.length)
  }

  private threshold(): number {
    return Math.max(this.noiseFloor * this.energyRatio, this.absoluteFloor)
  }

  private pushRing(frame: Float32Array): void {
    this.ring.push(frame.slice())
    while (this.ring.length > this.padFrames) this.ring.shift()
  }

  /** 结束当前片段并返回 */
  private finishSegment(): VadSegmentResult {
    const samples = concatFloat(this.segment)
    const startSample = this.segmentStartFrame * this.frameSize
    const endSample = startSample + samples.length
    this.segment = []
    this.onsetFrames = 0
    this.silenceRun = 0
    return { samples, startSample, endSample }
  }

  private processFrame(frame: Float32Array, out: VadSegmentResult[]): void {
    const energy = this.rms(frame)
    const isSpeech = energy > this.threshold()

    // 用非语音帧缓慢估计噪声底
    if (!isSpeech) {
      this.noiseFloor = this.noiseFloor * 0.95 + energy * 0.05
    }

    if (!this.inSpeech) {
      if (isSpeech) {
        if (this.onsetFrames === 0) {
          // 第一个语音帧：捕获预滚（语音前的 ring）作为候选起点
          this.candidateStartFrame = this.frameCounter - this.ring.length
          this.pending = this.ring.slice()
        }
        this.pending.push(frame.slice())
        this.onsetFrames++
        this.onsetSilentFrames = 0
        if (this.onsetFrames >= this.minSpeechFrames) {
          // 触发语音：预滚 + 语音帧
          this.inSpeech = true
          this.segmentStartFrame = this.candidateStartFrame
          this.segment = this.pending
          this.pending = []
          this.silenceRun = 0
          this.onsetSilentFrames = 0
        }
      } else if (this.onsetFrames > 0) {
        // 容忍音节间的短静音（最多连续 2 帧），避免真实语音的停顿打断触发
        this.onsetSilentFrames++
        this.pending.push(frame.slice())
        if (this.onsetSilentFrames >= 3) {
          this.onsetFrames = 0
          this.pending = []
          this.onsetSilentFrames = 0
        }
      }
    } else {
      this.segment.push(frame.slice())
      if (isSpeech) {
        this.silenceRun = 0
      } else {
        this.silenceRun++
      }

      const tooLong = this.segment.length >= this.maxSegmentFrames
      const silenceEnd = this.silenceRun >= this.minSilenceFrames
      if (tooLong || silenceEnd) {
        out.push(this.finishSegment())
        this.inSpeech = false
      }
    }

    this.pushRing(frame)
    this.frameCounter++
  }

  /** 喂入 PCM 样本，返回已切分完成的语音片段 */
  push(chunk: Float32Array): VadSegmentResult[] {
    const out: VadSegmentResult[] = []
    const frameSize = this.frameSize

    // 拼上上一 chunk 的残余，避免丢样本
    let data: Float32Array
    if (this.remainder.length > 0) {
      data = new Float32Array(this.remainder.length + chunk.length)
      data.set(this.remainder, 0)
      data.set(chunk, this.remainder.length)
      this.remainder = new Float32Array(0)
    } else {
      data = chunk
    }

    let offset = 0
    while (offset + frameSize <= data.length) {
      const frame = data.subarray(offset, offset + frameSize)
      offset += frameSize
      this.processFrame(frame, out)
    }
    if (offset < data.length) {
      this.remainder = data.slice(offset)
    }
    return out
  }

  /** 流结束时冲刷最后一个未闭合的片段 */
  flush(): VadSegmentResult | null {
    if (this.inSpeech && this.segment.length > 0) {
      return this.finishSegment()
    }
    return null
  }
}
