# 実装計画書: シナリオ管理機能

## 1. 概要

現在のXenotester UIは、単一のシナリオを入力・実行するシンプルな構成になっています。本計画は、複数のシナリオを永続的に管理し、選択したシナリオを順次実行できるように根本的なUI/アーキテクチャを変更するものです。

### 主要機能
1. **シナリオのCRUD操作**: 新規登録、一覧表示、編集、削除（削除時は確認ダイアログ必須）
2. **SQLite永続化**: Tauriアプリ内にSQLiteデータベースを組み込み、シナリオデータを永続化
3. **ドラッグ&ドロップ並び替え**: シナリオの実行順序をUI上で自由に変更
4. **選択実行**: チェックボックスで選択したシナリオを上から順に連続実行（順序保証）
5. **結果表示ウィンドウ**: 実行完了後、各シナリオの成功/失敗を**新規ウィンドウ**で表示（失敗時はどこまで行けたかを表示）

---

## 2. 影響範囲

### 2.1 新規作成が必要なファイル

#### フロントエンド (Vue/TypeScript)
| ファイル | 説明 |
|---------|------|
| `src/components/ScenarioList.vue` | シナリオ一覧コンポーネント（チェックボックス、並び替え、編集/削除ボタン） |
| `src/components/ScenarioForm.vue` | シナリオ登録/編集フォームコンポーネント |
| `src/components/DeleteConfirmDialog.vue` | 削除確認ダイアログコンポーネント |
| `src/pages/ResultPage.vue` | 結果表示専用ページコンポーネント（新規ウィンドウ用） |
| `src/services/scenarioDatabase.ts` | SQLiteとの通信を担当するサービス |
| `src/services/resultWindowService.ts` | 結果ウィンドウの作成・管理サービス |
| `src/types/database.ts` | データベース関連の型定義 |
| `src/composables/useScenarioManager.ts` | シナリオ管理のComposable（状態管理とビジネスロジック） |
| `result.html` | 結果ウィンドウ用のHTMLエントリーポイント |

#### バックエンド (Rust)
| ファイル | 説明 |
|---------|------|
| `src-tauri/migrations/001_create_scenarios.sql` | シナリオテーブル作成マイグレーション |

### 2.2 変更が必要なファイル

| ファイル | 変更内容 | 理由 |
|---------|----------|------|
| `src/App.vue` | UI全体の再構成、新コンポーネントの統合 | メイン画面をシナリオ管理画面に変更 |
| `src/types/scenario.ts` | `Scenario`型のID型変更（`number` → `string`/UUID）、orderIndex追加 | DB永続化のためのフィールド追加 |
| `src/types/index.ts` | 新しい型定義のエクスポート追加 | database.ts のエクスポート |
| `src/services/scenarioRunner.ts` | 選択されたシナリオを**並び順で**実行する機能、詳細結果収集の強化 | 複数シナリオ選択実行、アクション履歴収集 |
| `src/services/agentLoop.ts` | **戻り値にアクション履歴（actionHistory）と失敗アクション情報を追加** | 失敗時の「どこまで行けた/次に行けなかった」情報取得 |
| `src/services/scenarioParser.ts` | **ID型をstringに変更（UUIDを返すように修正）** | Scenario.id型変更に伴う整合性維持 |
| `src/services/index.ts` | 新サービスのエクスポート追加 | scenarioDatabase, resultWindowServiceのエクスポート |
| `src-tauri/Cargo.toml` | `tauri-plugin-sql`依存関係追加 | SQLiteサポート |
| `src-tauri/src/lib.rs` | SQLiteプラグイン初期化、**マイグレーション配列の定義と紐付け** | プラグイン有効化 |
| `src-tauri/tauri.conf.json` | SQLiteパーミッション追加、**結果ウィンドウのマルチウィンドウ設定** | 権限とマルチウィンドウ設定 |
| `src-tauri/capabilities/default.json` | SQLプラグインの権限追加（新規作成の可能性あり） | Tauri 2.0の権限管理 |
| `package.json` | `@tauri-apps/plugin-sql`、`vuedraggable`依存関係追加 | フロントエンド依存関係 |
| `vite.config.ts` | 結果ウィンドウ用のマルチエントリー設定追加 | 複数HTMLエントリーポイント対応 |

### 2.3 影響を受ける可能性があるファイル（変更必要）

| ファイル | 理由 |
|---------|------|
| `src/services/agentLoop.ts` | **変更必要**: アクション履歴と失敗アクション情報を戻り値に追加 |
| `src/services/scenarioParser.ts` | **変更必要**: ID型をnumber→stringに変更し、UUIDを生成するよう修正 |

---

## 3. 実装ステップ

### Phase 1: 基盤整備（SQLite統合）

#### Step 1.1: Tauri SQLプラグインのインストール
```bash
# フロントエンド
npm install @tauri-apps/plugin-sql

# バックエンド
cd src-tauri
cargo add tauri-plugin-sql --features sqlite
```

#### Step 1.2: Cargo.toml更新
```toml
[dependencies]
# 既存の依存関係に追加
tauri-plugin-sql = { version = "2", features = ["sqlite"] }
```

#### Step 1.3: lib.rs更新（マイグレーション紐付け含む）
```rust
use tauri_plugin_sql::{Migration, MigrationKind};

// マイグレーション配列を定義
fn get_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_scenarios_table",
            sql: include_str!("../migrations/001_create_scenarios.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dotenv::dotenv().ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // SQLiteプラグイン登録（マイグレーション付き）
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:xenotester.db", get_migrations())
                .build()
        )
        .setup(|app| {
            register_emergency_stop(app.handle().clone());
            Ok(())
        })
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            // 既存のハンドラー...
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

#### Step 1.4: capabilities/default.json作成
```json
{
  "identifier": "default",
  "description": "Default capability for the main window",
  "windows": ["main", "result"],
  "permissions": [
    "core:default",
    "sql:default",
    "sql:allow-load",
    "sql:allow-execute",
    "sql:allow-select",
    "sql:allow-close"
  ]
}
```

#### Step 1.5: マイグレーション作成
`src-tauri/migrations/001_create_scenarios.sql`:
```sql
CREATE TABLE IF NOT EXISTS scenarios (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_scenarios_order ON scenarios(order_index);
```

### Phase 2: 型定義とサービス層

#### Step 2.1: types/database.ts作成
```typescript
/** 実行されたアクションの記録（失敗箇所特定用） */
export interface ExecutedAction {
  index: number;
  action: string;
  description: string;
  success: boolean;
  timestamp: Date;
}

export interface StoredScenario {
  id: string;
  title: string;
  description: string;
  order_index: number;
  created_at: string;
  updated_at: string;
}

export interface ScenarioExecutionResult {
  scenarioId: string;
  title: string;
  success: boolean;
  error?: string;
  /** 完了したアクション数 */
  completedActions: number;
  /** 総アクション数（既知の場合） */
  totalActions?: number;
  /** 失敗したアクションの説明 */
  failedAtAction?: string;
  /** 実行されたアクション履歴 */
  actionHistory: ExecutedAction[];
  /** 最後に成功したアクション */
  lastSuccessfulAction?: string;
}

export interface BatchExecutionResult {
  totalScenarios: number;
  successCount: number;
  failureCount: number;
  results: ScenarioExecutionResult[];
  executedAt: Date;
}
```

#### Step 2.2: types/scenario.ts更新
```typescript
// 既存のScenario型を更新
export interface Scenario {
  id: string;  // number → string (UUID) に変更
  title: string;
  description: string;
  status: ScenarioStatus;
  orderIndex?: number;
  error?: string;
  iterations?: number;
  startedAt?: Date;
  completedAt?: Date;
  // 実行時の詳細結果（既存のresultフィールドに加えて）
  completedActions?: number;
  failedAtAction?: string;
  result?: TestResult;
  expectedActions?: ExpectedAction[];
}
```

#### Step 2.3: services/scenarioParser.ts更新（ID型整合性）
```typescript
// 変更前: id: s.id (number)
// 変更後: id: crypto.randomUUID() (string)

export async function parseScenarios(userInput: string): Promise<Scenario[]> {
  try {
    // ... existing code ...

    return result.scenarios.map((s, index) => ({
      id: crypto.randomUUID(),  // number → string (UUID)
      title: s.title,
      description: s.description,
      status: 'pending' as const,
    }));
  } catch (error) {
    // Fallback: treat entire input as single scenario
    console.warn('Scenario split failed, treating as single scenario:', error);
    return [
      {
        id: crypto.randomUUID(),  // number → string (UUID)
        title: 'テストシナリオ',
        description: userInput,
        status: 'pending',
      },
    ];
  }
}
```

#### Step 2.4: services/agentLoop.ts更新（アクション履歴追加）
```typescript
/** 実行されたアクションの記録 */
export interface ExecutedActionRecord {
  index: number;
  action: string;
  description: string;
  success: boolean;
  timestamp: Date;
}

/** Result of agent loop execution - 拡張版 */
export interface AgentLoopResult {
  success: boolean;
  error?: string;
  iterations: number;
  /** 実行されたアクション履歴 */
  actionHistory: ExecutedActionRecord[];
  /** 完了したアクション数 */
  completedActionCount: number;
  /** 失敗したアクションの説明（ある場合） */
  failedAtAction?: string;
  /** 最後に成功したアクションの説明 */
  lastSuccessfulAction?: string;
}

// runAgentLoop関数内で、アクション実行時に履歴を記録
// 既存のactionHistory（ループ検出用）とは別に、詳細なログを保持
const executedActions: ExecutedActionRecord[] = [];

// 各アクション実行後:
executedActions.push({
  index: executedActions.length,
  action: action.action,
  description: formatActionDetails(action, ...),
  success: actionResult.success,
  timestamp: new Date(),
});

// 戻り値に追加:
return {
  success: true,
  iterations: iteration + 1,
  actionHistory: executedActions,
  completedActionCount: executedActions.filter(a => a.success).length,
  lastSuccessfulAction: executedActions.filter(a => a.success).pop()?.description,
};
```

#### Step 2.5: services/scenarioDatabase.ts作成
```typescript
import Database from '@tauri-apps/plugin-sql';
import type { StoredScenario } from '../types';

let db: Database | null = null;

export async function getDatabase(): Promise<Database> {
  if (!db) {
    db = await Database.load('sqlite:xenotester.db');
  }
  return db;
}

export async function getAllScenarios(): Promise<StoredScenario[]> {
  const database = await getDatabase();
  return database.select<StoredScenario[]>(
    'SELECT * FROM scenarios ORDER BY order_index ASC'
  );
}

export async function createScenario(title: string, description: string): Promise<StoredScenario> {
  const database = await getDatabase();
  const id = crypto.randomUUID();
  const maxOrder = await database.select<[{max_order: number | null}]>(
    'SELECT MAX(order_index) as max_order FROM scenarios'
  );
  const orderIndex = (maxOrder[0]?.max_order ?? -1) + 1;

  await database.execute(
    'INSERT INTO scenarios (id, title, description, order_index) VALUES (?, ?, ?, ?)',
    [id, title, description, orderIndex]
  );

  return { id, title, description, order_index: orderIndex, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}

export async function updateScenario(id: string, title: string, description: string): Promise<void> {
  const database = await getDatabase();
  await database.execute(
    'UPDATE scenarios SET title = ?, description = ?, updated_at = datetime("now") WHERE id = ?',
    [title, description, id]
  );
}

export async function deleteScenario(id: string): Promise<void> {
  const database = await getDatabase();
  await database.execute('DELETE FROM scenarios WHERE id = ?', [id]);
}

export async function updateScenarioOrders(orders: { id: string; orderIndex: number }[]): Promise<void> {
  const database = await getDatabase();
  for (const order of orders) {
    await database.execute(
      'UPDATE scenarios SET order_index = ?, updated_at = datetime("now") WHERE id = ?',
      [order.orderIndex, order.id]
    );
  }
}
```

### Phase 3: フロントエンドコンポーネント

#### Step 3.1: ドラッグ&ドロップライブラリインストール
```bash
npm install vuedraggable@next
```

#### Step 3.2: components/DeleteConfirmDialog.vue作成（削除確認ダイアログ）
```vue
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
  <div v-if="visible" class="modal-overlay">
    <div class="modal delete-confirm-modal">
      <h2>シナリオの削除</h2>
      <p class="confirm-message">
        以下のシナリオを削除してもよろしいですか？<br>
        この操作は取り消せません。
      </p>
      <p class="scenario-name">「{{ scenarioTitle }}」</p>
      <div class="button-row">
        <button @click="$emit('cancel')" class="secondary-button">キャンセル</button>
        <button @click="$emit('confirm')" class="danger-button">削除する</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.delete-confirm-modal {
  max-width: 400px;
}
.confirm-message {
  color: #666;
  margin-bottom: 1rem;
}
.scenario-name {
  font-weight: bold;
  color: #333;
  padding: 0.5rem;
  background: #f5f5f5;
  border-radius: 4px;
  margin-bottom: 1.5rem;
}
.danger-button {
  background-color: #dc3545;
  color: white;
}
.danger-button:hover {
  background-color: #c82333;
}
</style>
```

#### Step 3.3: components/ScenarioForm.vue作成
```vue
<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { StoredScenario } from '../types';

const props = defineProps<{
  scenario?: StoredScenario | null;
  visible: boolean;
}>();

const emit = defineEmits<{
  save: [title: string, description: string];
  cancel: [];
}>();

const title = ref('');
const description = ref('');

const isEditing = computed(() => !!props.scenario);
const modalTitle = computed(() => isEditing.value ? 'シナリオ編集' : '新規シナリオ登録');

watch(() => props.scenario, (newVal) => {
  if (newVal) {
    title.value = newVal.title;
    description.value = newVal.description;
  } else {
    title.value = '';
    description.value = '';
  }
}, { immediate: true });

function handleSave() {
  if (!title.value.trim() || !description.value.trim()) return;
  emit('save', title.value.trim(), description.value.trim());
}
</script>

<template>
  <div v-if="visible" class="modal-overlay">
    <div class="modal">
      <h2>{{ modalTitle }}</h2>
      <div class="form-group">
        <label>タイトル</label>
        <input v-model="title" type="text" placeholder="シナリオのタイトル" />
      </div>
      <div class="form-group">
        <label>シナリオ内容</label>
        <textarea v-model="description" rows="8" placeholder="テストシナリオの詳細..."></textarea>
      </div>
      <div class="button-row">
        <button @click="$emit('cancel')" class="secondary-button">キャンセル</button>
        <button @click="handleSave" class="primary-button" :disabled="!title.trim() || !description.trim()">
          {{ isEditing ? '保存' : '登録' }}
        </button>
      </div>
    </div>
  </div>
</template>
```

#### Step 3.4: components/ScenarioList.vue作成（順序保証対応）
```vue
<script setup lang="ts">
import { computed } from 'vue';
import draggable from 'vuedraggable';
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

const allSelected = computed({
  get: () => props.scenarios.length > 0 && props.selectedIds.size === props.scenarios.length,
  set: (val: boolean) => {
    const newSet = new Set<string>();
    if (val) {
      props.scenarios.forEach(s => newSet.add(s.id));
    }
    emit('update:selectedIds', newSet);
  }
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

function handleDragEnd() {
  emit('update:order', [...props.scenarios]);
}

/**
 * 選択されたシナリオIDを現在の並び順で取得
 * Set は順序保証がないため、scenarios配列の順序でフィルタリング
 */
function getSelectedIdsInOrder(): string[] {
  return props.scenarios
    .filter(s => props.selectedIds.has(s.id))
    .map(s => s.id);
}

// 親コンポーネントから呼び出し可能
defineExpose({ getSelectedIdsInOrder });
</script>

<template>
  <div class="scenario-list">
    <div class="list-header">
      <label class="checkbox-label">
        <input type="checkbox" v-model="allSelected" :disabled="isRunning" />
        すべて選択
      </label>
    </div>
    <draggable
      :model-value="scenarios"
      @update:model-value="$emit('update:order', $event)"
      @end="handleDragEnd"
      item-key="id"
      handle=".drag-handle"
      :disabled="isRunning"
    >
      <template #item="{ element, index }">
        <div class="scenario-row">
          <span class="drag-handle" v-if="!isRunning">☰</span>
          <span class="order-number">{{ index + 1 }}</span>
          <input
            type="checkbox"
            :checked="selectedIds.has(element.id)"
            @change="toggleSelection(element.id)"
            :disabled="isRunning"
          />
          <span class="scenario-title">{{ element.title }}</span>
          <div class="actions">
            <button @click="$emit('edit', element)" :disabled="isRunning">編集</button>
            <button @click="$emit('delete', element)" :disabled="isRunning" class="danger">削除</button>
          </div>
        </div>
      </template>
    </draggable>
  </div>
</template>
```

### Phase 4: 結果表示ウィンドウ（新規ウィンドウ実装）

#### Step 4.1: vite.config.ts更新（マルチエントリー）
```typescript
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  plugins: [vue()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        result: resolve(__dirname, 'result.html'),
      },
    },
  },
  // 既存の設定...
});
```

#### Step 4.2: result.html作成
```html
<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>実行結果 - Xenotester</title>
    <link rel="stylesheet" href="/src/styles/result.css" />
  </head>
  <body>
    <div id="result-app"></div>
    <script type="module" src="/src/result-main.ts"></script>
  </body>
</html>
```

#### Step 4.3: src/result-main.ts作成
```typescript
import { createApp } from 'vue';
import ResultPage from './pages/ResultPage.vue';

createApp(ResultPage).mount('#result-app');
```

#### Step 4.4: src/pages/ResultPage.vue作成
```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { listen } from '@tauri-apps/api/event';
import type { BatchExecutionResult } from '../types';

const result = ref<BatchExecutionResult | null>(null);

onMounted(async () => {
  // メインウィンドウからのイベントを受信
  await listen<BatchExecutionResult>('execution-result', (event) => {
    result.value = event.payload;
  });
});

function formatActionHistory(actions: ExecutedAction[]): string {
  return actions
    .map((a, i) => `${i + 1}. ${a.action}: ${a.description} [${a.success ? '成功' : '失敗'}]`)
    .join('\n');
}
</script>

<template>
  <div class="result-page">
    <h1>実行結果</h1>

    <div v-if="!result" class="loading">
      結果を読み込み中...
    </div>

    <div v-else class="result-content">
      <div class="summary-section">
        <h2>サマリー</h2>
        <p>実行シナリオ数: {{ result.totalScenarios }}</p>
        <p class="success-count">成功: {{ result.successCount }}</p>
        <p class="failure-count">失敗: {{ result.failureCount }}</p>
        <p>実行日時: {{ new Date(result.executedAt).toLocaleString() }}</p>
      </div>

      <div class="details-section">
        <h2>詳細結果</h2>
        <div
          v-for="(r, idx) in result.results"
          :key="r.scenarioId"
          :class="['result-item', r.success ? 'success' : 'failure']"
        >
          <div class="result-header">
            <span class="scenario-number">シナリオ{{ idx + 1 }}</span>
            <span class="scenario-title">{{ r.title }}</span>
            <span :class="['status-badge', r.success ? 'badge-success' : 'badge-failure']">
              {{ r.success ? '成功' : '失敗' }}
            </span>
          </div>

          <div class="result-body">
            <p>完了アクション数: {{ r.completedActions }}件</p>

            <template v-if="!r.success">
              <div class="failure-info">
                <p v-if="r.lastSuccessfulAction">
                  <strong>最後に成功したアクション:</strong><br>
                  {{ r.lastSuccessfulAction }}
                </p>
                <p v-if="r.failedAtAction">
                  <strong>失敗箇所:</strong><br>
                  {{ r.failedAtAction }}
                </p>
                <p v-if="r.error">
                  <strong>エラー:</strong><br>
                  {{ r.error }}
                </p>
              </div>

              <details v-if="r.actionHistory?.length > 0" class="action-history">
                <summary>アクション履歴 ({{ r.actionHistory.length }}件)</summary>
                <pre>{{ formatActionHistory(r.actionHistory) }}</pre>
              </details>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.result-page {
  padding: 20px;
  max-width: 800px;
  margin: 0 auto;
}

.summary-section {
  background: #f8f9fa;
  padding: 16px;
  border-radius: 8px;
  margin-bottom: 24px;
}

.success-count { color: #28a745; }
.failure-count { color: #dc3545; }

.result-item {
  border: 1px solid #ddd;
  border-radius: 8px;
  margin-bottom: 16px;
  overflow: hidden;
}

.result-item.success { border-left: 4px solid #28a745; }
.result-item.failure { border-left: 4px solid #dc3545; }

.result-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: #f8f9fa;
}

.scenario-number { font-weight: bold; }
.scenario-title { flex: 1; }

.badge-success { background: #28a745; color: white; padding: 2px 8px; border-radius: 4px; }
.badge-failure { background: #dc3545; color: white; padding: 2px 8px; border-radius: 4px; }

.result-body { padding: 16px; }

.failure-info {
  background: #fff3f3;
  padding: 12px;
  border-radius: 4px;
  margin-top: 12px;
}

.action-history {
  margin-top: 12px;
}

.action-history pre {
  background: #f5f5f5;
  padding: 12px;
  border-radius: 4px;
  font-size: 12px;
  overflow-x: auto;
}
</style>
```

#### Step 4.5: services/resultWindowService.ts作成
```typescript
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit } from '@tauri-apps/api/event';
import type { BatchExecutionResult } from '../types';

let resultWindow: WebviewWindow | null = null;

/**
 * 結果ウィンドウを開き、実行結果を表示
 */
export async function openResultWindow(result: BatchExecutionResult): Promise<void> {
  // 既存のウィンドウがあれば閉じる
  if (resultWindow) {
    try {
      await resultWindow.close();
    } catch {
      // ウィンドウが既に閉じられている場合は無視
    }
  }

  // 新しいウィンドウを作成
  resultWindow = new WebviewWindow('result', {
    url: '/result.html',
    title: '実行結果 - Xenotester',
    width: 700,
    height: 600,
    center: true,
    resizable: true,
    focus: true,
  });

  // ウィンドウの読み込みを待つ
  await new Promise<void>((resolve, reject) => {
    resultWindow!.once('tauri://created', () => {
      resolve();
    });
    resultWindow!.once('tauri://error', (e) => {
      reject(new Error(`Window creation failed: ${e}`));
    });
  });

  // 少し待ってからイベントを送信（Vueアプリの初期化を待つ）
  await new Promise(resolve => setTimeout(resolve, 500));

  // 結果データを送信
  await emit('execution-result', result);
}

/**
 * 結果ウィンドウを閉じる
 */
export async function closeResultWindow(): Promise<void> {
  if (resultWindow) {
    try {
      await resultWindow.close();
    } catch {
      // 既に閉じられている場合は無視
    }
    resultWindow = null;
  }
}
```

### Phase 5: シナリオ実行ロジック更新

#### Step 5.1: scenarioRunner.ts更新（順序保証と詳細結果収集）
```typescript
import type { BatchExecutionResult, ScenarioExecutionResult, StoredScenario } from '../types';
import { runAgentLoop, type AgentLoopResult } from './agentLoop';

/**
 * 選択されたシナリオを順序通りに実行
 * @param orderedScenarioIds - 実行順序が保証されたシナリオID配列
 * @param scenarios - 全シナリオデータ
 */
export async function runSelectedScenarios(
  orderedScenarioIds: string[],
  scenarios: StoredScenario[],
  options: ScenarioRunnerOptions = {}
): Promise<BatchExecutionResult> {
  const results: ScenarioExecutionResult[] = [];
  let successCount = 0;
  let failureCount = 0;

  // orderedScenarioIds の順序で実行（順序保証）
  for (const scenarioId of orderedScenarioIds) {
    const scenario = scenarios.find(s => s.id === scenarioId);
    if (!scenario) continue;

    // シナリオを実行
    const agentResult: AgentLoopResult = await runAgentLoop({
      scenario: {
        id: scenario.id,
        title: scenario.title,
        description: scenario.description,
        status: 'pending',
      },
      abortSignal: this.abortController!.signal,
      onLog: options.onLog,
      config: options.agentConfig,
    });

    // 結果を変換
    const executionResult: ScenarioExecutionResult = {
      scenarioId: scenario.id,
      title: scenario.title,
      success: agentResult.success,
      error: agentResult.error,
      completedActions: agentResult.completedActionCount,
      failedAtAction: agentResult.failedAtAction,
      actionHistory: agentResult.actionHistory,
      lastSuccessfulAction: agentResult.lastSuccessfulAction,
    };

    results.push(executionResult);

    if (agentResult.success) {
      successCount++;
    } else {
      failureCount++;
      // stopOnFailure が設定されている場合は中断
      if (options.stopOnFailure) break;
    }
  }

  return {
    totalScenarios: orderedScenarioIds.length,
    successCount,
    failureCount,
    results,
    executedAt: new Date(),
  };
}
```

### Phase 6: メインアプリ統合

#### Step 6.1: App.vue大幅改修
- シナリオ入力テキストエリアを削除
- シナリオ一覧コンポーネント統合
- 新規登録ボタン追加
- 削除確認ダイアログ統合
- 「チェックされたシナリオを実行する」ボタン追加
- 実行完了後に結果ウィンドウを開く

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import ScenarioList from './components/ScenarioList.vue';
import ScenarioForm from './components/ScenarioForm.vue';
import DeleteConfirmDialog from './components/DeleteConfirmDialog.vue';
import { getAllScenarios, createScenario, updateScenario, deleteScenario, updateScenarioOrders } from './services/scenarioDatabase';
import { runSelectedScenarios } from './services/scenarioRunner';
import { openResultWindow } from './services/resultWindowService';
import type { StoredScenario, BatchExecutionResult } from './types';

const scenarios = ref<StoredScenario[]>([]);
const selectedIds = ref<Set<string>>(new Set());
const isRunning = ref(false);
const showForm = ref(false);
const editingScenario = ref<StoredScenario | null>(null);
const showDeleteConfirm = ref(false);
const deletingScenario = ref<StoredScenario | null>(null);
const scenarioListRef = ref<InstanceType<typeof ScenarioList> | null>(null);

onMounted(async () => {
  scenarios.value = await getAllScenarios();
});

// 削除ボタンクリック時 - 確認ダイアログを表示
function handleDeleteClick(scenario: StoredScenario) {
  deletingScenario.value = scenario;
  showDeleteConfirm.value = true;
}

// 削除確認 - 実際に削除を実行
async function confirmDelete() {
  if (!deletingScenario.value) return;

  await deleteScenario(deletingScenario.value.id);
  scenarios.value = scenarios.value.filter(s => s.id !== deletingScenario.value!.id);
  selectedIds.value.delete(deletingScenario.value.id);

  showDeleteConfirm.value = false;
  deletingScenario.value = null;
}

// 削除キャンセル
function cancelDelete() {
  showDeleteConfirm.value = false;
  deletingScenario.value = null;
}

// チェックされたシナリオを実行
async function executeSelected() {
  if (selectedIds.value.size === 0) return;

  isRunning.value = true;

  try {
    // 順序保証: ScenarioListから並び順でIDを取得
    const orderedIds = scenarioListRef.value?.getSelectedIdsInOrder() ?? [];

    const result: BatchExecutionResult = await runSelectedScenarios(
      orderedIds,
      scenarios.value,
      { stopOnFailure: false }
    );

    // 新規ウィンドウで結果を表示
    await openResultWindow(result);
  } finally {
    isRunning.value = false;
  }
}
</script>

<template>
  <div class="app">
    <header>
      <h1>Xenotester</h1>
      <button @click="showForm = true; editingScenario = null" :disabled="isRunning">
        新規シナリオ登録
      </button>
    </header>

    <main>
      <ScenarioList
        ref="scenarioListRef"
        :scenarios="scenarios"
        :selected-ids="selectedIds"
        :is-running="isRunning"
        @update:selected-ids="selectedIds = $event"
        @update:order="handleOrderChange"
        @edit="handleEdit"
        @delete="handleDeleteClick"
      />

      <div class="action-bar">
        <button
          @click="executeSelected"
          :disabled="isRunning || selectedIds.size === 0"
          class="primary-button"
        >
          チェックされたシナリオを実行する ({{ selectedIds.size }}件)
        </button>
      </div>
    </main>

    <ScenarioForm
      :visible="showForm"
      :scenario="editingScenario"
      @save="handleSave"
      @cancel="showForm = false"
    />

    <DeleteConfirmDialog
      :visible="showDeleteConfirm"
      :scenario-title="deletingScenario?.title ?? ''"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </div>
</template>
```

### Phase 7: tauri.conf.json更新

#### Step 7.1: マルチウィンドウ設定
```json
{
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "Xenotester",
        "width": 900,
        "height": 700
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all"
  }
}
```
※ 結果ウィンドウは動的に作成されるため、tauri.conf.jsonに事前定義は不要

---

## 4. 技術的考慮事項

### 4.1 パフォーマンス
- SQLiteはローカルファイルベースのため、シナリオ数が数百件程度であれば問題なし
- ドラッグ&ドロップ時の順序更新はバッチ処理で効率化

### 4.2 セキュリティ
- SQLインジェクション: プレースホルダーを使用したクエリで対策済み
- データベースファイルはアプリのデータディレクトリに保存（ユーザーごとに分離）

### 4.3 既存機能への影響
- **scenarioParser.ts**: ID型をnumber→stringに変更する必要あり
- **agentLoop.ts**: 戻り値にactionHistory, completedActionCount, failedAtAction, lastSuccessfulActionを追加する必要あり
- **緊急停止機能**: 変更不要。現行の仕組みがそのまま機能

### 4.4 データ移行
- 現在はデータ永続化がないため、移行は不要
- 初回起動時にSQLiteデータベースが自動作成される

### 4.5 順序保証
- **重要**: `Set<string>`は順序を保証しないため、実行時は`scenarios`配列の順序を基準とする
- `ScenarioList.vue`の`getSelectedIdsInOrder()`メソッドで、現在の並び順に基づいた選択済みID配列を取得
- `runSelectedScenarios()`は`orderedScenarioIds`パラメータの順序で厳密に実行

---

## 5. テスト計画

### 5.1 ユニットテスト
| テスト対象 | テスト内容 |
|-----------|-----------|
| scenarioDatabase.ts | CRUD操作、順序更新 |
| ScenarioList.vue | チェックボックス操作、ドラッグ&ドロップ、getSelectedIdsInOrder() |
| ScenarioForm.vue | フォームバリデーション |
| DeleteConfirmDialog.vue | 確認/キャンセル動作 |
| agentLoop.ts | アクション履歴の記録、失敗情報の収集 |

### 5.2 統合テスト
| テスト内容 |
|-----------|
| シナリオ登録→一覧表示→編集→削除の一連フロー |
| 削除時に確認ダイアログが表示され、確認後のみ削除されること |
| 複数シナリオの順序変更が永続化されること |
| 選択したシナリオが**並び順通りに**実行されること |
| 実行結果が新規ウィンドウで正しく表示されること |
| 失敗時に「どこまで行けた/次に行けなかった」情報が表示されること |

### 5.3 E2Eテスト
| テスト内容 |
|-----------|
| 10件のシナリオを登録し、5件を選択して実行 |
| ドラッグ&ドロップで順序変更後、アプリ再起動で順序が維持されていること |
| 実行結果ウィンドウが正しく開き、全シナリオの結果が表示されること |
| 3番目のシナリオで失敗した場合、どこまで進んだかが表示されること |

---

## 6. リスクと対策

| リスク | 影響度 | 対策 |
|--------|--------|------|
| SQLiteプラグインの互換性問題 | 中 | Tauri公式プラグインを使用、ドキュメント確認済み |
| ドラッグ&ドロップの操作性（タッチデバイス） | 低 | vuedraggableはタッチ対応、フォールバックとして上下ボタン追加可能 |
| 大量シナリオ時のパフォーマンス | 低 | ページネーションまたは仮想スクロール導入（必要に応じて） |
| マルチウィンドウ間通信の複雑さ | 中 | Tauri Eventシステムを使用、シンプルな一方向通信で実装 |
| データベースファイル破損 | 低 | SQLiteの堅牢性、定期バックアップ機能の追加を検討 |
| アクション履歴の肥大化 | 低 | 履歴は実行完了後のみ保持、DBには保存しない |

---

## 7. 調査ログ

### 7.1 実行した検索語
| ツール | パターン |
|--------|----------|
| Glob | `src/**/*.{ts,tsx,vue}` |
| Glob | `src-tauri/**/*.rs`（target除外） |
| Glob | `*.json`, `*.{toml,yml,yaml}` |
| Grep | `sqlite`, `rusqlite`, `sql-js` |
| Grep | `drag`, `drop`, `sortable` |
| Grep | `tauri-plugin`, `@tauri-apps` |
| Grep | `tauri-plugin-sql` |
| WebSearch | `Tauri 2 SQLite plugin database tutorial 2025` |
| WebSearch | `Vue 3 drag and drop sortable list library 2025` |

### 7.2 読んだファイル一覧

#### フロントエンド (src/)
- `src/App.vue` - メインコンポーネント（現行UI）
- `src/main.ts` - エントリーポイント
- `src/services/` 配下 6ファイル全て確認
  - agentLoop.ts, claudeClient.ts, historyManager.ts, scenarioParser.ts, scenarioRunner.ts, index.ts
- `src/types/` 配下 5ファイル全て確認
  - action.ts, capture.ts, scenario.ts, index.ts, testResult.ts
- `src/utils/` 配下 3ファイル全て確認
  - coordinateScaler.ts, loopDetector.ts, index.ts

#### バックエンド (src-tauri/)
- `src-tauri/Cargo.toml` - Rust依存関係
- `src-tauri/tauri.conf.json` - Tauri設定
- `src-tauri/src/main.rs` - エントリーポイント
- `src-tauri/src/lib.rs` - ライブラリルート
- `src-tauri/src/state.rs` - アプリ状態
- `src-tauri/src/error.rs` - エラー定義
- `src-tauri/src/commands/` 配下 6ファイル全て確認
  - mod.rs, config.rs, control.rs, input.rs, permission.rs, screenshot.rs
- `src-tauri/src/services/` 配下 5ファイル全て確認
  - mod.rs, capture.rs, image_processor.rs, keyboard.rs, mouse.rs
- `src-tauri/src/utils/` 配下 2ファイル全て確認
  - mod.rs, hotkey.rs

#### 設定ファイル
- `package.json` - npm依存関係
- `tsconfig.json` - TypeScript設定
- `vite.config.ts` - Vite設定

### 7.3 辿った依存チェーン
1. `App.vue` → `scenarioParser` → `claudeClient` → `types/scenario`
2. `App.vue` → `scenarioRunner` → `agentLoop` → `types/action`, `types/capture`
3. `lib.rs` → `commands/*` → `services/*` → `state`, `error`
4. `scenario.ts` → `testResult.ts` (TestResult, ExpectedAction型)

### 7.4 非TSファイル確認
- [x] package.json - 依存関係確認
- [x] Cargo.toml - Rust依存関係確認
- [x] tauri.conf.json - Tauri設定確認
- [x] tsconfig.json - TypeScript設定確認
- [x] vite.config.ts - Vite設定確認

### 7.5 調査中に発見した関連情報・懸念事項
1. **Tauri 2.0のSQLプラグイン**: 公式プラグイン `tauri-plugin-sql` がSQLite、MySQL、PostgreSQLをサポート。マイグレーション機能も内蔵。`include_str!`マクロでSQLファイルを埋め込み可能
2. **capabilities/default.json**: Tauri 2.0ではプラグイン権限をこのファイルで管理する必要あり（現在未作成）
3. **vuedraggable@next**: Vue 3対応のドラッグ&ドロップライブラリ。SortableJS基盤でタッチデバイス対応
4. **現行のScenario型**: `id`が`number`型であり、scenarioParser.tsでも`number`を返している。UUID（`string`）に変更する場合、両方の修正が必要
5. **結果ウィンドウ**: Tauri 2.0では`WebviewWindow`クラスで動的にウィンドウを作成可能。Event APIで親子ウィンドウ間通信
6. **agentLoop.ts**: 現在は`success`, `error`, `iterations`のみを返す。アクション履歴（actionHistory）は内部変数として存在するが、外部に公開されていない

---

## 8. フィードバック対応履歴

### 対応済みフィードバック

| 重大度 | 指摘内容 | 対応 |
|--------|----------|------|
| 高 | 削除時の確認ダイアログが計画に含まれていない | `DeleteConfirmDialog.vue`を追加、削除フローに確認ステップを追加 |
| 高 | 実行結果は新規ウィンドウ表示が要件だが、計画ではダイアログ実装が前提でウィンドウが「オプション」扱い | 新規ウィンドウを必須とし、`ResultPage.vue`, `result.html`, `resultWindowService.ts`を追加 |
| 高 | 失敗時の「どこまで行けた/次に行けなかった」情報を出すためのデータ取得手段が不足 | `agentLoop.ts`の戻り値に`actionHistory`, `completedActionCount`, `failedAtAction`, `lastSuccessfulAction`を追加 |
| 高 | SQLiteマイグレーションの紐付け手順が不明 | `lib.rs`に`get_migrations()`関数と`include_str!`マクロによるSQL読み込みの具体的コードを追加 |
| 中 | `Scenario.id`を`string`へ変更する一方で`scenarioParser.ts`は「変更不要」とされ、型不整合でビルドエラーになり得る | `scenarioParser.ts`の変更を必要ファイルリストに追加、具体的な修正内容を記載 |
| 中 | 「上から順に実行」の順序保証が計画に明記されていない | `ScenarioList.vue`に`getSelectedIdsInOrder()`メソッドを追加、`runSelectedScenarios()`は配列順序で実行する方針を明記 |

---

## 9. 参考リンク

- [Tauri SQL Plugin公式ドキュメント](https://v2.tauri.app/plugin/sql/)
- [vuedraggable.next GitHub](https://github.com/SortableJS/vue.draggable.next)
- [Tauri 2.0 + SQLite チュートリアル](https://dev.to/focuscookie/tauri-20-sqlite-db-react-2aem)
- [Tauri WebviewWindow API](https://v2.tauri.app/reference/javascript/api/namespacewebviewwindow/)
- [Tauri Event System](https://v2.tauri.app/develop/calling-rust/#event-system)

---

計画書ファイルパス: /Users/satoshizerocolored/dev/localtester2/implementation-plan-scenario-management.md
