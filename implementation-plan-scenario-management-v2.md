# 実装計画書: シナリオ管理機能 (v2.1)

## 1. 概要

現在のXenotester UIは、単一のシナリオを入力・即時実行するシンプルな構成になっています。本計画は、複数のシナリオを永続的に管理し、選択したシナリオを順次実行できるように根本的なUI/アーキテクチャを変更するものです。

### 主要機能
1. **シナリオのCRUD操作**: 新規登録、一覧表示、編集、削除（削除時は確認ダイアログ必須）
2. **SQLite永続化**: Tauriアプリ内にSQLiteデータベースを組み込み、シナリオデータを永続化
3. **ドラッグ&ドロップ並び替え**: シナリオの実行順序をUI上で自由に変更（連番表示付き）
4. **選択実行**: チェックボックスで選択したシナリオを上から順に連続実行（順序保証）
5. **結果表示ウィンドウ**: 実行完了後、各シナリオの成功/失敗を**新規ウィンドウ**で表示（失敗時はどこまで行けたかを表示）

### UI変更概要
- **変更前**: テキストエリアにシナリオを入力 → 即時実行
- **変更後**:
  1. メイン画面: シナリオ一覧（チェックボックス付き、ドラッグ&ドロップ可能）
  2. 新規登録ボタン → モーダルフォームでシナリオ入力 → 登録
  3. 一覧から編集/削除可能
  4. 「チェックされたシナリオを実行する」ボタンで選択シナリオを順次実行
  5. 実行完了後、新規ウィンドウで結果表示

---

## 2. 影響範囲

### 2.1 新規作成が必要なファイル

#### フロントエンド (Vue/TypeScript)
| ファイル | 説明 |
|---------|------|
| `src/components/ScenarioList.vue` | シナリオ一覧コンポーネント（チェックボックス、並び替え、編集/削除ボタン、連番表示） |
| `src/components/ScenarioForm.vue` | シナリオ登録/編集フォームモーダル（タイトル任意、自動生成対応） |
| `src/components/DeleteConfirmDialog.vue` | 削除確認ダイアログコンポーネント |
| `src/pages/ResultPage.vue` | 結果表示専用ページコンポーネント（新規ウィンドウ用、ハンドシェイク対応） |
| `src/services/scenarioDatabase.ts` | SQLiteとの通信を担当するサービス |
| `src/services/resultWindowService.ts` | 結果ウィンドウの作成・管理サービス（ハンドシェイク方式） |
| `src/types/database.ts` | データベース関連の型定義 |
| `src/result-main.ts` | 結果ウィンドウ用のVueエントリーポイント |
| `result.html` | 結果ウィンドウ用のHTMLエントリーポイント |

#### バックエンド (Rust)
| ファイル | 説明 |
|---------|------|
| `src-tauri/migrations/001_create_scenarios.sql` | シナリオテーブル作成マイグレーション |
| `src-tauri/capabilities/default.json` | Tauri 2.0プラグイン権限設定 |

### 2.2 変更が必要なファイル

| ファイル | 変更内容 | 理由 |
|---------|----------|------|
| `src/App.vue` | UI全体の再構成、新コンポーネントの統合 | メイン画面をシナリオ管理画面に変更 |
| `src/types/scenario.ts` | `Scenario`型のID型変更（`number` → `string`/UUID）、`orderIndex`追加 | DB永続化のためのフィールド追加 |
| `src/types/index.ts` | 新しい型定義のエクスポート追加 | `database.ts` のエクスポート |
| `src/services/scenarioRunner.ts` | **既存ScenarioRunnerクラスを拡張**して選択実行に対応（`emergency-stop`イベント継承） | 複数シナリオ選択実行、停止処理の一貫性維持 |
| `src/services/agentLoop.ts` | **戻り値にアクション履歴と失敗アクション情報を追加** | 失敗時の「どこまで行けた/次に行けなかった」情報取得 |
| `src/services/scenarioParser.ts` | **ID型をstringに変更（UUIDを生成するように修正）** | Scenario.id型変更に伴う整合性維持 |
| `src/services/index.ts` | 新サービスのエクスポート追加 | scenarioDatabase, resultWindowServiceのエクスポート |
| `src-tauri/Cargo.toml` | `tauri-plugin-sql`依存関係追加 | SQLiteサポート |
| `src-tauri/src/lib.rs` | SQLiteプラグイン初期化、マイグレーション紐付け | プラグイン有効化 |
| `src-tauri/tauri.conf.json` | ウィンドウ設定（labelの追加） | マルチウィンドウ対応 |
| `package.json` | `@tauri-apps/plugin-sql`、`vue-draggable-plus`依存関係追加 | フロントエンド依存関係 |
| `vite.config.ts` | 結果ウィンドウ用のマルチエントリー設定追加 | 複数HTMLエントリーポイント対応 |

### 2.3 影響を受けるが変更不要なファイル

| ファイル | 理由 |
|---------|------|
| `src/services/claudeClient.ts` | シナリオ実行ロジックには影響なし |
| `src/services/resultJudge.ts` | テスト結果判定ロジックはそのまま使用 |
| `src/services/actionValidator.ts` | アクション検証ロジックはそのまま使用 |
| `src/services/historyManager.ts` | 履歴管理はそのまま使用 |
| `src-tauri/src/commands/*` | 既存コマンドはそのまま使用 |
| `src-tauri/src/services/*` | 既存サービスはそのまま使用 |

---

## 3. 実装ステップ

### Phase 1: 基盤整備（SQLite統合）

#### Step 1.1: 依存関係のインストール
```bash
# フロントエンド
npm install @tauri-apps/plugin-sql vue-draggable-plus

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

#### Step 1.3: lib.rs更新（マイグレーション紐付け）
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
            // 既存のハンドラー（変更なし）
            permission::check_permissions,
            permission::request_screen_recording_permission,
            permission::request_accessibility_permission,
            screenshot::get_monitors,
            screenshot::capture_screen,
            screenshot::capture_monitor_by_id,
            input::mouse_move,
            input::left_click,
            input::right_click,
            input::middle_click,
            input::double_click,
            input::triple_click,
            input::left_mouse_down,
            input::left_mouse_up,
            input::left_click_drag,
            input::scroll,
            input::type_text,
            input::key,
            input::hold_key,
            control::request_stop,
            control::clear_stop,
            control::is_stop_requested,
            control::wait,
            config::get_api_key,
            config::is_api_key_configured,
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
// ID型をnumber → string (UUID) に変更
export interface Scenario {
  id: string;  // 変更: number → string
  title: string;
  description: string;
  status: ScenarioStatus;
  orderIndex?: number;  // 追加: 並び順
  error?: string;
  iterations?: number;
  startedAt?: Date;
  completedAt?: Date;
  result?: TestResult;
  expectedActions?: ExpectedAction[];
}
```

#### Step 2.3: types/index.ts更新
```typescript
export * from './action';
export * from './capture';
export * from './scenario';
export * from './testResult';
export * from './database';  // 追加
```

#### Step 2.4: services/scenarioParser.ts更新
```typescript
// ID生成をUUIDに変更
export async function parseScenarios(userInput: string): Promise<Scenario[]> {
  try {
    // ... 既存のClaude API呼び出しコード ...

    return result.scenarios.map((s) => ({
      id: crypto.randomUUID(),  // 変更: number → UUID
      title: s.title,
      description: s.description,
      status: 'pending' as const,
    }));
  } catch (error) {
    console.warn('Scenario split failed, treating as single scenario:', error);
    return [
      {
        id: crypto.randomUUID(),  // 変更: number → UUID
        title: 'テストシナリオ',
        description: userInput,
        status: 'pending',
      },
    ];
  }
}
```

#### Step 2.5: services/agentLoop.ts更新（アクション履歴追加）

AgentLoopResult型を拡張：
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
  testResult: TestResult;
  expectedActions?: ExpectedAction[];
  isFromFallback?: boolean;
  // 以下を追加
  /** 実行されたアクション履歴 */
  executedActions: ExecutedActionRecord[];
  /** 完了したアクション数 */
  completedActionCount: number;
  /** 失敗したアクションの説明（ある場合） */
  failedAtAction?: string;
  /** 最後に成功したアクションの説明 */
  lastSuccessfulAction?: string;
}
```

runAgentLoop関数内で実行履歴を記録：
```typescript
// 新規追加: アクション実行履歴
const executedActions: ExecutedActionRecord[] = [];

// 各アクション実行後に記録（for (const toolUse of toolUseBlocks)内）
executedActions.push({
  index: executedActions.length,
  action: action.action,
  description: formatActionDetails(action, captureResult.scaleFactor, captureResult.displayScaleFactor),
  success: actionResult.success,
  timestamp: new Date(),
});

// 戻り値に追加
return {
  success: true,
  iterations: iteration + 1,
  testResult: createTestResult({ ... }),
  expectedActions,
  isFromFallback,
  // 追加フィールド
  executedActions,
  completedActionCount: executedActions.filter(a => a.success).length,
  lastSuccessfulAction: executedActions.filter(a => a.success).pop()?.description,
  failedAtAction: !actionResult.success ? executedActions[executedActions.length - 1]?.description : undefined,
};
```

#### Step 2.6: services/scenarioDatabase.ts作成
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

  // タイトルが空の場合、本文先頭から自動生成
  const finalTitle = title.trim() || generateTitleFromDescription(description);

  await database.execute(
    'INSERT INTO scenarios (id, title, description, order_index) VALUES (?, ?, ?, ?)',
    [id, finalTitle, description, orderIndex]
  );

  return {
    id,
    title: finalTitle,
    description,
    order_index: orderIndex,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

/**
 * 本文からタイトルを自動生成
 * - 先頭行を取得
 * - 30文字で切り詰め
 */
function generateTitleFromDescription(description: string): string {
  const firstLine = description.split('\n')[0].trim();
  if (firstLine.length <= 30) {
    return firstLine || 'シナリオ';
  }
  return firstLine.substring(0, 30) + '...';
}

export async function updateScenario(id: string, title: string, description: string): Promise<void> {
  const database = await getDatabase();
  // タイトルが空の場合、本文先頭から自動生成
  const finalTitle = title.trim() || generateTitleFromDescription(description);

  await database.execute(
    'UPDATE scenarios SET title = ?, description = ?, updated_at = datetime("now") WHERE id = ?',
    [finalTitle, description, id]
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

#### Step 3.1: components/DeleteConfirmDialog.vue作成
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
  <div v-if="visible" class="modal-overlay" @click.self="$emit('cancel')">
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
```

#### Step 3.2: components/ScenarioForm.vue作成（タイトル任意化対応）
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

// タイトルは任意、シナリオ内容のみ必須
const canSave = computed(() => description.value.trim().length > 0);

// タイトルプレースホルダー: 本文から自動生成される旨を表示
const titlePlaceholder = computed(() => {
  if (description.value.trim()) {
    const firstLine = description.value.split('\n')[0].trim();
    const preview = firstLine.length > 20 ? firstLine.substring(0, 20) + '...' : firstLine;
    return `未入力の場合: 「${preview}」`;
  }
  return 'タイトル（省略可 - 本文から自動生成）';
});

watch(() => props.scenario, (newVal) => {
  if (newVal) {
    title.value = newVal.title;
    description.value = newVal.description;
  } else {
    title.value = '';
    description.value = '';
  }
}, { immediate: true });

watch(() => props.visible, (newVal) => {
  if (!newVal) {
    title.value = '';
    description.value = '';
  }
});

function handleSave() {
  if (!canSave.value) return;
  // タイトルが空でも送信（サービス層で自動生成）
  emit('save', title.value.trim(), description.value.trim());
}
</script>

<template>
  <div v-if="visible" class="modal-overlay" @click.self="$emit('cancel')">
    <div class="modal scenario-form-modal">
      <h2>{{ modalTitle }}</h2>
      <div class="form-group">
        <label for="title-input">タイトル <span class="optional-label">（省略可）</span></label>
        <input
          id="title-input"
          v-model="title"
          type="text"
          :placeholder="titlePlaceholder"
        />
        <p class="hint-text">未入力の場合、シナリオ内容の先頭から自動生成されます</p>
      </div>
      <div class="form-group">
        <label for="description-input">シナリオ内容 <span class="required-label">*</span></label>
        <textarea
          id="description-input"
          v-model="description"
          rows="10"
          placeholder="テストシナリオの詳細を入力...&#10;&#10;例:&#10;1. Chromeを開く&#10;2. google.comにアクセス&#10;3. 'Tauri framework'を検索"
        ></textarea>
      </div>
      <div class="button-row">
        <button @click="$emit('cancel')" class="secondary-button">キャンセル</button>
        <button @click="handleSave" class="primary-button" :disabled="!canSave">
          {{ isEditing ? '保存' : '登録' }}
        </button>
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
  width: 90%;
  max-width: 600px;
}
@media (prefers-color-scheme: dark) {
  .modal {
    background: #2a2a2a;
    color: #f6f6f6;
  }
}
.form-group {
  margin-bottom: 16px;
}
.form-group label {
  display: block;
  margin-bottom: 6px;
  font-weight: 500;
}
.optional-label {
  font-weight: normal;
  color: #888;
  font-size: 0.9em;
}
.required-label {
  color: #dc3545;
}
.hint-text {
  font-size: 12px;
  color: #888;
  margin-top: 4px;
  margin-bottom: 0;
}
.form-group input,
.form-group textarea {
  width: 100%;
  padding: 10px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 14px;
  font-family: inherit;
}
@media (prefers-color-scheme: dark) {
  .form-group input,
  .form-group textarea {
    background: #333;
    border-color: #555;
    color: #f6f6f6;
  }
}
.form-group textarea {
  resize: vertical;
  min-height: 150px;
}
.button-row {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 20px;
}
.primary-button {
  background: #24c8db;
  color: white;
  padding: 10px 20px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.primary-button:disabled {
  background: #999;
  cursor: not-allowed;
}
.secondary-button {
  background: #6c757d;
  color: white;
  padding: 10px 20px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
</style>
```

#### Step 3.3: components/ScenarioList.vue作成
```vue
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

// ローカルでシナリオリストを管理（ドラッグ用）
const localScenarios = computed({
  get: () => props.scenarios,
  set: (val) => emit('update:order', val),
});

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

/**
 * 選択されたシナリオIDを現在の並び順で取得
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
    <div class="list-header" v-if="scenarios.length > 0">
      <label class="checkbox-label">
        <input type="checkbox" v-model="allSelected" :disabled="isRunning" />
        <span>すべて選択</span>
      </label>
    </div>

    <div v-if="scenarios.length === 0" class="empty-message">
      シナリオがありません。<br>
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
        <div class="scenario-row" :class="{ selected: selectedIds.has(element.id) }">
          <span class="drag-handle" v-if="!isRunning" title="ドラッグして並び替え">☰</span>
          <span class="drag-handle disabled" v-else>☰</span>
          <span class="order-number">{{ index + 1 }}</span>
          <input
            type="checkbox"
            :checked="selectedIds.has(element.id)"
            @change="toggleSelection(element.id)"
            :disabled="isRunning"
          />
          <div class="scenario-info">
            <span class="scenario-title">{{ element.title }}</span>
            <span class="scenario-description">{{ element.description.substring(0, 50) }}{{ element.description.length > 50 ? '...' : '' }}</span>
          </div>
          <div class="actions">
            <button @click="$emit('edit', element)" :disabled="isRunning" class="edit-button">編集</button>
            <button @click="$emit('delete', element)" :disabled="isRunning" class="delete-button">削除</button>
          </div>
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
.drag-handle {
  cursor: grab;
  font-size: 18px;
  color: #888;
  user-select: none;
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
.edit-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.delete-button {
  background: #dc3545;
  color: white;
}
.delete-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
```

### Phase 4: 結果表示ウィンドウ（ハンドシェイク方式）

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
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
});
```

#### Step 4.2: result.html作成（プロジェクトルート）
```html
<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>実行結果 - Xenotester</title>
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

#### Step 4.4: src/pages/ResultPage.vue作成（ハンドシェイク対応）
```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { listen, emit } from '@tauri-apps/api/event';
import type { BatchExecutionResult, ExecutedAction } from '../types';

const result = ref<BatchExecutionResult | null>(null);
const isReady = ref(false);

onMounted(async () => {
  // 結果受信用リスナーを設定
  await listen<BatchExecutionResult>('execution-result', (event) => {
    result.value = event.payload;
  });

  // リスナー準備完了を通知（ハンドシェイク）
  isReady.value = true;
  await emit('result-window-ready');
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
        <div class="summary-grid">
          <div class="summary-item">
            <span class="label">実行シナリオ数</span>
            <span class="value">{{ result.totalScenarios }}</span>
          </div>
          <div class="summary-item success">
            <span class="label">成功</span>
            <span class="value">{{ result.successCount }}</span>
          </div>
          <div class="summary-item failure">
            <span class="label">失敗</span>
            <span class="value">{{ result.failureCount }}</span>
          </div>
        </div>
        <p class="executed-at">実行日時: {{ new Date(result.executedAt).toLocaleString() }}</p>
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

<style>
:root {
  font-family: Inter, Avenir, Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 24px;
  color: #0f0f0f;
  background-color: #f6f6f6;
}

@media (prefers-color-scheme: dark) {
  :root {
    color: #f6f6f6;
    background-color: #1a1a1a;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 0;
}
</style>

<style scoped>
.result-page {
  padding: 20px;
  max-width: 800px;
  margin: 0 auto;
}

h1 {
  color: #24c8db;
  margin-bottom: 20px;
}

.loading {
  text-align: center;
  padding: 40px;
  color: #888;
}

.summary-section {
  background: #f8f9fa;
  padding: 20px;
  border-radius: 12px;
  margin-bottom: 24px;
}

@media (prefers-color-scheme: dark) {
  .summary-section {
    background: #2a2a2a;
  }
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-top: 16px;
}

.summary-item {
  text-align: center;
  padding: 16px;
  background: white;
  border-radius: 8px;
}

@media (prefers-color-scheme: dark) {
  .summary-item {
    background: #333;
  }
}

.summary-item .label {
  display: block;
  font-size: 12px;
  color: #888;
}

.summary-item .value {
  display: block;
  font-size: 28px;
  font-weight: bold;
  margin-top: 4px;
}

.summary-item.success .value {
  color: #28a745;
}

.summary-item.failure .value {
  color: #dc3545;
}

.executed-at {
  font-size: 12px;
  color: #888;
  margin-top: 16px;
}

.result-item {
  border: 1px solid #ddd;
  border-radius: 8px;
  margin-bottom: 16px;
  overflow: hidden;
}

@media (prefers-color-scheme: dark) {
  .result-item {
    border-color: #444;
  }
}

.result-item.success {
  border-left: 4px solid #28a745;
}

.result-item.failure {
  border-left: 4px solid #dc3545;
}

.result-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: #f8f9fa;
}

@media (prefers-color-scheme: dark) {
  .result-header {
    background: #333;
  }
}

.scenario-number {
  font-weight: bold;
  color: #24c8db;
}

.scenario-title {
  flex: 1;
}

.badge-success {
  background: #28a745;
  color: white;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
}

.badge-failure {
  background: #dc3545;
  color: white;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
}

.result-body {
  padding: 16px;
}

.failure-info {
  background: rgba(220, 53, 69, 0.1);
  padding: 12px;
  border-radius: 6px;
  margin-top: 12px;
}

@media (prefers-color-scheme: dark) {
  .failure-info {
    background: rgba(220, 53, 69, 0.2);
  }
}

.failure-info p {
  margin: 8px 0;
}

.action-history {
  margin-top: 12px;
}

.action-history summary {
  cursor: pointer;
  color: #24c8db;
}

.action-history pre {
  background: #f5f5f5;
  padding: 12px;
  border-radius: 4px;
  font-size: 12px;
  overflow-x: auto;
  margin-top: 8px;
}

@media (prefers-color-scheme: dark) {
  .action-history pre {
    background: #333;
  }
}
</style>
```

#### Step 4.5: services/resultWindowService.ts作成（ハンドシェイク方式）
```typescript
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { BatchExecutionResult } from '../types';

let resultWindow: WebviewWindow | null = null;

/**
 * 結果ウィンドウを開き、実行結果を表示
 * ハンドシェイク方式: 結果ウィンドウからの「準備完了」イベントを待ってから送信
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

  // ウィンドウ作成を待つ
  await new Promise<void>((resolve, reject) => {
    resultWindow!.once('tauri://created', () => {
      resolve();
    });
    resultWindow!.once('tauri://error', (e) => {
      reject(new Error(`Window creation failed: ${e}`));
    });
  });

  // ハンドシェイク: 結果ウィンドウからの「準備完了」イベントを待つ
  await new Promise<void>((resolve) => {
    let unlisten: UnlistenFn | null = null;
    let timeoutId: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      if (unlisten) unlisten();
      clearTimeout(timeoutId);
    };

    listen('result-window-ready', () => {
      cleanup();
      resolve();
    }).then((fn) => {
      unlisten = fn;
    });

    // タイムアウト: 5秒待っても準備完了が来なければ続行（フォールバック）
    timeoutId = setTimeout(() => {
      console.warn('[ResultWindow] Handshake timeout - proceeding anyway');
      cleanup();
      resolve();
    }, 5000);
  });

  // 結果データを送信（emitTo で特定ウィンドウに送信）
  await resultWindow.emit('execution-result', result);
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

### Phase 5: シナリオ実行ロジック更新（既存ScenarioRunner拡張）

#### Step 5.1: services/scenarioRunner.ts更新

既存の `ScenarioRunner` クラスを拡張して選択実行に対応。`emergency-stop` イベントリスナーを継承。

```typescript
// 新しいインポートを追加
import type { BatchExecutionResult, ScenarioExecutionResult, StoredScenario } from '../types';

// ScenarioRunner クラスに新メソッドを追加
export class ScenarioRunner {
  // ... 既存のコード（変更なし）...

  /**
   * 選択されたシナリオを順序通りに実行（StoredScenario版）
   * 既存のemergency-stopリスナーを活用
   * @param orderedScenarioIds - 実行順序が保証されたシナリオID配列
   * @param scenarios - 全シナリオデータ
   */
  public async runSelected(
    orderedScenarioIds: string[],
    scenarios: StoredScenario[],
    options: ScenarioRunnerOptions = {}
  ): Promise<BatchExecutionResult> {
    const results: ScenarioExecutionResult[] = [];
    let successCount = 0;
    let failureCount = 0;

    // 既存のstate管理を初期化
    this.state = {
      scenarios: [],
      currentIndex: 0,
      isRunning: true,
      stopOnFailure: options.stopOnFailure ?? false,
    };

    this.onStateChange = options.onStateChange;
    this.onLog = options.onLog;
    this.abortController = new AbortController();

    // 停止リクエストをクリア
    await invoke('clear_stop');

    // orderedScenarioIds の順序で実行（順序保証）
    for (let i = 0; i < orderedScenarioIds.length; i++) {
      const scenarioId = orderedScenarioIds[i];

      // 停止チェック（既存のemergency-stopリスナーにより isRunning が false になる場合も含む）
      if (!this.state.isRunning) {
        this.log('[Batch Runner] Execution stopped');
        break;
      }

      const stopRequested = await invoke<boolean>('is_stop_requested');
      if (stopRequested || this.abortController.signal.aborted) {
        this.log('[Batch Runner] Stop requested');
        break;
      }

      const scenario = scenarios.find(s => s.id === scenarioId);
      if (!scenario) continue;

      this.state.currentIndex = i;
      this.log(`[Batch Runner] シナリオ開始 (${i + 1}/${orderedScenarioIds.length}): ${scenario.title}`);

      // シナリオを実行
      const agentResult = await runAgentLoop({
        scenario: {
          id: scenario.id,
          title: scenario.title,
          description: scenario.description,
          status: 'pending',
        },
        abortSignal: this.abortController.signal,
        onLog: this.log.bind(this),
        config: options.agentConfig,
      });

      // 結果を変換
      const executionResult: ScenarioExecutionResult = {
        scenarioId: scenario.id,
        title: scenario.title,
        success: agentResult.success,
        error: agentResult.error,
        completedActions: agentResult.completedActionCount ?? 0,
        failedAtAction: agentResult.failedAtAction,
        actionHistory: agentResult.executedActions ?? [],
        lastSuccessfulAction: agentResult.lastSuccessfulAction,
      };

      results.push(executionResult);

      if (agentResult.success) {
        successCount++;
        this.log(`[Batch Runner] シナリオ成功: ${scenario.title}`);
      } else {
        failureCount++;
        this.log(`[Batch Runner] シナリオ失敗: ${scenario.title} - ${agentResult.error}`);

        // stopOnFailure が設定されている場合は中断
        if (this.state.stopOnFailure) {
          this.log('[Batch Runner] stopOnFailure enabled - stopping');
          break;
        }
      }
    }

    this.state.isRunning = false;

    return {
      totalScenarios: orderedScenarioIds.length,
      successCount,
      failureCount,
      results,
      executedAt: new Date(),
    };
  }
}

// 既存のシングルトンインスタンスをそのまま使用
export const scenarioRunner = new ScenarioRunner();

/**
 * 便利関数: シングルトンを使って選択実行
 */
export async function runSelectedScenarios(
  orderedScenarioIds: string[],
  scenarios: StoredScenario[],
  options: ScenarioRunnerOptions = {}
): Promise<BatchExecutionResult> {
  return scenarioRunner.runSelected(orderedScenarioIds, scenarios, options);
}
```

### Phase 6: メインアプリ統合

#### Step 6.1: App.vue完全改修
```vue
<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import ScenarioList from './components/ScenarioList.vue';
import ScenarioForm from './components/ScenarioForm.vue';
import DeleteConfirmDialog from './components/DeleteConfirmDialog.vue';
import {
  getAllScenarios,
  createScenario,
  updateScenario,
  deleteScenario,
  updateScenarioOrders
} from './services/scenarioDatabase';
import { runSelectedScenarios } from './services/scenarioRunner';
import { openResultWindow } from './services/resultWindowService';
import type { StoredScenario, PermissionStatus } from './types';

// State
const scenarios = ref<StoredScenario[]>([]);
const selectedIds = ref<Set<string>>(new Set());
const isRunning = ref(false);
const logs = ref<string[]>([]);

// Modal state
const showForm = ref(false);
const editingScenario = ref<StoredScenario | null>(null);
const showDeleteConfirm = ref(false);
const deletingScenario = ref<StoredScenario | null>(null);

// Refs
const scenarioListRef = ref<InstanceType<typeof ScenarioList> | null>(null);

// Permission & API state
const permissionStatus = ref<PermissionStatus | null>(null);
const apiKeyConfigured = ref(false);

onMounted(async () => {
  // Load scenarios
  scenarios.value = await getAllScenarios();

  // Check permissions
  try {
    permissionStatus.value = await invoke<PermissionStatus>('check_permissions');
    apiKeyConfigured.value = await invoke<boolean>('is_api_key_configured', { keyName: 'anthropic' });
  } catch (error) {
    console.error('Initialization error:', error);
  }
});

// Request permissions
async function requestPermissions() {
  try {
    await invoke('request_screen_recording_permission');
    await invoke('request_accessibility_permission');
    permissionStatus.value = await invoke<PermissionStatus>('check_permissions');
  } catch (error) {
    console.error('Permission request error:', error);
  }
}

// シナリオ操作
function handleNewScenario() {
  editingScenario.value = null;
  showForm.value = true;
}

function handleEditScenario(scenario: StoredScenario) {
  editingScenario.value = scenario;
  showForm.value = true;
}

async function handleSaveScenario(title: string, description: string) {
  if (editingScenario.value) {
    // 編集
    await updateScenario(editingScenario.value.id, title, description);
    const idx = scenarios.value.findIndex(s => s.id === editingScenario.value!.id);
    if (idx !== -1) {
      // タイトルが空の場合は自動生成されるので、再取得
      const updatedScenarios = await getAllScenarios();
      scenarios.value = updatedScenarios;
    }
  } else {
    // 新規作成
    const newScenario = await createScenario(title, description);
    scenarios.value.push(newScenario);
  }
  showForm.value = false;
  editingScenario.value = null;
}

function handleDeleteClick(scenario: StoredScenario) {
  deletingScenario.value = scenario;
  showDeleteConfirm.value = true;
}

async function confirmDelete() {
  if (!deletingScenario.value) return;

  await deleteScenario(deletingScenario.value.id);
  scenarios.value = scenarios.value.filter(s => s.id !== deletingScenario.value!.id);
  selectedIds.value.delete(deletingScenario.value.id);

  showDeleteConfirm.value = false;
  deletingScenario.value = null;
}

function cancelDelete() {
  showDeleteConfirm.value = false;
  deletingScenario.value = null;
}

// 順序変更
async function handleOrderChange(newScenarios: StoredScenario[]) {
  scenarios.value = newScenarios;

  // DBの順序を更新
  const orders = newScenarios.map((s, idx) => ({ id: s.id, orderIndex: idx }));
  await updateScenarioOrders(orders);
}

// 選択されたシナリオを実行
async function executeSelected() {
  if (selectedIds.value.size === 0) return;

  isRunning.value = true;
  logs.value = [];

  try {
    // 順序保証: ScenarioListから並び順でIDを取得
    const orderedIds = scenarioListRef.value?.getSelectedIdsInOrder() ?? [];

    addLog(`${orderedIds.length}件のシナリオを実行開始...`);

    const result = await runSelectedScenarios(
      orderedIds,
      scenarios.value,
      {
        stopOnFailure: false,
        onLog: addLog,
      }
    );

    addLog(`実行完了: 成功=${result.successCount}, 失敗=${result.failureCount}`);

    // 新規ウィンドウで結果を表示
    await openResultWindow(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    addLog(`エラー: ${msg}`);
  } finally {
    isRunning.value = false;
  }
}

function addLog(message: string) {
  const timestamp = new Date().toLocaleTimeString();
  logs.value.push(`[${timestamp}] ${message}`);
}
</script>

<template>
  <main class="container">
    <header class="app-header">
      <div>
        <h1>Xenotester</h1>
        <p class="subtitle">AI Desktop Agent for Automated Testing</p>
      </div>
      <button @click="handleNewScenario" :disabled="isRunning" class="primary-button">
        新規シナリオ登録
      </button>
    </header>

    <!-- Permission Warning -->
    <div
      v-if="permissionStatus && (!permissionStatus.screenRecording || !permissionStatus.accessibility)"
      class="warning-box"
    >
      <p>
        <strong>Permissions Required:</strong>
        Screen Recording and Accessibility permissions are required.
      </p>
      <button @click="requestPermissions">Request Permissions</button>
    </div>

    <!-- API Key Warning -->
    <div v-if="!apiKeyConfigured" class="warning-box">
      <p>
        <strong>API Key Required:</strong>
        Please set ANTHROPIC_API_KEY in your .env file.
      </p>
    </div>

    <!-- Scenario List -->
    <section class="scenario-section">
      <ScenarioList
        ref="scenarioListRef"
        :scenarios="scenarios"
        :selected-ids="selectedIds"
        :is-running="isRunning"
        @update:selected-ids="selectedIds = $event"
        @update:order="handleOrderChange"
        @edit="handleEditScenario"
        @delete="handleDeleteClick"
      />

      <div class="action-bar">
        <button
          @click="executeSelected"
          :disabled="isRunning || selectedIds.size === 0 || !apiKeyConfigured"
          class="execute-button"
        >
          {{ isRunning ? '実行中...' : `チェックされたシナリオを実行する (${selectedIds.size}件)` }}
        </button>
      </div>
    </section>

    <!-- Execution Log -->
    <section class="log-section" v-if="logs.length > 0">
      <h2>実行ログ</h2>
      <div class="log-container">
        <div v-for="(log, index) in logs" :key="index" class="log-item">
          {{ log }}
        </div>
      </div>
    </section>

    <!-- Modals -->
    <ScenarioForm
      :visible="showForm"
      :scenario="editingScenario"
      @save="handleSaveScenario"
      @cancel="showForm = false"
    />

    <DeleteConfirmDialog
      :visible="showDeleteConfirm"
      :scenario-title="deletingScenario?.title ?? ''"
      @confirm="confirmDelete"
      @cancel="cancelDelete"
    />
  </main>
</template>

<style>
/* 既存のグローバルスタイルを維持 */
:root {
  font-family: Inter, Avenir, Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 24px;
  font-weight: 400;
  color: #0f0f0f;
  background-color: #f6f6f6;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

@media (prefers-color-scheme: dark) {
  :root {
    color: #f6f6f6;
    background-color: #1a1a1a;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 0;
}
</style>

<style scoped>
.container {
  max-width: 900px;
  margin: 0 auto;
  padding: 20px;
}

.app-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 24px;
}

h1 {
  margin: 0;
  color: #24c8db;
}

.subtitle {
  color: #888;
  margin: 4px 0 0 0;
}

.primary-button {
  background-color: #24c8db;
  color: #fff;
  padding: 10px 20px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}

.primary-button:disabled {
  background-color: #999;
  cursor: not-allowed;
}

.warning-box {
  padding: 15px;
  border-radius: 8px;
  margin-bottom: 20px;
  background-color: #fff3cd;
  border: 1px solid #ffc107;
  color: #856404;
}

@media (prefers-color-scheme: dark) {
  .warning-box {
    background-color: #332701;
    border-color: #665200;
    color: #ffc107;
  }
}

.scenario-section {
  margin-bottom: 24px;
}

.action-bar {
  margin-top: 16px;
  display: flex;
  justify-content: center;
}

.execute-button {
  background-color: #28a745;
  color: white;
  padding: 14px 32px;
  border: none;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.2s;
}

.execute-button:hover:not(:disabled) {
  background-color: #218838;
}

.execute-button:disabled {
  background-color: #6c757d;
  cursor: not-allowed;
}

.log-section h2 {
  font-size: 1.2rem;
  margin-bottom: 10px;
}

.log-container {
  height: 150px;
  overflow-y: auto;
  padding: 12px;
  border: 1px solid #ddd;
  border-radius: 8px;
  background-color: #1a1a1a;
  color: #0f0;
  font-family: 'Courier New', monospace;
  font-size: 12px;
}

.log-item {
  margin-bottom: 4px;
}
</style>
```

### Phase 7: 設定ファイル更新

#### Step 7.1: tauri.conf.json更新
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "xenotester",
  "version": "0.1.0",
  "identifier": "com.satoshizerocolored.xenotester",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
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
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

#### Step 7.2: package.json更新
```json
{
  "dependencies": {
    "vue": "^3.5.13",
    "@tauri-apps/api": "^2",
    "@tauri-apps/plugin-opener": "^2",
    "@anthropic-ai/sdk": "^0.52.0",
    "@tauri-apps/plugin-sql": "^2",
    "vue-draggable-plus": "^0.5"
  }
}
```

#### Step 7.3: services/index.ts更新
```typescript
export * from './agentLoop';
export * from './claudeClient';
export * from './historyManager';
export * from './scenarioParser';
export * from './scenarioRunner';
export * from './scenarioDatabase';
export * from './resultWindowService';
```

---

## 4. 技術的考慮事項

### 4.1 パフォーマンス
- SQLiteはローカルファイルベースのため、シナリオ数が数百件程度であれば問題なし
- ドラッグ&ドロップ時の順序更新はバッチ処理で効率化

### 4.2 セキュリティ
- SQLインジェクション: プレースホルダーを使用したクエリで対策済み
- データベースファイルはアプリのデータディレクトリに保存（ユーザーごとに分離）

### 4.3 既存機能への影響
- **scenarioParser.ts**: ID型をnumber→stringに変更
- **agentLoop.ts**: 戻り値にアクション履歴情報を追加
- **scenarioRunner.ts**: 既存クラスを拡張、`emergency-stop`リスナーを継承
- **緊急停止機能**: 既存の仕組みがそのまま機能（ScenarioRunnerクラスを拡張したため）

### 4.4 データ移行
- 現在はデータ永続化がないため、移行は不要
- 初回起動時にSQLiteデータベースが自動作成される

### 4.5 順序保証
- **重要**: `Set<string>`は順序を保証しないため、実行時は`scenarios`配列の順序を基準とする
- `ScenarioList.vue`の`getSelectedIdsInOrder()`メソッドで、現在の並び順に基づいた選択済みID配列を取得
- `runSelectedScenarios()`は`orderedScenarioIds`パラメータの順序で厳密に実行

### 4.6 結果ウィンドウのハンドシェイク
- **問題**: 固定待機（setTimeout）では Vue の初期化タイミングに依存し不安定
- **解決**: ResultPage.vue が `onMounted` で `result-window-ready` イベントを発火
- resultWindowService.ts がこのイベントを待機してから結果を送信
- タイムアウト（5秒）を設けてフォールバック対応

### 4.7 タイトル自動生成
- **問題**: タイトル入力必須は依頼の「テキストエリアで登録」より操作が増える
- **解決**: タイトルを任意化し、未入力時は本文先頭30文字から自動生成
- scenarioDatabase.ts の `createScenario` / `updateScenario` で処理

---

## 5. テスト計画

### 5.1 ユニットテスト
| テスト対象 | テスト内容 |
|-----------|-----------|
| scenarioDatabase.ts | CRUD操作、順序更新、タイトル自動生成 |
| ScenarioList.vue | チェックボックス操作、ドラッグ&ドロップ、getSelectedIdsInOrder() |
| ScenarioForm.vue | フォームバリデーション、タイトル省略時の動作 |
| DeleteConfirmDialog.vue | 確認/キャンセル動作 |
| agentLoop.ts | アクション履歴の記録、失敗情報の収集 |
| resultWindowService.ts | ハンドシェイク成功/タイムアウト時の動作 |

### 5.2 統合テスト
| テスト内容 |
|-----------|
| シナリオ登録→一覧表示→編集→削除の一連フロー |
| タイトル未入力で登録した際、本文から自動生成されること |
| 削除時に確認ダイアログが表示され、確認後のみ削除されること |
| 複数シナリオの順序変更が永続化されること |
| 選択したシナリオが**並び順通りに**実行されること |
| 実行中にemergency-stopで停止できること |
| 実行結果が新規ウィンドウで正しく表示されること（ハンドシェイク） |
| 失敗時に「どこまで行けた/次に行けなかった」情報が表示されること |

### 5.3 E2Eテスト
| テスト内容 |
|-----------|
| 10件のシナリオを登録し、5件を選択して実行 |
| ドラッグ&ドロップで順序変更後、アプリ再起動で順序が維持されていること |
| 実行結果ウィンドウが正しく開き、全シナリオの結果が表示されること |
| 3番目のシナリオで失敗した場合、どこまで進んだかが表示されること |
| 結果ウィンドウの読み込みが遅い場合でもハンドシェイクが機能すること |

---

## 6. リスクと対策

| リスク | 影響度 | 対策 |
|--------|--------|------|
| SQLiteプラグインの互換性問題 | 中 | Tauri公式プラグインを使用、最新版2.3.1を使用 |
| ドラッグ&ドロップの操作性（タッチデバイス） | 低 | vue-draggable-plusはタッチ対応、フォールバックとして上下ボタン追加可能 |
| 大量シナリオ時のパフォーマンス | 低 | ページネーションまたは仮想スクロール導入（必要に応じて） |
| マルチウィンドウ間通信の複雑さ | 中 | ハンドシェイク方式で確実な受信を保証、タイムアウトでフォールバック |
| データベースファイル破損 | 低 | SQLiteの堅牢性、定期バックアップ機能の追加を検討 |
| アクション履歴の肥大化 | 低 | 履歴は実行完了後のみ保持、DBには保存しない |
| 結果ウィンドウの準備遅延 | 低 | 5秒のハンドシェイクタイムアウトでフォールバック対応 |

---

## 7. 調査ログ

### 7.1 実行した検索語
| ツール | パターン |
|--------|----------|
| Glob | `src/**/*.{ts,tsx,vue}` |
| Glob | `src-tauri/src/**/*.rs` |
| Glob | `*.{json,toml}` |
| Grep | `sqlite`, `sql`, `database` |
| Grep | `scenario` |
| Grep | `emergency-stop` |
| WebSearch | `tauri-plugin-sql sqlite 2024 2025` |
| WebSearch | `vue 3 drag and drop sortable list library 2025` |

### 7.2 読んだファイル一覧

#### フロントエンド (src/) - 全18ファイル確認
- `src/App.vue` - メインコンポーネント（現行UI）
- `src/main.ts` - エントリーポイント
- `src/services/` 配下 7ファイル全て確認
  - agentLoop.ts, claudeClient.ts, historyManager.ts, scenarioParser.ts, scenarioRunner.ts, resultJudge.ts, actionValidator.ts, index.ts
- `src/types/` 配下 5ファイル全て確認
  - action.ts, capture.ts, scenario.ts, index.ts, testResult.ts
- `src/utils/` 配下 3ファイル全て確認
  - coordinateScaler.ts, loopDetector.ts, index.ts

#### バックエンド (src-tauri/) - 全17ファイル確認
- `src-tauri/Cargo.toml` - Rust依存関係
- `src-tauri/tauri.conf.json` - Tauri設定
- `src-tauri/src/main.rs` - エントリーポイント
- `src-tauri/src/lib.rs` - ライブラリルート
- `src-tauri/src/state.rs` - アプリ状態
- `src-tauri/src/commands/` 配下 6ファイル全て確認
  - mod.rs, config.rs, control.rs, input.rs, permission.rs, screenshot.rs
- `src-tauri/src/services/` 配下 5ファイル確認
  - mod.rs, capture.rs, image_processor.rs, keyboard.rs, mouse.rs

#### 設定ファイル
- `package.json` - npm依存関係
- `tsconfig.json` - TypeScript設定
- `vite.config.ts` - Vite設定

### 7.3 辿った依存チェーン
1. `App.vue` → `scenarioParser` → `claudeClient` → `types/scenario`
2. `App.vue` → `scenarioRunner` → `agentLoop` → `types/action`, `types/capture`
3. `lib.rs` → `commands/*` → `services/*` → `state`
4. `scenario.ts` → `testResult.ts` (TestResult, ExpectedAction型)
5. `scenarioRunner.ts` → `agentLoop` → 停止処理（emergency-stop, is_stop_requested）

### 7.4 非TSファイル確認
- [x] package.json - 依存関係確認
- [x] Cargo.toml - Rust依存関係確認
- [x] tauri.conf.json - Tauri設定確認
- [x] tsconfig.json - TypeScript設定確認
- [x] vite.config.ts - Vite設定確認

### 7.5 調査中に発見した関連情報
1. **Tauri 2.0のSQLプラグイン**: 最新版は2.3.1（2025-10-27リリース）。マイグレーション機能内蔵
2. **Vue Draggable Plus**: Vue 3向けの最新ドラッグ&ドロップライブラリ。SortableJS基盤
3. **現行のScenario型**: `id`が`number`型、UUID（`string`）への変更が必要
4. **agentLoop.ts**: アクション履歴（actionHistory）は内部変数として存在するが外部に公開されていない→拡張が必要
5. **ScenarioRunner**: `emergency-stop` イベントリスナーを持つ既存クラス。新機能はこのクラスを拡張して実装

---

## 8. フィードバック対応履歴 (v2.1)

### 対応済みフィードバック

| 重大度 | 指摘内容 | 対応 |
|--------|----------|------|
| 中 | resultWindowService.ts の固定待機（setTimeout(500)）が不安定 | ハンドシェイク方式に変更。ResultPage.vueが`result-window-ready`イベントを発火し、それを待ってから結果送信。5秒タイムアウトでフォールバック対応 |
| 低 | ScenarioForm.vue でタイトル入力が必須 | タイトルを任意化。未入力時は本文先頭30文字から自動生成。UIにヒントテキスト追加 |
| 低 | runSelectedScenarios が emergency-stop を経由しない | 既存 ScenarioRunner クラスを拡張して `runSelected` メソッドを追加。既存の `emergency-stop` リスナーとisRunning状態を継承 |

---

## 9. 参考リンク

- [Tauri SQL Plugin公式ドキュメント](https://v2.tauri.app/plugin/sql/)
- [Vue Draggable Plus](https://vue-draggable-plus.pages.dev/)
- [Tauri 2.0 + SQLite チュートリアル](https://dev.to/focuscookie/tauri-20-sqlite-db-react-2aem)
- [Tauri WebviewWindow API](https://v2.tauri.app/reference/javascript/api/namespacewebviewwindow/)
- [tauri-plugin-sql crates.io](https://crates.io/crates/tauri-plugin-sql)

---

計画書ファイルパス: /Users/satoshizerocolored/dev/localtester2/implementation-plan-scenario-management-v2.md
