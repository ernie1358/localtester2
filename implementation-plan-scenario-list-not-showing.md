# 実装計画書: シナリオ一覧に新規登録が表示されない問題の修正

## 概要

UI上で新規シナリオ登録をした際に、シナリオ一覧に登録内容が表示されない問題を調査・修正する。

## 問題分析

### 調査結果

コードを詳細に調査した結果、以下の問題点を特定しました：

#### 1. Vue の watchEffect によるリアクティビティの問題（主要原因の可能性）

**ScenarioList.vue (22-25行目)**:
```typescript
// Local copy for drag-and-drop (deep copy to avoid prop mutation)
const localScenarios = ref<StoredScenario[]>([]);

// Sync local copy when props change using watchEffect for reliable tracking
watchEffect(() => {
  localScenarios.value = props.scenarios.map((s) => ({ ...s }));
});
```

**問題点**:
Vue 3 の `watchEffect` は、エフェクト内でアクセスされたリアクティブな依存関係を自動的に追跡します。`props.scenarios` は Vue のリアクティビティシステムでは `reactive` オブジェクトの一部ですが、**`props` オブジェクト全体ではなく `props.scenarios` という特定のプロパティへのアクセス**が追跡されます。

しかし、Vue 3 の `props` は `shallowReactive` であり、配列の参照自体が変わらない場合（内部の要素だけが変わる場合）、`watchEffect` が再実行されない可能性があります。

**`getAllScenarios()` の戻り値**:
`scenarioDatabase.ts` の `getAllScenarios()` は毎回新しい配列を返すため、`App.vue` の `loadScenarios()` で `scenarios.value = await getAllScenarios()` を実行すると新しい配列参照が設定されます。この場合、通常は `watchEffect` が再実行されるはずです。

#### 2. 推定される根本原因

コードの流れを追跡した結果、**以下の可能性が高い**と判断しました：

**App.vue の handleSaveScenario (99-115行目)**:
```typescript
async function handleSaveScenario(title: string, description: string) {
  try {
    if (editingScenario.value) {
      await updateScenario(editingScenario.value.id, title, description);
      addLog(`テストステップを更新しました: ${title}`);
    } else {
      await createScenario(title, description);
      addLog(`テストステップを登録しました: ${title}`);
    }
    await loadScenarios();  // ← ここでシナリオを再読み込み
    showScenarioForm.value = false;
    editingScenario.value = null;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}
```

`createScenario()` 後に `loadScenarios()` が呼ばれ、`scenarios.value` に新しい配列が設定されます。

**問題の可能性**:
1. **非同期処理のタイミング**: `loadScenarios()` が正常に完了しているか
2. **Vue のリアクティビティの遅延**: `watchEffect` が即座に再実行されるか
3. **DBからの読み込み失敗**: `getAllScenarios()` がエラーを出している可能性

#### 3. 以前のコード（c7b23da）との比較

**変更前（c7b23da）**:
```typescript
// Local scenarios for drag-and-drop
const localScenarios = computed({
  get: () => props.scenarios,
  set: (val) => emit('update:order', val),
});
```

**変更後（現在）**:
```typescript
const localScenarios = ref<StoredScenario[]>([]);

watchEffect(() => {
  localScenarios.value = props.scenarios.map((s) => ({ ...s }));
});
```

**重要な違い**:
- 元の実装では `computed` を使用し、`props.scenarios` を直接参照していた
- 現在の実装では `ref` + `watchEffect` でディープコピーを作成

この変更は、ドラッグ＆ドロップ時の prop mutation を避けるために行われたようですが、**`watchEffect` のリアクティビティ追跡が期待通りに動作していない可能性**があります。

### 確認が必要な点

**ユーザーへの質問**:
1. 新規登録後、ページをリロード（F5）すると登録したシナリオは表示されますか？
   - Yes の場合: Vue のリアクティビティの問題
   - No の場合: データベース保存の問題

2. コンソール（開発者ツール）にエラーは表示されていますか？

3. 「テストステップを登録しました: xxxx」というログは実行ログに表示されていますか？

## 影響範囲

### 変更が必要なファイル

| ファイル | 変更理由 |
|---------|---------|
| `src/components/ScenarioList.vue` | `watchEffect` の代わりに `watch` を使用し、より明示的なリアクティビティ追跡を実装 |
| `src/__tests__/ScenarioList.test.ts` | テストの期待値を「テストステップ」に修正 |
| `src/__tests__/scenarioRunner.test.ts` | テストの期待値を「テストステップ」に修正 |

### 変更しないが影響を受ける可能性があるファイル

| ファイル | 理由 |
|---------|------|
| `src/App.vue` | ScenarioList を使用しているが、変更は不要 |
| `src/services/scenarioDatabase.ts` | データベース操作は問題なし |

## 実装ステップ

### ステップ 1: ScenarioList.vue の修正

`watchEffect` を `watch` に変更し、より明示的にリアクティビティを追跡します。

**修正案**:
```typescript
import { ref, watch, computed } from 'vue';

// ...

const localScenarios = ref<StoredScenario[]>([]);

// watch を使用し、props.scenarios を明示的に監視
// immediate: true で初期値も反映
watch(
  () => props.scenarios,
  (newScenarios) => {
    localScenarios.value = newScenarios.map((s) => ({ ...s }));
  },
  { immediate: true, deep: true }
);
```

**理由**:
- `watch` は監視対象を明示的に指定するため、リアクティビティの追跡がより確実
- `deep: true` オプションにより、配列内のオブジェクトの変更も検出
- `immediate: true` により、初期化時にも実行される

### ステップ 2: テストファイルの修正

テストの期待値を「シナリオ」から「テストステップ」に変更します。

**ScenarioList.test.ts (53行目)**:
```typescript
// 変更前
expect(wrapper.text()).toContain('シナリオがありません');

// 変更後
expect(wrapper.text()).toContain('テストステップがありません');
```

**scenarioRunner.test.ts (371-372行目)**:
```typescript
// 変更前
expect(logs.some((l) => l.includes('シナリオ開始'))).toBe(true);
expect(logs.some((l) => l.includes('シナリオ成功'))).toBe(true);

// 変更後
expect(logs.some((l) => l.includes('テストステップ開始'))).toBe(true);
expect(logs.some((l) => l.includes('テストステップ成功'))).toBe(true);
```

### ステップ 3: 動作確認

1. テストを実行して全て通ることを確認
2. 実際のアプリケーションで新規登録が正しく表示されることを確認

## 技術的考慮事項

### パフォーマンス

- `deep: true` は配列の全要素を深く比較するため、大量のシナリオがある場合にパフォーマンスに影響する可能性がある
- ただし、シナリオ数は通常数十件程度と想定されるため、影響は軽微

### リアクティビティ

- Vue 3 の `props` は `shallowReactive` であるため、ネストしたオブジェクトの変更は自動的に追跡されない
- `watch` の `deep: true` オプションを使用することで、この問題を解決

### 既存機能への影響

- ドラッグ＆ドロップによる並び替え機能は、引き続き `localScenarios` を使用するため影響なし
- 選択機能は `props.scenarios` と `props.selectedIds` を直接使用しているため影響なし

## テスト計画

### ユニットテスト

1. **ScenarioList.test.ts の既存テスト**: 全て通ること
2. **scenarioRunner.test.ts の既存テスト**: 全て通ること

### 手動テスト

1. **新規登録テスト**:
   - 新規テストステップを登録
   - 登録後、一覧に表示されることを確認

2. **編集テスト**:
   - 既存のテストステップを編集
   - 編集後、一覧に変更が反映されることを確認

3. **削除テスト**:
   - テストステップを削除
   - 削除後、一覧から消えることを確認

4. **ドラッグ＆ドロップテスト**:
   - テストステップの順序を変更
   - 変更後、順序が保持されることを確認

## リスクと対策

### リスク 1: watch の deep オプションによるパフォーマンス低下

**対策**:
- シナリオ数が数百件を超えることは稀なため、現時点では許容
- 将来的に問題が発生した場合、`watchEffect` + `JSON.stringify` による比較など、より効率的な方法を検討

### リスク 2: 他のリアクティビティ問題の存在

**対策**:
- App.vue の `loadScenarios()` にデバッグログを追加して、データフローを確認
- コンソールでエラーがないか確認

## 調査ログ

### 実行した検索語（Grep/Glob）

| パターン | 目的 |
|---------|------|
| `src/**/*.{ts,tsx,vue,js}` | プロジェクト内のソースファイル一覧を取得 |
| `シナリオ` | 「シナリオ」という文字列の使用箇所を特定 |
| `scenarios\.value\s*=` | scenarios.value への代入箇所を特定 |
| `watchEffect\|watch\(` | watch/watchEffect の使用箇所を特定 |

### 読んだファイル一覧

| ファイル | 確認内容 |
|---------|---------|
| `src/components/ScenarioList.vue` | メインの問題箇所、watchEffect の実装 |
| `src/components/ScenarioForm.vue` | フォームの保存処理 |
| `src/App.vue` | 親コンポーネントのデータフロー |
| `src/services/scenarioDatabase.ts` | データベース操作 |
| `src/types/database.ts` | 型定義 |
| `src/types/scenario.ts` | 型定義 |
| `src/types/index.ts` | 型のエクスポート |
| `src/__tests__/ScenarioList.test.ts` | 既存テスト |
| `src/__tests__/scenarioDatabase.test.ts` | データベーステスト |
| `src/__tests__/scenarioRunner.test.ts` | ランナーテスト |
| `src/services/scenarioRunner.ts` | シナリオ実行ロジック |
| `src-tauri/src/lib.rs` | Tauri バックエンド |
| `src-tauri/migrations/001_create_scenarios.sql` | DBマイグレーション |
| `package.json` | 依存関係 |
| `vite.config.ts` | ビルド設定 |

### 辿った import/依存チェーン

1. `App.vue` → `scenarioDatabase.ts` (getAllScenarios, createScenario, etc.)
2. `App.vue` → `ScenarioList.vue` (scenarios prop)
3. `ScenarioList.vue` → `vue-draggable-plus` (VueDraggable)
4. `scenarioDatabase.ts` → `@tauri-apps/plugin-sql` (Database)

### 非TSファイル確認

- `package.json`: vitest, @vue/test-utils 等の依存確認
- `src-tauri/tauri.conf.json`: Tauri設定確認
- `src-tauri/migrations/001_create_scenarios.sql`: DBスキーマ確認

### 調査中に発見した関連情報・懸念事項

1. **テストの失敗**: 2つのテストが「シナリオ」→「テストステップ」の変更により失敗している
2. **git diff での変更確認**: 現在の変更は全て未コミット（ステージングにもなし）
3. **Vue 3 のリアクティビティ**: `props` は `shallowReactive` であるため、深いネストの変更は追跡されない
