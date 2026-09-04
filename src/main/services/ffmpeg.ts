import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import { getBinDir, platformArch } from './paths'

export interface FfmpegLog {
  type: 'stderr' | 'stdout'
  data: string
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
  return new Promise((resolve, reject) => {
    const ffmpeg = resolveFfmpeg()
    const args = [
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
    ]
    const proc = spawn(ffmpeg, args)
    proc.stderr.on('data', (d: Buffer) => onLog?.({ type: 'stderr', data: d.toString() }))
    proc.on('error', (err) => reject(new Error(`无法启动 ffmpeg：${err.message}`)))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 转码失败（退出码 ${code}）。可能该视频的编码不被 MP4 容器支持。`))
    })
  })
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
  return new Promise((resolve, reject) => {
    const ffmpeg = resolveFfmpeg()
    const args = [
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
    ]
    const proc = spawn(ffmpeg, args)
    proc.stderr.on('data', (d: Buffer) => onLog?.({ type: 'stderr', data: d.toString() }))
    proc.on('error', (err) => reject(new Error(`无法启动 ffmpeg：${err.message}`)))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg 转码失败（退出码 ${code}）`))
    })
  })
}
