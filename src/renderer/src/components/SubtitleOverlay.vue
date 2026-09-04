<script setup lang="ts">
import type { SubtitleSegment } from '@shared/types'

const props = defineProps<{
  segment: SubtitleSegment | null
  /** 双语 / 仅原文 / 仅译文 / 关闭 */
  mode: 'bilingual' | 'original' | 'translation' | 'off'
  fontSize: number
  bottomMargin: number
}>()

function originalVisible(): boolean {
  return props.mode === 'bilingual' || props.mode === 'original'
}
function translationVisible(): boolean {
  return (props.mode === 'bilingual' || props.mode === 'translation') && !!props.segment?.translation
}
</script>

<template>
  <div
    v-if="mode !== 'off' && segment"
    class="subtitle-overlay"
    :style="{ bottom: bottomMargin + 'px' }"
  >
    <div
      v-if="originalVisible()"
      class="line original"
      :style="{ fontSize: fontSize + 'px' }"
    >
      {{ segment.text }}
    </div>
    <div
      v-if="translationVisible()"
      class="line translation"
      :style="{ fontSize: Math.max(14, fontSize - 2) + 'px' }"
    >
      {{ segment.translation }}
    </div>
  </div>
</template>

<style scoped>
.subtitle-overlay {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  width: min(92%, 1100px);
  text-align: center;
  pointer-events: none;
  z-index: 4;
  transition: bottom 0.15s;
}
.line {
  display: block;
  line-height: 1.45;
  margin: 3px 0;
  /* PotPlayer 风格的描边+阴影，保证任何画面下都可读 */
  text-shadow:
    0 1px 2px rgba(0, 0, 0, 0.95),
    0 0 2px rgba(0, 0, 0, 0.9),
    1px 1px 2px rgba(0, 0, 0, 0.9),
    -1px -1px 2px rgba(0, 0, 0, 0.9);
  font-weight: 600;
  letter-spacing: 0.02em;
}
.original {
  color: #ffffff;
}
.translation {
  color: #ffd75e;
}
</style>
