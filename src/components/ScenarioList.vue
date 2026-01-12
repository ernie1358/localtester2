<script setup lang="ts">
import { computed } from 'vue';
import { VueDraggable } from 'vue-draggable-plus';
import type { StoredScenario } from '../types';

const props = defineProps<{
  scenarios: StoredScenario[];
  selectedIds: Set<string>;
  isRunning: boolean;
}>();

const emit = defineEmits<{
  'update:selectedIds': [ids: Set<string>];
  'update:order': [scenarios: StoredScenario[]];
  edit: [scenario: StoredScenario];
  delete: [scenario: StoredScenario];
}>();

// Local scenarios for drag-and-drop
const localScenarios = computed({
  get: () => props.scenarios,
  set: (val) => emit('update:order', val),
});

const allSelected = computed({
  get: () =>
    props.scenarios.length > 0 &&
    props.selectedIds.size === props.scenarios.length,
  set: (val: boolean) => {
    const newSet = new Set<string>();
    if (val) {
      props.scenarios.forEach((s) => newSet.add(s.id));
    }
    emit('update:selectedIds', newSet);
  },
});

function toggleSelection(id: string) {
  const newSet = new Set(props.selectedIds);
  if (newSet.has(id)) {
    newSet.delete(id);
  } else {
    newSet.add(id);
  }
  emit('update:selectedIds', newSet);
}

/**
 * Get selected scenario IDs in current display order
 */
function getSelectedIdsInOrder(): string[] {
  return props.scenarios.filter((s) => props.selectedIds.has(s.id)).map((s) => s.id);
}

// Expose method to parent
defineExpose({ getSelectedIdsInOrder });
</script>

<template>
  <div class="scenario-list">
    <div class="list-header" v-if="scenarios.length > 0">
      <label class="checkbox-label">
        <input type="checkbox" v-model="allSelected" :disabled="isRunning" />
        <span>すべて選択</span>
      </label>
    </div>

    <div v-if="scenarios.length === 0" class="empty-message">
      シナリオがありません。<br />
      「新規シナリオ登録」ボタンから登録してください。
    </div>

    <VueDraggable
      v-else
      v-model="localScenarios"
      handle=".drag-handle"
      :disabled="isRunning"
      item-key="id"
      class="scenario-rows"
    >
      <template #item="{ element, index }">
        <div
          class="scenario-row"
          :class="{ selected: selectedIds.has(element.id) }"
        >
          <input
            type="checkbox"
            :checked="selectedIds.has(element.id)"
            @change="toggleSelection(element.id)"
            :disabled="isRunning"
            class="scenario-checkbox"
          />
          <span class="order-number">{{ index + 1 }}</span>
          <div class="scenario-info">
            <span class="scenario-title">{{ element.title }}</span>
            <span class="scenario-description">{{
              element.description.substring(0, 50)
            }}{{ element.description.length > 50 ? '...' : '' }}</span>
          </div>
          <div class="actions">
            <button
              @click="$emit('edit', element)"
              :disabled="isRunning"
              class="edit-button"
            >
              編集
            </button>
            <button
              @click="$emit('delete', element)"
              :disabled="isRunning"
              class="delete-button"
            >
              削除
            </button>
          </div>
          <span
            class="drag-handle"
            :class="{ disabled: isRunning }"
            title="ドラッグして並び替え"
            >&#9776;</span
          >
        </div>
      </template>
    </VueDraggable>
  </div>
</template>

<style scoped>
.scenario-list {
  margin-bottom: 20px;
}
.list-header {
  padding: 12px;
  border-bottom: 1px solid #ddd;
}
@media (prefers-color-scheme: dark) {
  .list-header {
    border-color: #444;
  }
}
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.empty-message {
  padding: 40px;
  text-align: center;
  color: #888;
  background: #f9f9f9;
  border-radius: 8px;
}
@media (prefers-color-scheme: dark) {
  .empty-message {
    background: #2a2a2a;
    color: #888;
  }
}
.scenario-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
}
.scenario-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid #ddd;
  border-radius: 8px;
  background: white;
  transition: background 0.2s;
}
@media (prefers-color-scheme: dark) {
  .scenario-row {
    background: #2a2a2a;
    border-color: #444;
  }
}
.scenario-row.selected {
  border-color: #24c8db;
  background: rgba(36, 200, 219, 0.05);
}
.scenario-checkbox {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  cursor: pointer;
}
.scenario-checkbox:disabled {
  cursor: not-allowed;
}
.drag-handle {
  cursor: grab;
  font-size: 18px;
  color: #888;
  user-select: none;
  flex-shrink: 0;
  padding: 4px;
}
.drag-handle.disabled {
  cursor: not-allowed;
  opacity: 0.3;
}
.order-number {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #24c8db;
  color: white;
  border-radius: 50%;
  font-weight: bold;
  font-size: 14px;
  flex-shrink: 0;
}
.scenario-info {
  flex: 1;
  min-width: 0;
}
.scenario-title {
  display: block;
  font-weight: 500;
  margin-bottom: 2px;
}
.scenario-description {
  display: block;
  font-size: 12px;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.edit-button,
.delete-button {
  padding: 6px 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.edit-button {
  background: #6c757d;
  color: white;
}
.edit-button:hover:not(:disabled) {
  background: #5a6268;
}
.edit-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.delete-button {
  background: #dc3545;
  color: white;
}
.delete-button:hover:not(:disabled) {
  background: #c82333;
}
.delete-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
