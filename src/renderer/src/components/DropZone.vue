<script setup lang="ts">
defineEmits<{ (e: 'browse'): void }>()
</script>

<template>
  <div class="dropzone">
    <div class="dropzone-inner">
      <div class="dropzone-icon">🎬</div>
      <h1>AIVideoPlayer</h1>
      <p class="hint">拖入一部没有字幕的日语 / 英语视频</p>
      <p class="sub">点击播放 → AI 实时识别 → 原文字幕 → 中文字幕</p>
      <button class="primary" @click="$emit('browse')">选择视频文件</button>
    </div>
  </div>
</template>

<style scoped>
.dropzone {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dropzone-inner {
  text-align: center;
  max-width: 460px;
  padding: 40px;
  border: 2px dashed var(--border);
  border-radius: 16px;
  background: var(--bg-panel);
}
.dropzone-icon {
  font-size: 56px;
  margin-bottom: 12px;
}
h1 {
  font-size: 22px;
  margin: 0 0 12px;
}
.hint {
  font-size: 16px;
  color: var(--text);
  margin: 0 0 6px;
}
.sub {
  font-size: 13px;
  color: var(--text-dim);
  margin: 0 0 24px;
}
</style>
