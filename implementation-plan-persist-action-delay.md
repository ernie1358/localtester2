# 実装計画書: アクション待機時間の永続化

## 概要

UI上の「各アクション後の待機時間」設定をlocalStorageに保存し、アプリ再起動後も前回選択した値が維持されるようにする。ユーザーがUI上のセレクトボックスで値を変更したときのみ保存を行う。

## 現状分析

### 現在の実装

- **場所**: `src/App.vue` (34-42行目)
- **状態管理**: `const actionDelayMs = ref(1000);` でデフォルト値1000msを設定
- **UI**: セレクトボックス (`v-model="actionDelayMs"`) で0秒〜5秒の選択肢を提供
- **使用箇所**: `executeSelected()` 関数内で `agentConfig.actionDelayMs` として `scenarioRunner` に渡される

```typescript
// 現状のコード (App.vue:34-42)
const actionDelayMs = ref(1000);
const actionDelayOptions = [
  { value: 0, label: '0秒' },
  { value: 500, label: '0.5秒' },
  { value: 1000, label: '1秒' },
  { value: 2000, label: '2秒' },
  { value: 3000, label: '3秒' },
  { value: 5000, label: '5秒' },
];
```

### 保存方法の検討

- **localStorage**: 既にSupabaseクライアント (`src/services/supabaseClient.ts:16`) で使用されており、追加依存なしで利用可能
- **Tauri Store Plugin**: 未使用のため導入コストがかかる
- **SQLite**: シナリオ管理に使用中だが、単一設定値の保存には過剰

**結論**: シンプルで追加依存のない `localStorage` を使用

### 保存タイミングの設計方針

**問題点**: `watch` を使用すると、初期読み込み時の `actionDelayMs.value = parsed` でも発火してしまい、「ユーザー操作時のみ保存」の要件を満たせない。

**解決策**: `@change` イベントハンドラを使用し、ユーザーがセレクトボックスを操作したときのみ保存処理を実行する。これにより、初期読み込み時の値更新では保存が発生しない。

## 影響範囲

### 変更が必要なファイル

| ファイル | 変更内容 | 理由 |
|---------|---------|------|
| `src/App.vue` | localStorageからの読み込み・保存ロジック追加 | メインの状態管理箇所 |

### 変更しないが影響を受けるファイル（なし）

- `src/services/scenarioRunner.ts`: 変更なし（`agentConfig.actionDelayMs`を受け取るだけ）
- `src/services/agentLoop.ts`: 変更なし（`config.actionDelayMs`を使用するだけ）
- `src/types/action.ts`: 変更なし（型定義は既存のまま）

## 実装ステップ

### ステップ1: localStorage のキー定義

```typescript
// src/App.vue に追加
const LOCAL_STORAGE_KEY_ACTION_DELAY = 'xenotester_action_delay_ms';
```

### ステップ2: 初期値読み込みロジックの実装

`onMounted` 内で localStorage から値を読み込み、有効な値であれば `actionDelayMs` を更新する。
localStorage が無効化されている環境でも例外が発生しないよう、try-catch で囲む。

```typescript
// 初期化時の読み込み（onMounted 内に配置）
try {
  const loadedDelay = localStorage.getItem(LOCAL_STORAGE_KEY_ACTION_DELAY);
  if (loadedDelay !== null) {
    const parsed = parseInt(loadedDelay, 10);
    // actionDelayOptions に存在する値のみ許可（不正値対策）
    if (actionDelayOptions.some(opt => opt.value === parsed)) {
      actionDelayMs.value = parsed;
    }
  }
} catch (e) {
  // localStorage 非対応環境ではデフォルト値を使用
  console.warn('Failed to load action delay setting from localStorage:', e);
}
```

### ステップ3: 保存ロジックの実装（@change イベントハンドラを使用）

**重要**: `watch` ではなく `@change` イベントハンドラを使用することで、ユーザーがUI上でセレクトボックスを操作したときのみ保存が実行される。初期読み込み時の値更新では発火しない。

```typescript
// 保存用関数（Methods セクションに追加）
function saveActionDelay() {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY_ACTION_DELAY, String(actionDelayMs.value));
  } catch (e) {
    // localStorage 非対応環境ではエラーを無視
    console.warn('Failed to save action delay setting to localStorage:', e);
  }
}
```

### ステップ4: テンプレートの変更

セレクトボックスに `@change` イベントハンドラを追加する。

```html
<!-- 変更前 -->
<select
  id="action-delay"
  v-model="actionDelayMs"
  :disabled="isRunning"
>

<!-- 変更後 -->
<select
  id="action-delay"
  v-model="actionDelayMs"
  :disabled="isRunning"
  @change="saveActionDelay"
>
```

### ステップ5: 実装の配置場所

```typescript
// App.vue の script setup 内

// 1. キー定義（定数として上部に配置）
const LOCAL_STORAGE_KEY_ACTION_DELAY = 'xenotester_action_delay_ms';

// 2. 状態定義（既存）
const actionDelayMs = ref(1000);
const actionDelayOptions = [...]; // 既存

// 3. onMounted 内で読み込み（認証チェックの try-catch 内、最初に実行）
onMounted(async () => {
  // localStorage から設定を読み込み（認証チェック前に実行可能）
  try {
    const loadedDelay = localStorage.getItem(LOCAL_STORAGE_KEY_ACTION_DELAY);
    if (loadedDelay !== null) {
      const parsed = parseInt(loadedDelay, 10);
      if (actionDelayOptions.some(opt => opt.value === parsed)) {
        actionDelayMs.value = parsed;
      }
    }
  } catch (e) {
    console.warn('Failed to load action delay setting from localStorage:', e);
  }

  try {
    // Check authentication state（既存の処理）
    // ...
  }
  // ...
});

// 4. Methods セクションに保存関数を追加
function saveActionDelay() {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY_ACTION_DELAY, String(actionDelayMs.value));
  } catch (e) {
    console.warn('Failed to save action delay setting to localStorage:', e);
  }
}
```

## 技術的考慮事項

### パフォーマンス

- localStorage の読み書きは同期的だが、単一の数値保存なので影響は無視できる
- `@change` イベントによる保存はユーザー操作時のみ発火するため、頻繁な書き込みは発生しない

### セキュリティ

- 保存する値は数値のみ（0〜5000）であり、機密情報ではない
- 不正な値が localStorage に格納されていても、バリデーションにより無視される

### 既存機能への影響

- `agentConfig.actionDelayMs` のフローは変更なし
- シナリオ実行時の動作に影響なし
- デフォルト値（1000ms）は維持され、localStorage が空または不正値の場合に使用される

### エッジケース

1. **localStorage が無効化されている場合**: 読み込み・保存共に try-catch で囲み、エラーを console.warn で記録してデフォルト値を使用
2. **不正な値が保存されている場合**: バリデーションで除外し、デフォルト値を使用
3. **ブラウザのストレージクリア**: 次回起動時にデフォルト値を使用（期待通りの動作）
4. **初期読み込み時の保存発火**: `@change` イベントハンドラを使用しているため、初期読み込み時は保存が発火しない（ユーザー操作時のみ）

## テスト計画

### 手動テスト

1. **初期状態の確認**
   - アプリ起動時、セレクトボックスがデフォルト値（1秒）を表示することを確認
   - localStorage にキーが存在しない状態

2. **値変更の保存確認**
   - セレクトボックスで「3秒」を選択
   - DevTools の Application > Local Storage で `xenotester_action_delay_ms` が `3000` であることを確認

3. **値の復元確認**
   - アプリを再起動（ページリロードまたはタブを閉じて再度開く）
   - セレクトボックスが「3秒」を表示することを確認

4. **不正値のハンドリング確認**
   - DevTools で localStorage の値を `9999`（無効な値）に手動変更
   - アプリを再起動
   - デフォルト値（1秒）が表示されることを確認

5. **初期読み込み時に保存が発火しないことの確認**
   - DevTools で localStorage の値を `3000`（3秒）に設定
   - アプリを再起動
   - セレクトボックスを操作せずに、DevTools で localStorage の値が `3000` のまま変わっていないことを確認
   - （従来の watch 実装だと、初期読み込み時に値が上書きされる可能性があった）

### ユニットテスト（オプション）

App.vue のコンポーネントテストは現在存在しないため、以下の選択肢がある:

1. **追加しない**: 手動テストで十分カバー可能な単純なロジック
2. **localStorageサービスを切り出してテスト**: 過度な抽象化になる可能性

**推奨**: 手動テストで確認し、ユニットテストは追加しない

## リスクと対策

| リスク | 影響 | 対策 |
|--------|------|------|
| localStorage 非対応環境 | 設定が保存されない | 読み込み・保存の両方で try-catch を使用し、エラーを console.warn で記録しつつデフォルト値にフォールバック |
| 将来の選択肢追加時の互換性 | 旧バージョンで保存した値が新バージョンで無効になる可能性 | 現在の選択肢配列でバリデーションしているため、無効な値は自動的にデフォルトに戻る |
| ブラウザ間での非共有 | 異なるブラウザで設定が引き継がれない | 期待通りの動作（ローカル設定の性質上問題なし） |
| 初期読み込み時に保存が発火する | 保存したい値がデフォルト値で上書きされる | `@change` イベントハンドラを使用し、ユーザー操作時のみ保存を実行 |

## 調査ログ

### 実行した検索

1. `Grep: "wait|Wait|待機"` - 待機時間関連のコード検索
2. `Grep: "action.*time|actionTime|delay"` - アクション遅延関連のコード検索
3. `Grep: "select|dropdown|option"` - UIコンポーネント検索
4. `Grep: "localStorage|sessionStorage|store|persist"` - 既存の永続化パターン検索
5. `Grep: "actionDelayMs"` - 対象変数の使用箇所確認

### 読んだファイル一覧

- `src/App.vue` - メイン実装箇所、UIと状態管理の確認
- `src/types/action.ts` - `AgentLoopConfig.actionDelayMs` の型定義確認
- `src/services/scenarioRunner.ts` - `actionDelayMs` の受け渡しフロー確認
- `src/services/agentLoop.ts` (先頭150行) - `actionDelayMs` の使用箇所確認
- `src/services/supabaseClient.ts` - 既存のlocalStorage使用パターン確認
- `src/__tests__/ScenarioForm.test.ts` - テストパターン確認
- `package.json` - 依存関係確認
- `vite.config.ts` - テスト環境設定確認
- `src-tauri/Cargo.toml` - バックエンド依存確認（storeプラグイン不使用を確認）
- `src-tauri/src/commands/config.rs` - 設定管理パターン確認

### 辿った import/依存チェーン

```
App.vue
  ├─ actionDelayMs (ref)
  │   └─ executeSelected() で agentConfig.actionDelayMs として渡される
  │       └─ runSelectedScenarios(orderedIds, scenarios, { agentConfig })
  │           └─ scenarioRunner.runSelected(..., options)
  │               └─ runAgentLoop({ config: options.agentConfig })
  │                   └─ agentLoop.ts: config.actionDelayMs ?? 1000
```

### 非TSファイル確認

- `package.json` - 確認済み（tauri-plugin-store未使用）
- `vite.config.ts` - 確認済み（jsdom環境でテスト実行）

### 発見した関連情報

- Supabase クライアントで `localStorage` を既に使用（`src/services/supabaseClient.ts:16`）
- App.vue にはコンポーネントテストが存在しない
- `DEFAULT_AGENT_LOOP_CONFIG.actionDelayMs` のデフォルト値は `1000` （`src/types/action.ts:98`）

---

計画書ファイルパス: /Users/satoshizerocolored/dev/localtester2/implementation-plan-persist-action-delay.md
