<script setup lang="ts">
defineProps<{
  visible: boolean;
  scenarioTitle: string;
}>();

defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <div v-if="visible" class="modal-overlay" @click.self="$emit('cancel')">
    <div class="modal delete-confirm-modal">
      <h2>テストステップの削除</h2>
      <p class="confirm-message">
        以下のテストステップを削除してもよろしいですか？<br />
        この操作は取り消せません。
      </p>
      <p class="scenario-name">「{{ scenarioTitle }}」</p>
      <div class="button-row">
        <button @click="$emit('cancel')" class="secondary-button">
          キャンセル
        </button>
        <button @click="$emit('confirm')" class="danger-button">削除する</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modal {
  background: white;
  padding: 24px;
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
}
@media (prefers-color-scheme: dark) {
  .modal {
    background: #2a2a2a;
    color: #f6f6f6;
  }
}
.delete-confirm-modal {
  max-width: 400px;
}
.delete-confirm-modal h2 {
  margin-top: 0;
  margin-bottom: 16px;
}
.confirm-message {
  color: #666;
  margin-bottom: 1rem;
}
@media (prefers-color-scheme: dark) {
  .confirm-message {
    color: #aaa;
  }
}
.scenario-name {
  font-weight: bold;
  padding: 0.5rem;
  background: #f5f5f5;
  border-radius: 4px;
  margin-bottom: 1.5rem;
}
@media (prefers-color-scheme: dark) {
  .scenario-name {
    background: #333;
  }
}
.button-row {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}
.secondary-button {
  background: #6c757d;
  color: white;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.secondary-button:hover {
  background: #5a6268;
}
.danger-button {
  background-color: #dc3545;
  color: white;
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.danger-button:hover {
  background-color: #c82333;
}
</style>
