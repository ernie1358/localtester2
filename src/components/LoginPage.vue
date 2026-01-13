<script setup lang="ts">
import { ref } from 'vue';
import { signInWithGoogle } from '../services/authService';

const emit = defineEmits<{
  authenticated: [];
}>();

const isLoading = ref(false);
const errorMessage = ref('');

async function handleGoogleLogin() {
  isLoading.value = true;
  errorMessage.value = '';

  try {
    const result = await signInWithGoogle();

    if (result.success) {
      emit('authenticated');
    } else {
      errorMessage.value = result.error || 'ログインに失敗しました';
    }
  } catch (error) {
    errorMessage.value = error instanceof Error
      ? error.message
      : 'ログインに失敗しました';
  } finally {
    isLoading.value = false;
  }
}
</script>

<template>
  <div class="login-container">
    <div class="login-card">
      <img src="/logo.png" alt="Xenotester" class="login-logo" />
      <h1>Xenotester</h1>
      <p class="tagline">AI-Powered E2E Test Automation Tool</p>

      <div v-if="errorMessage" class="error-box">
        {{ errorMessage }}
      </div>

      <button
        @click="handleGoogleLogin"
        :disabled="isLoading"
        class="google-login-button"
      >
        <svg class="google-icon" viewBox="0 0 24 24" width="20" height="20">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        <span>{{ isLoading ? 'ログイン中...' : 'Googleでログイン' }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.login-container {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background-color: #f6f6f6;
}

@media (prefers-color-scheme: dark) {
  .login-container {
    background-color: #1a1a1a;
  }
}

.login-card {
  background: white;
  padding: 48px;
  border-radius: 16px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
  text-align: center;
  max-width: 400px;
  width: 90%;
}

@media (prefers-color-scheme: dark) {
  .login-card {
    background: #2a2a2a;
    color: #f6f6f6;
  }
}

.login-logo {
  width: 200px;
  margin-bottom: 16px;
}

h1 {
  margin: 0 0 8px 0;
  color: #24c8db;
}

.tagline {
  color: #888;
  margin: 0 0 32px 0;
}

.error-box {
  background-color: #f8d7da;
  border: 1px solid #f5c6cb;
  color: #721c24;
  padding: 12px;
  border-radius: 8px;
  margin-bottom: 20px;
  text-align: left;
}

@media (prefers-color-scheme: dark) {
  .error-box {
    background-color: #2c0b0e;
    border-color: #491217;
    color: #f5c6cb;
  }
}

.google-login-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  width: 100%;
  padding: 14px 24px;
  background: white;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  color: #333;
}

.google-login-button:hover:not(:disabled) {
  background: #f8f8f8;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.google-login-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@media (prefers-color-scheme: dark) {
  .google-login-button {
    background: #333;
    border-color: #555;
    color: #f6f6f6;
  }

  .google-login-button:hover:not(:disabled) {
    background: #444;
  }
}

.google-icon {
  flex-shrink: 0;
}
</style>
