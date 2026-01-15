# 実装計画書: Supabase + Google OAuth 認証機能

## 1. 概要

このアプリケーション（Xenotester）にSupabase Authenticationを使ったGoogleログイン機能を実装します。

### 実装内容
- アプリケーション起動時に認証状態をチェック
- 未認証の場合はログインフォームを表示（Googleログインボタンのみ）
- Googleログインボタンをクリックすると、外部ブラウザでGoogle認証を開始
- 認証成功後、アプリに戻りログイン状態でメイン画面を表示
- 新規ユーザーは自動登録、既存ユーザーはそのままログイン

### 技術アプローチ
Tauriデスクトップアプリでは、OAuthリダイレクトの処理が特殊です。以下の2つのアプローチを検討しました：

**アプローチ1: tauri-plugin-oauth（推奨）**
- ローカルホストサーバーをspawnしてリダイレクトを受け取る
- `http://localhost:PORT` 形式のリダイレクトURLを使用
- Google OAuth と互換性が高い

**アプローチ2: Deep Link**
- カスタムURLスキーム（例: `xenotester://auth`）を使用
- 開発時は使用不可（macOSはbundled .appが必要）
- GoogleはカスタムURLスキームを許可しない場合がある

本計画では **アプローチ1（tauri-plugin-oauth）** を採用します。

---

## 2. 影響範囲

### 2.1 新規作成ファイル

| ファイル | 目的 |
|---------|------|
| `src/services/supabaseClient.ts` | Supabaseクライアント初期化・セッション管理 |
| `src/services/authService.ts` | 認証フロー（Google OAuth）の実装 |
| `src/components/LoginPage.vue` | ログインフォーム（Googleログインボタン） |
| `src/composables/useAuth.ts` | 認証状態管理のComposable（オプション） |
| `src/types/auth.ts` | 認証関連の型定義 |
| `src/__tests__/authService.test.ts` | 認証サービスのユニットテスト |

### 2.2 変更が必要なファイル

| ファイル | 変更内容 | 理由 |
|---------|----------|------|
| `src/App.vue` | 認証状態に応じた条件付きレンダリング | 認証済みユーザーのみメイン画面を表示 |
| `src-tauri/src/lib.rs` | OAuthプラグイン初期化 | Rust側でプラグインを有効化 |
| `src-tauri/src/commands/config.rs` | Supabase環境変数取得コマンド追加 | SUPABASE_URL, SUPABASE_ANON_KEYの取得 |
| `src-tauri/Cargo.toml` | tauri-plugin-oauth依存追加 | OAuthリダイレクト処理 |
| `src-tauri/capabilities/default.json` | oauth権限追加 | プラグイン権限の付与 |
| `package.json` | @fabianlars/tauri-plugin-oauth依存追加 | フロントエンドからプラグインAPI使用 |
| `src/services/index.ts` | 新サービスのエクスポート追加 | サービス統合 |
| `src/types/index.ts` | 新型定義のエクスポート追加 | 型統合 |
| `.env.example` | Supabase環境変数テンプレート追加 | ドキュメント目的 |

### 2.3 影響を受ける可能性があるファイル（変更不要だが確認必要）

| ファイル | 確認内容 |
|---------|----------|
| `src/main.ts` | 変更不要。認証ガードはApp.vueで完結するため |
| `src/result-main.ts` | 結果ウィンドウは認証不要のため変更不要 |
| `src/pages/ResultPage.vue` | 認証状態に依存しないため変更不要 |
| `vite.config.ts` | 変更不要（既存設定で対応可能） |
| `index.html` | 変更不要 |

---

## 3. 実装ステップ

### Step 1: 依存パッケージのインストール

**Rust側（Cargo.toml）**
```toml
[dependencies]
tauri-plugin-oauth = "2"
```

**フロントエンド側**
```bash
npm install @fabianlars/tauri-plugin-oauth@2
```

### Step 2: Rust側の設定

#### 2.1 OAuthプラグイン初期化（src-tauri/src/lib.rs）

run()関数を修正（プラグインの初期化のみ追加）:
```rust
pub fn run() {
    dotenv::dotenv().ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_oauth::init())  // 追加
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:xenotester.db", get_migrations())
                .build(),
        )
        .setup(|app| {
            register_emergency_stop(app.handle().clone());
            Ok(())
        })
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // ... 既存のコマンド
            config::get_supabase_config,  // 追加
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**注意**: `start_oauth_server` コマンドは不要です。`tauri-plugin-oauth` はTypeScript側で `start()` と `onUrl()` を提供し、Rust側でカスタムコマンドを定義する必要はありません。

#### 2.2 Supabase設定取得コマンド（src-tauri/src/commands/config.rs に追加）
```rust
#[derive(serde::Serialize)]
pub struct SupabaseConfig {
    pub url: String,
    pub anon_key: String,
}

#[tauri::command]
pub fn get_supabase_config() -> Result<SupabaseConfig, String> {
    let url = std::env::var("SUPABASE_URL")
        .map_err(|_| "SUPABASE_URL is not set")?;
    let anon_key = std::env::var("SUPABASE_ANON_KEY")
        .map_err(|_| "SUPABASE_ANON_KEY is not set")?;

    Ok(SupabaseConfig { url, anon_key })
}
```

#### 2.3 権限設定（src-tauri/capabilities/default.json）
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main", "result"],
  "permissions": [
    "core:default",
    "core:window:allow-create",
    "core:window:allow-set-focus",
    "core:webview:allow-create-webview-window",
    "core:event:default",
    "opener:default",
    "oauth:default",
    "sql:default",
    "sql:allow-load",
    "sql:allow-execute",
    "sql:allow-select",
    "sql:allow-close"
  ]
}
```

### Step 3: 型定義の作成

#### 3.1 src/types/auth.ts
```typescript
import type { Session, User } from '@supabase/supabase-js';

export type { Session, User };

export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: User | null;
  error: string | null;
}

export interface AuthResult {
  success: boolean;
  error?: string;
}

export interface SupabaseConfig {
  url: string;
  anon_key: string;
}
```

### Step 4: Supabaseクライアント実装

#### 4.1 src/services/supabaseClient.ts
```typescript
import { createClient, SupabaseClient, Session } from '@supabase/supabase-js';
import { invoke } from '@tauri-apps/api/core';
import type { SupabaseConfig } from '../types/auth';

let supabaseClient: SupabaseClient | null = null;

export async function getSupabaseClient(): Promise<SupabaseClient> {
  if (supabaseClient) {
    return supabaseClient;
  }

  const config = await invoke<SupabaseConfig>('get_supabase_config');

  supabaseClient = createClient(config.url, config.anon_key, {
    auth: {
      storage: localStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false, // Tauriでは手動で処理
      flowType: 'pkce', // PKCEフローを明示的に設定（JavaScriptのデフォルトはimplicit）
    },
  });

  return supabaseClient;
}

export async function getSession(): Promise<Session | null> {
  const client = await getSupabaseClient();
  const { data: { session } } = await client.auth.getSession();
  return session;
}

export async function signOut(): Promise<void> {
  const client = await getSupabaseClient();
  await client.auth.signOut();
}
```

### Step 5: 認証サービス実装

#### 5.1 src/services/authService.ts
```typescript
import { start, cancel, onUrl } from '@fabianlars/tauri-plugin-oauth';
import { open } from '@tauri-apps/plugin-opener';
import { getSupabaseClient, getSession, signOut } from './supabaseClient';
import type { AuthResult } from '../types/auth';

/**
 * Google OAuthでサインイン（PKCEフロー）
 *
 * 認証フロー:
 * 1. tauri-plugin-oauthでローカルサーバーを起動してリダイレクト待機
 * 2. 外部ブラウザでGoogle認証を開始
 * 3. onUrl()でリダイレクトURLを受け取り、codeパラメータを取得
 * 4. exchangeCodeForSession()でcodeをセッションに交換
 *
 * 注意: supabaseClient.tsで flowType: 'pkce' を設定しているため、
 * リダイレクトにはcodeパラメータのみが返される（access_token/refresh_tokenは返されない）
 */
export async function signInWithGoogle(): Promise<AuthResult> {
  let port: number | null = null;
  let unlisten: (() => void) | null = null;

  try {
    const client = await getSupabaseClient();

    // tauri-plugin-oauthでOAuthサーバーを起動
    port = await start();
    const redirectUrl = `http://localhost:${port}`;

    // Supabase OAuth URLを生成（PKCEフロー）
    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectUrl,
        skipBrowserRedirect: true, // URLを取得するだけで自動リダイレクトしない
      },
    });

    if (error || !data.url) {
      throw new Error(error?.message || 'Failed to get OAuth URL');
    }

    // リダイレクトURLを待機するPromise
    const authPromise = new Promise<AuthResult>((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: '認証がタイムアウトしました。再度お試しください。' });
      }, 300000); // 5分タイムアウト

      // onUrl()でリダイレクトURLを受信
      onUrl(async (callbackUrl) => {
        clearTimeout(timeout);

        try {
          const url = new URL(callbackUrl);

          // PKCEフローでは認証コード(code)がクエリパラメータとして返される
          const code = url.searchParams.get('code');

          if (code) {
            // PKCE flow - codeをセッションに交換
            const { error: exchangeError } = await client.auth.exchangeCodeForSession(code);
            if (exchangeError) {
              resolve({ success: false, error: exchangeError.message });
            } else {
              resolve({ success: true });
            }
          } else {
            // エラーチェック（認証がキャンセルされた場合など）
            const errorParam = url.searchParams.get('error');
            const errorDescription = url.searchParams.get('error_description');

            if (errorParam) {
              resolve({ success: false, error: errorDescription || errorParam });
            } else {
              resolve({ success: false, error: '認証コードを取得できませんでした' });
            }
          }
        } catch (err) {
          resolve({
            success: false,
            error: err instanceof Error ? err.message : '不明なエラーが発生しました'
          });
        }
      }).then((u) => { unlisten = u; });
    });

    // 外部ブラウザで認証ページを開く
    await open(data.url);

    return await authPromise;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '不明なエラーが発生しました',
    };
  } finally {
    // クリーンアップ
    if (unlisten) {
      unlisten();
    }
    if (port !== null) {
      try {
        await cancel(port);
      } catch {
        // 既に停止している場合は無視
      }
    }
  }
}

/**
 * 現在の認証状態をチェック
 */
export async function checkAuth(): Promise<boolean> {
  try {
    const session = await getSession();
    return session !== null;
  } catch {
    return false;
  }
}

/**
 * Supabaseクライアントを再export（App.vueで使用）
 */
export { getSupabaseClient, getSession, signOut };
```

**変更点（レビューフィードバック対応）**:
1. `start()` は `@fabianlars/tauri-plugin-oauth` から直接呼び出す
2. `onUrl()` でリダイレクトURLを受信（Rust側でカスタムイベントを emit する必要なし）
3. `getSupabaseClient` を再export（App.vueから使用できるように）

### Step 6: ログインページ実装

#### 6.1 src/components/LoginPage.vue
```vue
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
```

### Step 7: App.vueの修正

#### 7.1 既存のApp.vueに認証ロジックを追加

scriptセクションの変更:
```typescript
<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import ScenarioList from './components/ScenarioList.vue';
import ScenarioForm from './components/ScenarioForm.vue';
import DeleteConfirmDialog from './components/DeleteConfirmDialog.vue';
import LoginPage from './components/LoginPage.vue';  // 追加
import { checkAuth, getSupabaseClient } from './services/authService';  // 追加
// ... 既存のインポート

// 認証状態
const isAuthenticated = ref(false);
const isCheckingAuth = ref(true);

// ... 既存のstate定義

onMounted(async () => {
  try {
    // 認証状態をチェック
    isAuthenticated.value = await checkAuth();

    if (isAuthenticated.value) {
      // 認証済みの場合、既存の初期化処理を実行
      await initializeApp();
    }

    // セッション変更を監視
    const client = await getSupabaseClient();
    client.auth.onAuthStateChange((event, session) => {
      isAuthenticated.value = session !== null;
      if (event === 'SIGNED_OUT') {
        // ログアウト時はステートをクリア
        scenarios.value = [];
        selectedIds.value = new Set();
      }
    });
  } catch (error) {
    console.error('Auth check error:', error);
    // 認証チェックに失敗しても、認証不要として扱わない
    isAuthenticated.value = false;
  } finally {
    isCheckingAuth.value = false;
  }
});

async function initializeApp() {
  try {
    // 既存のonMounted内の処理
    permissionStatus.value = await invoke<PermissionStatus>('check_permissions');
    apiKeyConfigured.value = await invoke<boolean>('is_api_key_configured', {
      keyName: 'anthropic',
    });
    await loadScenarios();
  } catch (error) {
    console.error('Initialization error:', error);
    errorMessage.value =
      error instanceof Error ? error.message : String(error);
  }
}

async function handleAuthenticated() {
  isAuthenticated.value = true;
  await initializeApp();
}

// ... 既存のメソッド
</script>
```

**変更点（レビューフィードバック対応）**:
- `import { checkAuth, getSupabaseClient } from './services/authService'` に修正
- `authService.ts` で `getSupabaseClient` を再exportしているため、このimportは正しく動作する

templateセクションの変更:
```vue
<template>
  <!-- ローディング状態 -->
  <div v-if="isCheckingAuth" class="loading-container">
    <div class="loading-spinner"></div>
    <p>読み込み中...</p>
  </div>

  <!-- ログインページ -->
  <LoginPage
    v-else-if="!isAuthenticated"
    @authenticated="handleAuthenticated"
  />

  <!-- メインアプリケーション（既存のtemplate内容） -->
  <main v-else class="container">
    <!-- ... 既存のコンテンツ全て -->
  </main>
</template>
```

styleセクションに追加:
```css
.loading-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background-color: #f6f6f6;
  color: #666;
}

@media (prefers-color-scheme: dark) {
  .loading-container {
    background-color: #1a1a1a;
    color: #aaa;
  }
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #ddd;
  border-top-color: #24c8db;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 16px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
```

### Step 8: サービス/型エクスポートの更新

#### 8.1 src/services/index.ts
```typescript
/**
 * Re-export all services
 */

export * from './agentLoop';
export * from './claudeClient';
export * from './historyManager';
export * from './resultWindowService';
export * from './scenarioDatabase';
export * from './scenarioParser';
export * from './scenarioRunner';
export * from './supabaseClient';  // 追加
export * from './authService';     // 追加
```

#### 8.2 src/types/index.ts
```typescript
/**
 * Re-export all type definitions
 */

export * from './action';
export * from './capture';
export * from './database';
export * from './scenario';
export * from './testResult';
export * from './auth';  // 追加
```

### Step 9: .env.example の更新

```env
# Anthropic API Key for Claude Computer Use
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# Gemini API Key (optional, for future extensions)
GEMINI_API_KEY=your_gemini_api_key_here

# Supabase Configuration
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key_here
```

### Step 10: Supabaseコンソール設定（マニュアル作業）

1. **Supabase Dashboard → Authentication → Providers → Google**
   - Enable Google provider
   - Client ID と Client Secret を設定

2. **Google Cloud Console**
   - OAuth 2.0 Client ID を作成
   - Application type: Web application
   - Authorized redirect URIs: `https://your-project-ref.supabase.co/auth/v1/callback`

3. **Supabase Dashboard → Authentication → URL Configuration**
   - Site URL: 空または任意（デスクトップアプリなので不要）
   - Redirect URLs: `http://localhost:*` を追加（ワイルドカードポート）

---

## 4. 技術的考慮事項

### 4.1 セキュリティ

- **PKCE フロー**: Supabaseは自動的にPKCEを使用し、認証コードの傍受を防止
- **ローカルホストサーバー**: 一時的なポートでspawnされ、認証完了後すぐにshutdown
- **トークン保存**: localStorageを使用（Tauriではファイルシステムに保存される）
- **環境変数**: 秘密情報は.envファイルに保存、Rust側から取得

### 4.2 パフォーマンス

- 認証状態チェックは起動時に一度のみ実行
- セッションはlocalStorageにキャッシュされ、再起動後も維持
- Supabaseの自動トークンリフレッシュを使用

### 4.3 既存機能への影響

- **最小限の変更**: 認証レイヤーは既存ロジックの上に追加
- **結果ウィンドウ**: 認証不要（メインウィンドウからのみ開かれる）
- **シナリオ実行**: 変更不要

### 4.4 エラーハンドリング

- ネットワークエラー: ユーザーに再試行を促す
- タイムアウト: 5分でタイムアウト、エラーメッセージ表示
- 無効なトークン: 自動的にサインアウトしてログインページへ

---

## 5. テスト計画

### 5.1 ユニットテスト

| テスト項目 | 内容 |
|-----------|------|
| `supabaseClient.ts` | クライアント初期化、セッション取得 |
| `authService.ts` | OAuth URL生成、トークン処理 |

### 5.2 手動テスト

| テスト項目 | 期待結果 |
|-----------|----------|
| 初回起動（未認証） | ログインページが表示される |
| Googleログインボタン押下 | 外部ブラウザでGoogle認証画面が開く |
| 認証成功 | メインアプリケーションが表示される |
| 認証キャンセル | ログインページに戻りエラー表示 |
| アプリ再起動（認証済み） | メインアプリケーションが直接表示される |
| 新規ユーザー | 自動登録されてログイン完了 |
| 既存ユーザー | そのままログイン完了 |

---

## 6. リスクと対策

| リスク | 対策 |
|--------|------|
| Google OAuth承認に時間がかかる | 開発中はテスト用OAuth資格情報を使用 |
| ポートが使用中の場合 | tauri-plugin-oauthは自動的に別ポートを試行 |
| ネットワークエラー | リトライボタンとエラーメッセージ表示 |
| トークン期限切れ | Supabaseの自動リフレッシュ機能を利用 |
| macOS開発時のdeep link不可 | 本計画ではlocalhost方式を採用し回避済み |

---

## 7. 調査ログ

### 7.1 実行した検索語

**Glob検索:**
- `src/**/*.{ts,tsx,vue,js}` - フロントエンドソース一覧
- `src-tauri/**/*.{rs,toml}` - Rust側ソース一覧
- `src-tauri/src/**/*.rs` - Rustソースファイル
- `src/pages/**/*.vue` - Vueページ
- `src/components/**/*.vue` - Vueコンポーネント
- `vite.config.*` - Vite設定
- `.env.example` - 環境変数テンプレート
- `*.html` - HTMLファイル
- `src-tauri/migrations/*.sql` - DBマイグレーション

**Grep検索:**
- `supabase` (path: src) - Supabase関連コード（なし）
- `auth|login|logout|session|signin` (path: src) - 認証関連コード（なし）
- `opener|shell|browser|deep-link` - ブラウザ開く関連
- `SUPABASE|GOOGLE` in `.env*` - 環境変数（.envに存在確認）

### 7.2 読んだ主要ファイル

**フロントエンド:**
- `src/main.ts` - エントリーポイント（5行）
- `src/App.vue` - メインアプリケーション（607行）
- `src/result-main.ts` - 結果ウィンドウエントリー（9行）
- `src/pages/ResultPage.vue` - 結果ページ（334行）
- `src/components/ScenarioForm.vue` - シナリオフォーム（784行）
- `src/services/scenarioDatabase.ts` - DB操作（243行）
- `src/services/scenarioRunner.ts` - シナリオ実行（444行）
- `src/services/resultWindowService.ts` - 結果ウィンドウ管理（144行）
- `src/services/claudeClient.ts` - Claude API（122行）
- `src/services/index.ts` - サービスエクスポート
- `src/types/index.ts` - 型エクスポート
- `src/types/database.ts` - DB型定義（89行）

**Rust側:**
- `src-tauri/src/main.rs` - Rustエントリー（7行）
- `src-tauri/src/lib.rs` - Tauriアプリ設定（96行）
- `src-tauri/src/commands/config.rs` - 設定コマンド（29行）
- `src-tauri/Cargo.toml` - Rust依存関係（57行）
- `src-tauri/capabilities/default.json` - 権限設定（20行）
- `src-tauri/tauri.conf.json` - Tauri設定（38行）
- `src-tauri/migrations/001_create_scenarios.sql` - scenariosテーブル
- `src-tauri/migrations/002_create_step_images.sql` - step_imagesテーブル

**設定ファイル:**
- `package.json` - NPM依存関係（35行）
- `vite.config.ts` - Vite設定（52行）
- `tsconfig.json` - TypeScript設定（26行）
- `index.html` - メインHTML（15行）
- `result.html` - 結果ウィンドウHTML（13行）
- `.env.example` - 環境変数テンプレート（6行）

### 7.3 辿った依存チェーン

```
main.ts
  └── App.vue
        ├── components/ScenarioList.vue
        ├── components/ScenarioForm.vue
        ├── components/DeleteConfirmDialog.vue
        ├── services/scenarioDatabase.ts → types/database
        ├── services/scenarioRunner.ts → services/agentLoop → services/claudeClient
        └── services/resultWindowService.ts

result-main.ts
  └── pages/ResultPage.vue

src-tauri/main.rs
  └── src-tauri/lib.rs
        ├── commands/config.rs
        ├── commands/control.rs
        ├── commands/input.rs
        ├── commands/permission.rs
        ├── commands/screenshot.rs
        ├── commands/template_match.rs
        ├── services/*
        ├── state.rs
        └── utils/hotkey.rs
```

### 7.4 非TSファイル確認

- `package.json` ✓ - @supabase/supabase-jsは既に依存に含まれている（^2.90.1）
- `Cargo.toml` ✓ - tauri-plugin-openerが存在、dotenvクレートも使用中
- `tsconfig.json` ✓ - 標準的な設定、strict mode有効
- `tauri.conf.json` ✓ - アプリ設定確認、CSPはnull
- `capabilities/default.json` ✓ - opener:default, sql:* 権限設定済み

### 7.5 発見した関連情報・懸念事項

1. **@supabase/supabase-js は既にインストール済み** - package.jsonで確認
2. **tauri-plugin-openerが使用可能** - 外部ブラウザを開くために利用可能
3. **既存の認証コードなし** - Grep結果から確認、新規実装が必要
4. **localStorageが使用可能** - Tauriではファイルシステムにマップされる
5. **環境変数は.envから読み込み** - dotenv crateを使用済み
6. **Vue Router未使用** - 条件付きレンダリングで画面切替
7. **状態管理ライブラリ未使用** - ref/reactiveで管理

---

## 8. レビューフィードバック対応記録

### 対応したフィードバック

| 重大度 | 指摘内容 | 対応 |
|--------|----------|------|
| 高 | OAuthリダイレクト受信の流れが不整合 | `tauri-plugin-oauth` の `start()` + `onUrl()` に統一。Rust側で独自の `start_oauth_server` コマンドは不要と判断し削除。Step 2.1 と Step 5 の整合性を修正 |
| 高 | App.vue の import が設計と一致しない | `authService.ts` で `getSupabaseClient` を再export。Step 5 に `export { getSupabaseClient, getSession, signOut }` を追加 |
| 中 | src/main.ts の変更が影響範囲にあるが実装手順が欠落 | 認証ガードは App.vue で完結するため、影響範囲から `src/main.ts` を「変更が必要なファイル」から「変更不要だが確認必要」に移動 |
| 高 | OAuthフローがPKCE前提なのに `flowType` の明示がなく、暗黙フローに落ちる可能性がある | `src/services/supabaseClient.ts` に `auth: { flowType: 'pkce' }` を追加。`src/services/authService.ts` から implicitフロー対応コード（access_token/refresh_tokenのハッシュ解析）を削除し、`exchangeCodeForSession(code)` を主経路に統一。Supabase公式ドキュメントによると、JavaScriptクライアントのデフォルトはimplicitフローであるため、PKCEフローを使用するには明示的な設定が必要 |

---

## 参考資料

- [Supabase + Google OAuth in a Tauri 2.0 macOS app (with deep links)](https://medium.com/@nathancovey23/supabase-google-oauth-in-a-tauri-2-0-macos-app-with-deep-links-f8876375cb0a)
- [GitHub - JeaneC/tauri-oauth-supabase](https://github.com/JeaneC/tauri-oauth-supabase)
- [GitHub - FabianLars/tauri-plugin-oauth](https://github.com/FabianLars/tauri-plugin-oauth)
- [tauri-plugin-oauth 2.0.0 - Docs.rs](https://docs.rs/tauri-plugin-oauth/2.0.0)
- [Supabase Login with Google](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase PKCE Flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow)
- [Supabase signInWithOAuth API Reference](https://supabase.com/docs/reference/javascript/auth-signinwithoauth)

---

計画書ファイルパス: /Users/satoshizerocolored/dev/localtester2/implementation-plan-supabase-google-auth.md
