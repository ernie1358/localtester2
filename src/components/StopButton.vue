<script setup lang="ts">
/**
 * StopButton Component
 *
 * A reusable stop button that provides immediate visual feedback when clicked.
 * The button becomes disabled and shows "停止中..." while stop is processing.
 */

import { computed } from 'vue';

const props = defineProps<{
  /**
   * Whether the stop process is currently in progress
   */
  isStopping: boolean;
}>();

const emit = defineEmits<{
  (e: 'stop'): void;
}>();

const isDisabled = computed(() => props.isStopping);
const buttonLabel = computed(() =>
  props.isStopping ? '停止中...' : '停止 (Shift+Esc)'
);

function handleClick() {
  if (!props.isStopping) {
    emit('stop');
  }
}
</script>

<template>
  <button
    @click="handleClick"
    :disabled="isDisabled"
    :class="['danger-button', { stopping: isStopping }]"
    data-testid="stop-button"
  >
    {{ buttonLabel }}
  </button>
</template>

<style scoped>
.danger-button {
  padding: 0.75rem 1.5rem;
  background: #ff4444;
  color: white;
  border: none;
  border-radius: 0.375rem;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s ease;
}

.danger-button:hover:not(:disabled) {
  background: #cc0000;
}

.danger-button:disabled {
  background: #999;
  cursor: not-allowed;
}

.danger-button.stopping {
  background: #999;
  cursor: wait;
}
</style>
