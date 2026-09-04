<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type {
  Library,
  ModelProgress,
  PipelineProgress,
  StreamProgress,
  SubtitleSegment,
  WhisperModelInfo
} from '@shared/types'
import { NLLB_LANG, PLAYABLE_EXT } from '@shared/types'
import DropZone from './components/DropZone.vue'
import VideoPlayer from './components/VideoPlayer.vue'
import ControlPanel from './components/ControlPanel.vue'

interface LoadedVideo {
  path: string
  url: string
  needsRemux: boolean
}

const video = ref<LoadedVideo | null>(null)
const segments = ref<SubtitleSegment[]>([])
const detectedLanguage = ref<string | null>(null)

const models = ref<WhisperModelInfo[]>([])
const selectedModel = ref('large-v3-turbo')
const mode = ref<'stream' | 'batch'>('stream')

const running = ref(false)
const translating = ref(false)
const downloading = ref<ModelProgress | null>(null)
const remuxing = ref(false)
const transcoding = ref(false)
const transcodePercent = ref(0)

// 播放进度（记住上次位置）
const initialTime = ref(0)
let currentVideoTime = 0
let lastSavedTime = -1
// 有已保存字幕时自动播放；无字幕则保持暂停（图标应为 ▶）
const shouldAutoplay = ref(false)
// 精简模式：只显示视频 + 字幕，隐藏侧栏/控制面板/状态栏
const minimalMode = ref(false)

const pipelineState = ref<PipelineProgress>({ stage: 'idle', message: '', percent: 0 })
const streamState = ref<StreamProgress>({ status: 'listening', message: '', percent: 0 })

// LLM 翻译模型状态
const llmModelReady = ref(false)
const llmLoading = ref(false)

// 播放列表 / 历史记录
const library = ref<Library>({ playlist: [], history: [], progress: {} })
const sidebarTab = ref<'playlist' | 'history'>('playlist')

const error = ref<string | null>(null)
const statusMsg = ref('')

// 流式日志（whisper-server / ffmpeg 输出），便于排查
const streamLogs = ref<string[]>([])
const showStreamLog = ref(false)

// 翻译队列（逐段串行，避免并发调用 worker）
let translateChain: Promise<void> = Promise.resolve()

function mediaUrl(path: string): string {
  return 'media://f/' + encodeURIComponent(path)
}

function extOf(path: string): string {
  const i = path.lastIndexOf('.')
  return i >= 0 ? path.slice(i).toLowerCase() : ''
}

function resetResults(): void {
  segments.value = []
  detectedLanguage.value = null
  error.value = null
  statusMsg.value = ''
  pipelineState.value = { stage: 'idle', message: '', percent: 0 }
  streamState.value = { status: 'listening', message: '', percent: 0 }
  translateChain = Promise.resolve()
  translateBuf = []
  lastContext = []
  if (translateTimer) {
    clearTimeout(translateTimer)
    translateTimer = null
  }
}

/** 根据 whisper 检测到的语言映射 NLLB 源语言码；未知则默认日语 */
function srcLangCode(): string {
  return NLLB_LANG[detectedLanguage.value ?? ''] ?? 'jpn_Jpan'
}

/**
 * 用本地 LLM（Qwen）翻译一组句子，带上一组原文作为上下文。
 * 句数多时内部按每 5 句分块、滑动传递上下文。
 */
async function llmTranslateBatch(
  lines: string[],
  srcLang: string,
  context: string[] = []
): Promise<string[]> {
  const GROUP = 5
  const out: string[] = []
  let ctx = context
  for (let i = 0; i < lines.length; i += GROUP) {
    const group = lines.slice(i, i + GROUP)
    const t = await window.api.llmTranslate({ lines: group, srcLang, context: ctx })
    out.push(...t)
    ctx = group
  }
  return out
}

/** 流式翻译缓冲：攒几条一起翻，让相邻句共享上下文 */
let translateBuf: { idx: number; text: string }[] = []
let translateTimer: ReturnType<typeof setTimeout> | null = null
let lastContext: string[] = []

function flushTranslate(): void {
  if (translateTimer) {
    clearTimeout(translateTimer)
    translateTimer = null
  }
  if (!translateBuf.length) return
  const batch = translateBuf
  translateBuf = []
  const idxs = batch.map((b) => b.idx)
  const texts = batch.map((b) => b.text)
  const ctx = lastContext
  translateChain = translateChain.then(async () => {
    try {
      llmLoading.value = true
      const translations = await llmTranslateBatch(texts, srcLangCode(), ctx)
      translations.forEach((t, j) => {
        if (idxs[j] != null && segments.value[idxs[j]]) {
          segments.value[idxs[j]].translation = t
        }
      })
      lastContext = texts
    } catch {
      /* 翻译失败不阻断 */
    } finally {
      llmLoading.value = false
    }
  })
}

/** 把一条字幕加入翻译队列（缓冲 + 串行） */
function queueTranslate(idx: number, text: string): void {
  translateBuf.push({ idx, text })
  if (translateBuf.length >= 3) {
    flushTranslate()
  } else if (!translateTimer) {
    translateTimer = setTimeout(flushTranslate, 1500)
  }
}

function titleOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** 播放器时间更新：节流保存进度（每 5 秒一次） */
function onPlayerTime(t: number): void {
  currentVideoTime = t
  if (!video.value) return
  if (Math.abs(t - lastSavedTime) >= 5) {
    lastSavedTime = t
    void window.api.saveProgress(video.value.path, t)
  }
}

/** 保存当前视频的播放进度（切换/关闭前调用） */
function saveCurrentProgress(): void {
  if (!video.value || currentVideoTime <= 0) return
  try {
    void window.api.saveProgress(video.value.path, currentVideoTime)
  } catch {
    /* 忽略 */
  }
}

/** 打开视频后：自动加入历史 + 播放列表，加载进度和上次保存的字幕 */
async function afterVideoOpened(path: string): Promise<void> {
  try {
    library.value = await window.api.addToHistory(path, titleOf(path))
    library.value = await window.api.addToPlaylist(path, titleOf(path))
    initialTime.value = await window.api.getProgress(path)
    currentVideoTime = 0
    lastSavedTime = -1
    const saved = await window.api.loadSavedSubtitles(path)
    if (saved) {
      segments.value = saved
      statusMsg.value = '已加载上次保存的字幕，无需重新识别'
      shouldAutoplay.value = true
    } else {
      shouldAutoplay.value = false
    }
  } catch {
    /* 忽略 */
  }
}

function setVideoFromPath(path: string): void {
  saveCurrentProgress()
  shouldAutoplay.value = false
  const needsRemux = !PLAYABLE_EXT.includes(extOf(path))
  video.value = { path, url: needsRemux ? '' : mediaUrl(path), needsRemux }
  resetResults()
  void afterVideoOpened(path)
}

function onDropped(file: File): void {
  try {
    const path = window.api.getPathForFile(file)
    saveCurrentProgress()
    shouldAutoplay.value = false
    const needsRemux = !PLAYABLE_EXT.includes(extOf(path))
    video.value = { path, url: needsRemux ? '' : URL.createObjectURL(file), needsRemux }
    resetResults()
    void afterVideoOpened(path)
  } catch (e) {
    error.value = '无法读取文件路径：' + (e instanceof Error ? e.message : String(e))
  }
}

async function openDialog(): Promise<void> {
  const path = await window.api.openVideoDialog()
  if (path) setVideoFromPath(path)
}

// ---- 播放列表 / 历史 ----
async function loadLibrary(): Promise<void> {
  try {
    library.value = await window.api.getLibrary()
  } catch {
    /* 忽略 */
  }
}

function playPath(path: string): void {
  setVideoFromPath(path)
}

async function addFiles(): Promise<void> {
  try {
    const res = await window.api.addVideoFiles()
    if (!res) return
    library.value = res.library
    statusMsg.value = res.added > 0 ? `已添加 ${res.added} 个视频到播放列表` : '所选视频已在播放列表中'
  } catch {
    /* 忽略 */
  }
}

async function addFolder(): Promise<void> {
  try {
    const res = await window.api.addFolderToPlaylist()
    if (!res) return
    library.value = res.library
    statusMsg.value =
      res.added > 0 ? `已从文件夹添加 ${res.added} 个视频到播放列表` : '文件夹中没有新的视频文件'
  } catch {
    /* 忽略 */
  }
}

async function removePlaylist(path: string): Promise<void> {
  try {
    library.value = await window.api.removeFromPlaylist(path)
  } catch {
    /* 忽略 */
  }
}

async function clearHistoryList(): Promise<void> {
  try {
    library.value = await window.api.clearHistory()
  } catch {
    /* 忽略 */
  }
}

/** 自动保存字幕（生成完成后调用，下次打开无需重新识别） */
async function autoSaveSubtitles(): Promise<void> {
  if (!video.value || !segments.value.length) return
  try {
    await window.api.saveSubtitles({
      videoPath: video.value.path,
      segments: segments.value.map((s) => ({
        index: s.index,
        start: s.start,
        end: s.end,
        text: s.text,
        translation: s.translation
      }))
    })
    statusMsg.value = '字幕已自动保存'
  } catch {
    /* 忽略自动保存失败 */
  }
}

async function loadModels(): Promise<void> {
  try {
    models.value = await window.api.listModels()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function onDownload(name: string): Promise<void> {
  downloading.value = { name, percent: 0, message: '开始下载' }
  try {
    await window.api.downloadModel(name)
    await loadModels()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    downloading.value = null
  }
}

async function checkLlmStatus(): Promise<void> {
  try {
    const status = await window.api.llmStatus()
    llmModelReady.value = status.modelExists
  } catch {
    /* 忽略 */
  }
}

async function downloadLlm(): Promise<void> {
  downloading.value = { name: 'qwen2.5-7b', percent: 0, message: '开始下载（约 4.4GB）' }
  try {
    await window.api.downloadLlmModel()
    await checkLlmStatus()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    downloading.value = null
  }
}

/** 批量模式：抽整段音频 -> 识别 -> 批量翻译 */
async function runBatch(): Promise<void> {
  if (!video.value || video.value.needsRemux) return
  running.value = true
  try {
    const res = await window.api.runPipeline(video.value.path, {
      model: selectedModel.value,
      language: 'auto'
    })
    detectedLanguage.value = res.detectedLanguage
    segments.value = res.segments

    if (res.segments.length === 0) {
      statusMsg.value = '未识别到语音内容'
      return
    }

    translating.value = true
    llmLoading.value = true
    const texts = res.segments.map((s) => s.text)
    const translations = await llmTranslateBatch(texts, srcLangCode())
    segments.value = res.segments.map((s, i) => ({ ...s, translation: translations[i] }))
    await autoSaveSubtitles()
  } finally {
    running.value = false
    translating.value = false
    llmLoading.value = false
  }
}

/** 流式模式：边识别边出字幕，逐段翻译 */
async function runStream(): Promise<void> {
  if (!video.value || video.value.needsRemux) return
  running.value = true
  try {
    const res = await window.api.startStreaming(video.value.path, {
      model: selectedModel.value,
      language: 'auto'
    })
    detectedLanguage.value = res.detectedLanguage || detectedLanguage.value
    statusMsg.value =
      res.segmentCount === 0
        ? '未检测到语音：请确认视频有音轨；若是纯音乐/环境音或噪声很大，也可能切不出语音片段'
        : `识别完成，共 ${res.segmentCount} 句`
    // 等翻译队列全部完成，再自动保存（下次打开直接加载，无需重新识别）
    await translateChain
    if (segments.value.length > 0) await autoSaveSubtitles()
  } finally {
    running.value = false
  }
}

async function generate(): Promise<void> {
  if (!video.value || video.value.needsRemux) return
  error.value = null
  statusMsg.value = ''
  segments.value = []
  detectedLanguage.value = null
  translateChain = Promise.resolve()
  translateBuf = []
  if (translateTimer) {
    clearTimeout(translateTimer)
    translateTimer = null
  }
  try {
    if (mode.value === 'stream') await runStream()
    else await runBatch()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('已取消')) statusMsg.value = '已取消'
    else error.value = msg
  }
}

function cancel(): void {
  if (mode.value === 'stream') void window.api.cancelStreaming()
  else void window.api.cancelPipeline()
}

async function exportSubtitles(): Promise<void> {
  if (!video.value || !segments.value.length) return
  try {
    const { srtPath, vttPath } = await window.api.saveSubtitles({
      videoPath: video.value.path,
      // 转成普通对象，避免 Vue 响应式 Proxy 无法被 IPC 结构化克隆
      segments: segments.value.map((s) => ({
        index: s.index,
        start: s.start,
        end: s.end,
        text: s.text,
        translation: s.translation
      }))
    })
    statusMsg.value = `已导出：${srtPath} 和 ${vttPath}`
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function remux(): Promise<void> {
  if (!video.value) return
  remuxing.value = true
  error.value = null
  try {
    const { outputPath } = await window.api.remuxVideo(video.value.path)
    video.value = { path: outputPath, url: mediaUrl(outputPath), needsRemux: false }
    statusMsg.value = '已无损转为 MP4，可以生成字幕了'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    remuxing.value = false
  }
}

/** 转码为 H.264：支持所有 FFmpeg 能解码的格式（HEVC/10bit/AV1 等） */
async function transcode(): Promise<void> {
  if (!video.value) return
  transcoding.value = true
  transcodePercent.value = 0
  error.value = null
  try {
    const { outputPath } = await window.api.transcodeVideo(video.value.path)
    video.value = { path: outputPath, url: mediaUrl(outputPath), needsRemux: false }
    statusMsg.value = '已转码为 H.264 MP4，可以播放和生成字幕了'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    transcoding.value = false
  }
}

function toggleMinimal(): void {
  minimalMode.value = !minimalMode.value
}

function onAppKeydown(e: KeyboardEvent): void {
  // Esc 退出精简模式（也支持 M 键快速切换）
  if (e.key === 'Escape' && minimalMode.value) {
    minimalMode.value = false
  } else if ((e.key === 'm' || e.key === 'M') && video.value && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
    minimalMode.value = !minimalMode.value
  }
}

function onWindowDrop(e: DragEvent): void {
  e.preventDefault()
  const f = e.dataTransfer?.files?.[0]
  if (f) onDropped(f)
}
function onWindowDragOver(e: DragEvent): void {
  e.preventDefault()
}

const unsubscribers: Array<() => void> = []

onMounted(() => {
  void loadModels()
  void checkLlmStatus()
  void loadLibrary()
  window.addEventListener('dragover', onWindowDragOver)
  window.addEventListener('drop', onWindowDrop)
  window.addEventListener('keydown', onAppKeydown)
  unsubscribers.push(window.api.onPipelineProgress((p) => (pipelineState.value = p)))
  unsubscribers.push(window.api.onModelProgress((p) => (downloading.value = p)))
  unsubscribers.push(window.api.onStreamProgress((p) => (streamState.value = p)))
  unsubscribers.push(
    window.api.onStreamSegment((seg) => {
      const idx = segments.value.length
      segments.value.push({ index: seg.index, start: seg.start, end: seg.end, text: seg.text })
      queueTranslate(idx, seg.text)
    })
  )
  unsubscribers.push(
    window.api.onStreamLog((line) => {
      const t = line.trim()
      if (!t) return
      streamLogs.value.push(t)
      if (streamLogs.value.length > 200) streamLogs.value.shift()
    })
  )
  // 转码进度：解析 ffmpeg stderr 的 Duration / time
  let transcodeDuration = 0
  unsubscribers.push(
    window.api.onTranscodeLog(({ data }) => {
      const dm = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(data)
      if (dm && transcodeDuration === 0) {
        transcodeDuration = +dm[1] * 3600 + +dm[2] * 60 + +dm[3]
      }
      const tm = /time=\s*(\d+):(\d+):(\d+\.?\d*)/.exec(data)
      if (tm && transcodeDuration > 0) {
        const cur = +tm[1] * 3600 + +tm[2] * 60 + +tm[3]
        transcodePercent.value = Math.min(100, Math.round((cur / transcodeDuration) * 100))
      }
    })
  )
})

onBeforeUnmount(() => {
  saveCurrentProgress()
  window.removeEventListener('dragover', onWindowDragOver)
  window.removeEventListener('drop', onWindowDrop)
  window.removeEventListener('keydown', onAppKeydown)
  unsubscribers.forEach((u) => u())
})

const hasSegments = computed(() => segments.value.length > 0)
const busy = computed(
  () =>
    running.value || translating.value || remuxing.value || transcoding.value || !!downloading.value
)
</script>

<template>
  <div class="app">
    <div class="content">
      <aside v-show="!minimalMode" class="sidebar">
        <div class="sidebar-tabs">
            <button
              class="tab"
              :class="{ active: sidebarTab === 'playlist' }"
              @click="sidebarTab = 'playlist'"
            >
              播放列表
            </button>
            <button
              class="tab"
              :class="{ active: sidebarTab === 'history' }"
              @click="sidebarTab = 'history'"
            >
              历史记录
            </button>
          </div>

          <div v-if="sidebarTab === 'playlist'" class="sidebar-body">
            <button class="sidebar-action" @click="addFiles">🎬 添加视频文件</button>
            <button class="sidebar-action" @click="addFolder">📁 添加文件夹（含子文件夹）</button>
            <div v-if="!library.playlist.length" class="sidebar-empty">播放列表为空</div>
            <div v-for="e in library.playlist" :key="e.path" class="sidebar-item">
              <div class="sidebar-item-title" :title="e.path" @click="playPath(e.path)">
                {{ e.title }}
              </div>
              <button class="sidebar-item-x" title="移除" @click="removePlaylist(e.path)">✕</button>
            </div>
          </div>

          <div v-if="sidebarTab === 'history'" class="sidebar-body">
            <button v-if="library.history.length" class="sidebar-action" @click="clearHistoryList">
              清空历史
            </button>
            <div v-if="!library.history.length" class="sidebar-empty">暂无历史</div>
            <div v-for="e in library.history" :key="e.path" class="sidebar-item">
              <div class="sidebar-item-title" :title="e.path" @click="playPath(e.path)">
                {{ e.title }}
              </div>
            </div>
          </div>
        </aside>

        <div class="player-area">
          <template v-if="!video">
            <DropZone @browse="openDialog" />
          </template>
          <template v-else>
      <ControlPanel
        v-show="!minimalMode"
        :models="models"
        v-model:selected-model="selectedModel"
        v-model:mode="mode"
        :running="running"
        :translating="translating"
        :has-segments="hasSegments"
        :needs-remux="video.needsRemux"
        :detected-language="detectedLanguage"
        :download-state="downloading"
        :llm-model-ready="llmModelReady"
        :disabled="video.needsRemux"
        @download="onDownload"
        @download-llm="downloadLlm"
        @generate="generate"
        @cancel="cancel"
        @export="exportSubtitles"
        @remux="remux"
        @toggle-minimal="toggleMinimal"
      />

      <main class="main">
        <VideoPlayer
          v-if="!video.needsRemux"
          :src="video.url"
          :segments="segments"
          :title="video.path.split('/').pop()"
          :initial-time="initialTime"
          :autoplay="shouldAutoplay"
          :minimal="minimalMode"
          @time="onPlayerTime"
          @error="error = $event"
        />
        <div v-else class="remux-hint">
          <div class="remux-hint-icon">⚠️</div>
          <p>该视频是 <b>{{ extOf(video.path).slice(1).toUpperCase() }}</b> 容器，浏览器内核无法直接播放。</p>
          <p class="dim">
            若内部是 H.264 编码：点「无损转 MP4」（秒完成）。<br />
            若内部是 HEVC/H.265 / 10bit / AV1 等：点「转码为 H.264」（重编码，较慢但支持所有格式）。
          </p>
          <div class="remux-actions">
            <button class="primary" :disabled="remuxing || transcoding" @click="remux">
              {{ remuxing ? '封装中…' : '无损转 MP4' }}
            </button>
            <button :disabled="remuxing || transcoding" @click="transcode">
              {{ transcoding ? `转码中… ${transcodePercent}%` : '转码为 H.264' }}
            </button>
          </div>
          <div v-if="transcoding" class="bar-track transcode-bar">
            <div class="bar-fill" :style="{ width: transcodePercent + '%' }"></div>
          </div>
        </div>
      </main>

      <footer class="status" v-show="!minimalMode" v-if="busy || error || statusMsg">
        <div v-if="running && mode === 'batch'" class="bar">
          <span class="bar-label">{{ pipelineState.message }}</span>
          <div class="bar-track">
            <div class="bar-fill" :style="{ width: pipelineState.percent + '%' }"></div>
          </div>
          <span class="bar-pct">{{ pipelineState.percent }}%</span>
        </div>

        <div v-if="running && mode === 'stream'" class="bar">
          <span class="bar-label">
            {{ streamState.message }}
            <span v-if="streamState.segmentCount" class="seg-count">已识别 {{ streamState.segmentCount }} 句</span>
          </span>
          <div class="bar-track">
            <div class="bar-fill" :style="{ width: streamState.percent + '%' }"></div>
          </div>
          <span class="bar-pct">{{ streamState.percent }}%</span>
          <button class="mini-log" @click="showStreamLog = !showStreamLog">日志</button>
        </div>

        <div v-if="showStreamLog && streamLogs.length" class="log-panel">
          <div v-for="(l, i) in streamLogs" :key="i" class="log-line">{{ l }}</div>
        </div>

        <div v-if="translating" class="bar">
          <span class="bar-label">
            {{ llmLoading ? '翻译中（首次会先加载 Qwen 模型，需几十秒）…' : '翻译中…' }}
          </span>
        </div>

        <div v-if="downloading" class="bar">
          <span class="bar-label">下载模型 {{ downloading.name }}</span>
          <div class="bar-track">
            <div class="bar-fill" :style="{ width: downloading.percent + '%' }"></div>
          </div>
          <span class="bar-pct">{{ downloading.percent }}%</span>
        </div>

        <div v-if="error" class="error">{{ error }}</div>
        <div v-if="statusMsg && !error" class="ok">{{ statusMsg }}</div>
      </footer>
          </template>
        </div>
    </div>

    <!-- 精简模式下的「还原」按钮 -->
    <button v-if="minimalMode && video" class="restore-btn" title="退出精简模式（Esc）" @click="minimalMode = false">
      还原
    </button>
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.content {
  flex: 1;
  min-height: 0;
  display: flex;
}
.restore-btn {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 100;
  padding: 7px 14px;
  font-size: 13px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  background: rgba(0, 0, 0, 0.55);
  color: #eee;
  border-radius: 8px;
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 0.2s, background 0.2s;
}
.restore-btn:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.8);
}
.sidebar {
  width: 220px;
  flex-shrink: 0;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.sidebar-tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
}
.tab {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text-dim);
  padding: 10px 0;
  font-size: 13px;
  border-radius: 0;
}
.tab.active {
  color: var(--text);
  border-bottom: 2px solid var(--accent);
}
.sidebar-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sidebar-action {
  margin-bottom: 8px;
  font-size: 12px;
  padding: 7px 10px;
}
.sidebar-empty {
  color: var(--text-dim);
  font-size: 12px;
  text-align: center;
  margin-top: 24px;
}
.sidebar-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-radius: 6px;
}
.sidebar-item:hover {
  background: var(--bg-elevated);
}
.sidebar-item-title {
  flex: 1;
  font-size: 13px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar-item-x {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
}
.sidebar-item-x:hover {
  color: var(--danger);
  background: rgba(255, 92, 108, 0.12);
}
.player-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.main {
  flex: 1;
  min-height: 0;
  position: relative;
}
.status {
  padding: 8px 16px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bar-label {
  color: var(--text-dim);
  white-space: nowrap;
  min-width: 180px;
}
.seg-count {
  color: var(--accent);
  margin-left: 6px;
}
.bar-track {
  flex: 1;
  height: 6px;
  background: var(--bg-elevated);
  border-radius: 4px;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 4px;
  transition: width 0.2s;
}
.bar-pct {
  color: var(--text-dim);
  min-width: 48px;
  text-align: right;
}
.mini-log {
  padding: 2px 8px;
  font-size: 11px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-dim);
  border-radius: 4px;
  cursor: pointer;
}
.log-panel {
  max-height: 160px;
  overflow-y: auto;
  background: #0b0d12;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
}
.log-line {
  color: #8b93a7;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.4;
}
.error {
  color: var(--danger);
}
.ok {
  color: var(--ok);
}
.remux-hint {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 8px;
  padding: 32px;
}
.remux-hint-icon {
  font-size: 44px;
}
.remux-hint .dim {
  color: var(--text-dim);
  font-size: 13px;
  margin: 0 0 12px;
}
.remux-actions {
  display: flex;
  gap: 12px;
}
.transcode-bar {
  width: 320px;
  margin-top: 4px;
}
</style>
