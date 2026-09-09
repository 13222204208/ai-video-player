import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import { getBinDir, platformArch } from './paths'

export interface FfmpegLog {
  type: 'stderr' | 'stdout'
  data: string
}

// ---- 转换（重封装/转码）进程跟踪，保证同一时刻只有一个在跑、支持取消 ----
let activeProc: ChildProcess | null = null
let convertGeneration = 0

/** 取消当前正在进行的转换：杀掉 ffmpeg，并使被取消的结果作废 */
export function cancelConvert(): void {
  convertGeneration++
  if (activeProc && !activeProc.killed) {
    activeProc.kill()
  }
}

function runConvert(
  args: string[],
  onLog?: (log: FfmpegLog) => void,
  failMsg?: (code: number | null) => string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = resolveFfmpeg()
    const gen = convertGeneration
    const proc = spawn(ffmpeg, args)
    activeProc = proc
    proc.stderr.on('data', (d: Buffer) => onLog?.({ type: 'stderr', data: d.toString() }))
    proc.on('error', (err) => reject(new Error(`无法启动 ffmpeg：${err.message}`)))
    proc.on('close', (code) => {
      if (activeProc === proc) activeProc = null
      if (gen !== convertGeneration) {
        reject(new Error('已取消'))
      } else if (code === 0) {
        resolve()
      } else {
        reject(new Error(failMsg ? failMsg(code) : `ffmpeg 失败（退出码 ${code}）`))
      }
    })
  })
}

export interface ProbeResult {
  videoCodec: string
  audioCodec: string
}

/** 用 ffmpeg -i 探测视频/音频编码（从 stderr 的 Stream 行解析） */
export function probeVideo(videoPath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const ffmpeg = resolveFfmpeg()
    const proc = spawn(ffmpeg, ['-hide_banner', '-i', videoPath])
    let out = ''
    proc.stderr.on('data', (d: Buffer) => {
      out += d.toString()
    })
    proc.on('error', (err) => reject(new Error(`无法启动 ffmpeg：${err.message}`)))
    // 只探测不输出，ffmpeg 会以非 0 退出码结束，但 Stream 信息已打印
    proc.on('close', () => {
      const v = /Video:\s*([a-zA-Z0-9_]+)/.exec(out)
      const a = /Audio:\s*([a-zA-Z0-9_]+)/.exec(out)
      resolve({
        videoCodec: v?.[1]?.toLowerCase() ?? '',
        audioCodec: a?.[1]?.toLowerCase() ?? ''
      })
    })
  })
}

export function resolveFfmpeg(): string {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN
  // 优先用随 app 打包的平台特定 ffmpeg 二进制（Windows 用 ffmpeg.exe）
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const local = join(getBinDir(), platformArch(), name)
  if (existsSync(local)) return local
  const inBin = join(getBinDir(), name)
  if (existsSync(inBin)) return inBin
  // 回退到 ffmpeg-static（打包后需修正 asar.unpacked 路径）
  if (!ffmpegStatic) {
    throw new Error('未找到 ffmpeg 二进制（ffmpeg-static 未就绪）')
  }
  return app.isPackaged ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked') : ffmpegStatic
}

/** 从视频抽取 16kHz 单声道 WAV（whisper.cpp 所需格式） */
export function extractAudio(
  videoPath: string,
  outWavPath: string,
  onLog?: (log: FfmpegLog) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = resolveFfmpeg()
    const args = [
      '-y',
      '-hide_banner',
      '-i',
      videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      outWavPath
    ]
    const proc = spawn(ffmpeg, args)
    proc.stderr.on('data', (d: Buffer) => onLog?.({ type: 'stderr', data: d.toString() }))
    proc.on('error', (err) => reject(new Error(`无法启动 ffmpeg：${err.message}`)))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 抽取音频失败（退出码 ${code}）`))
    })
  })
}

/** 无损（copy 流）重封装为 MP4，用于 Chromium 无法直接播放的容器（mkv/avi 等） */
export function remuxToMp4(
  videoPath: string,
  outMp4Path: string,
  onLog?: (log: FfmpegLog) => void
): Promise<void> {
  return runConvert(
    [
      '-y',
      '-hide_banner',
      '-i',
      videoPath,
      '-map',
      '0',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      outMp4Path
    ],
    onLog,
    (code) => `ffmpeg 转码失败（退出码 ${code}）。可能该视频的编码不被 MP4 容器支持。`
  )
}

/**
 * 重编码为 H.264 + AAC 的 MP4，用于 Chromium 无法解码的编码（HEVC/H.265、10bit、AV1 等）。
 * 任何 FFmpeg 能解码的格式都能转成可播放的 H.264。
 */
export function transcodeToH264(
  videoPath: string,
  outMp4Path: string,
  onLog?: (log: FfmpegLog) => void
): Promise<void> {
  return runConvert(
    [
      '-y',
      '-hide_banner',
      '-i',
      videoPath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      outMp4Path
    ],
    onLog,
    (code) => `ffmpeg 转码失败（退出码 ${code}）`
  )
}
