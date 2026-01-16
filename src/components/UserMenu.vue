<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { getSession } from '../services/supabaseClient';

const emit = defineEmits<{
  logout: [];
  openSettings: [];
}>();

const isOpen = ref(false);
const userName = ref('');
const userEmail = ref('');

// ユーザー名の頭文字を取得（日本語名にも対応）
const userInitial = computed(() => {
  if (!userName.value && !userEmail.value) return '?';
  const name = userName.value || userEmail.value;
  // 最初の文字を取得（絵文字やサロゲートペアにも対応）
  return [...name][0]?.toUpperCase() || '?';
});

// ユーザー情報を取得
async function loadUserInfo() {
  try {
    const session = await getSession();
    if (session?.user) {
      userName.value = session.user.user_metadata?.full_name || session.user.user_metadata?.name || '';
      userEmail.value = session.user.email || '';
    }
  } catch (error) {
    console.error('Failed to load user info:', error);
  }
}

// メニュー外クリックで閉じる
function handleClickOutside(event: MouseEvent) {
  const target = event.target as HTMLElement;
  if (!target.closest('.user-menu')) {
    isOpen.value = false;
  }
}

function toggleMenu() {
  isOpen.value = !isOpen.value;
}

function handleSettings() {
  isOpen.value = false;
  emit('openSettings');
}

function handleLogout() {
  isOpen.value = false;
  emit('logout');
}

onMounted(() => {
  loadUserInfo();
  document.addEventListener('click', handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
});
</script>

<template>
  <div class="user-menu">
    <button
      class="user-icon-button"
      @click.stop="toggleMenu"
      :title="userEmail || 'User'"
    >
      {{ userInitial }}
    </button>

    <div v-if="isOpen" class="dropdown-menu">
      <div class="user-info">
        <span v-if="userName" class="user-name">{{ userName }}</span>
        <span class="user-email">{{ userEmail }}</span>
      </div>
      <div class="menu-divider"></div>
      <button class="menu-item" @click="handleSettings">
        <span class="menu-icon">⚙️</span>
        設定
      </button>
      <div class="menu-divider"></div>
      <button class="menu-item logout-item" @click="handleLogout">
        <span class="menu-icon">🚪</span>
        ログアウト
      </button>
    </div>
  </div>
</template>

<style scoped>
.user-menu {
  position: relative;
}

.user-icon-button {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: linear-gradient(135deg, #24c8db, #1ba8b8);
  color: white;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.15s, box-shadow 0.15s;
}

.user-icon-button:hover {
  transform: scale(1.05);
  box-shadow: 0 2px 8px rgba(36, 200, 219, 0.4);
}

.dropdown-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 200px;
  background: white;
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  z-index: 1000;
  overflow: hidden;
}

@media (prefers-color-scheme: dark) {
  .dropdown-menu {
    background: #2a2a2a;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
  }
}

.user-info {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.user-name {
  font-weight: 500;
  font-size: 14px;
}

.user-email {
  font-size: 12px;
  color: #888;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu-divider {
  height: 1px;
  background: #eee;
}

@media (prefers-color-scheme: dark) {
  .menu-divider {
    background: #444;
  }
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 16px;
  border: none;
  background: transparent;
  font-size: 14px;
  cursor: pointer;
  text-align: left;
  color: inherit;
  transition: background 0.15s;
}

.menu-item:hover {
  background: #f5f5f5;
}

@media (prefers-color-scheme: dark) {
  .menu-item:hover {
    background: #333;
  }
}

.menu-icon {
  font-size: 16px;
}

.logout-item {
  color: #dc3545;
}

.logout-item:hover {
  background: rgba(220, 53, 69, 0.1);
}
</style>
