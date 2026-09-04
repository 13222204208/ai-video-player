<script setup lang="ts">
import type { ModelProgress, WhisperModelInfo } from '@shared/types'

defineProps<{
  models: WhisperModelInfo[]
  selectedModel: string
  mode: 'stream' | 'batch'
  running: boolean
  translating: boolean
  hasSegments: boolean
  needsRemux: boolean
  detectedLanguage: string | null
  downloadState: ModelProgress | null
  llmModelReady: boolean
  disabled: boolean
}>()

const emit = defineEmits<{
  (e: 'update:selectedModel', v: string): void
  (e: 'update:mode', v: 'stream' | 'batch'): void
  (e: 'download', name: string): void
  (e: 'downloadLlm'): void
  (e: 'generate'): void
  (e: 'cancel'): void
  (e: 'export'): void
  (e: 'remux'): void
  (e: 'toggleMinimal'): void
}>()

const LANG_LABEL: Record<string, string> = { ja: '日语', en: '英语', auto: '自动' }
</script>

<template>
  <div class="control-panel">
    <div class="field">
      <label>识别模式</label>
      <div class="seg">
        <button
          class="seg-btn"
          :class="{ active: mode === 'batch' }"
          :disabled="running"
          @click="emit('update:mode', 'batch')"
        >
          整片批量
        </button>
        <button
          class="seg-btn"
          :class="{ active: mode === 'stream' }"
          :disabled="running"
          @click="emit('update:mode', 'stream')"
        >
          流式实时
        </button>
      </div>
    </div>

    <div class="field">
      <label>Whisper 模型</label>
      <select
        :value="selectedModel"
        :disabled="running || translating"
        @change="emit('update:selectedModel', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="m in models" :key="m.name" :value="m.name">
          {{ m.label }}（{{ m.sizeMb }}MB）{{ m.installed ? '✓' : '· 未下载' }}
        </option>
      </select>
      <button
        v-if="!models.find((m) => m.name === selectedModel)?.installed"
        class="mini"
        :disabled="running || translating || !!downloadState"
        @click="emit('download', selectedModel)"
      >
        下载模型
      </button>
    </div>

    <div class="field">
      <label>字幕语言</label>
      <span class="tag lang-fixed">简体中文</span>
      <span v-if="detectedLanguage" class="tag">
        原声：{{ LANG_LABEL[detectedLanguage] ?? detectedLanguage }}
      </span>
    </div>

    <div class="field">
      <label>翻译引擎</label>
      <span class="tag" :class="llmModelReady ? '' : 'lang-warn'">Qwen2.5-7B</span>
      <button
        v-if="!llmModelReady"
        class="mini"
        :disabled="running || translating || !!downloadState"
        @click="emit('downloadLlm')"
      >
        下载翻译模型（4.4GB）
      </button>
    </div>

    <div class="actions">
      <button
        v-if="needsRemux"
        class="primary"
        :disabled="running || translating"
        @click="emit('remux')"
      >
        无损转 MP4 播放
      </button>
      <button v-if="running" class="danger" @click="emit('cancel')">取消</button>
      <button
        v-else
        class="primary"
        :disabled="disabled || translating || !!downloadState"
        @click="emit('generate')"
      >
        {{ mode === 'stream' ? '开始实时识别' : '生成字幕' }}
      </button>
      <button :disabled="!hasSegments || running || translating" @click="emit('export')">
        导出字幕
      </button>
      <button title="只显示视频和字幕，按 Esc 还原" @click="emit('toggleMinimal')">
        精简模式
      </button>
    </div>
  </div>
</template>

<style scoped>
.control-panel {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  padding: 12px 16px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}
.field {
  display: flex;
  align-items: center;
  gap: 8px;
}
.field label {
  font-size: 13px;
  color: var(--text-dim);
  white-space: nowrap;
}
.actions {
  margin-left: auto;
  display: flex;
  gap: 10px;
}
.tag {
  font-size: 12px;
  color: var(--ok);
  background: rgba(56, 193, 114, 0.12);
  padding: 3px 8px;
  border-radius: 6px;
}
.tag.lang-fixed {
  color: var(--accent);
  background: rgba(79, 140, 255, 0.14);
}
.tag.lang-warn {
  color: var(--danger);
  background: rgba(255, 92, 108, 0.12);
}
.mini {
  padding: 7px 10px;
  font-size: 12px;
}
.danger {
  border-color: var(--danger);
  color: var(--danger);
}
.danger:hover:not(:disabled) {
  border-color: var(--danger);
  background: rgba(255, 92, 108, 0.12);
}
.seg {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.seg-btn {
  border: none;
  border-radius: 0;
  padding: 7px 12px;
  background: var(--bg-elevated);
  color: var(--text-dim);
}
.seg-btn.active {
  background: var(--accent);
  color: #fff;
}
.seg-btn + .seg-btn {
  border-left: 1px solid var(--border);
}
</style>
