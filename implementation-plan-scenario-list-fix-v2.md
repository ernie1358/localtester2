# 実装計画書: シナリオ一覧に新規登録が表示されない問題の修正 v2.2

## 概要

UI上で新規シナリオ登録をした際に、シナリオ一覧に登録内容が表示されない問題を調査・修正する。ログには「新規シナリオを追加しました」と表示されるが、一覧には反映されない。

## 根本原因の確定

### データフローの追跡結果

```
[ユーザーアクション] 新規シナリオ保存
        ↓
[App.vue:107] createScenario() 呼び出し
        ↓
[scenarioDatabase.ts:46-74] DBに INSERT 実行、新規シナリオを返す
        ↓
[App.vue:110] loadScenarios() 呼び出し
        ↓
[scenarioDatabase.ts:23-29] getAllScenarios() → SELECT * FROM scenarios → 新しい配列を返す
        ↓
[App.vue:71] scenarios.value = loaded; ← 配列全体を「置換」している
        ↓
[ScenarioList.vue] props.scenarios が新しい配列に置換される
        ↓
[ScenarioList.vue:23-30] watch で検知 → localScenarios を更新
```

### データ層の正当性確認（追加調査）

実装前に以下の確認を行い、問題がデータ層にないことを確定させる必要がある：

1. **`createScenario()` 後の `getAllScenarios()` 戻り値確認**:
   - デバッグログ `[scenarioDatabase] getAllScenarios returned: X scenarios` が、登録後に件数が+1されていることを確認
   - 新規登録したシナリオが戻り値に含まれていることを確認

2. **`scenarios.value` の更新確認**:
   - `App.vue` の `loadScenarios()` 内のデバッグログ `[App] loadScenarios: loaded X scenarios` で件数が正しいことを確認
   - Vue DevTools（利用可能な場合）で `scenarios` ref の値が更新されていることを確認

3. **不一致が見つかった場合の対応**:
   - データ層（`scenarioDatabase.ts`）に問題がある場合は、そちらを修正対象に含める
   - 現時点のコード調査では、SQLクエリ・トランザクション処理に問題は見られない

### 確定した原因: `watchEffect` から `watch` への変更が必要

**変更前の問題のあるコード（コミット 430b191 以前）**:
```typescript
// ScenarioList.vue - 問題のある実装
const localScenarios = computed({
  get: () => props.scenarios,
  set: (val) => emit('update:order', val),
});
```

**問題点**:
- `computed` の `get` は `props.scenarios` を直接返していた
- ドラッグ＆ドロップで順序を変更すると、`set` が呼ばれて親に通知
- しかし、親で `scenarios.value` が置換されても、Vue の shallow reactive により子コンポーネントへの変更通知が遅延または欠落する可能性があった

**修正後のコード（現在ワーキングディレクトリに存在）**:
```typescript
// ScenarioList.vue - 修正済みの実装
const localScenarios = ref<StoredScenario[]>([]);

watch(
  () => props.scenarios,
  (newScenarios) => {
    localScenarios.value = newScenarios.map((s) => ({ ...s }));
  },
  { immediate: true, deep: true }
);
```

**修正のポイント**:
1. `ref` で独立したローカルコピーを持つ
2. `watch` + getter関数 `() => props.scenarios` で確実にpropsの変更を追跡
3. `immediate: true` で初期化時にも実行
4. `deep: true` で配列内オブジェクトの変更も検知（安全策）
5. `map((s) => ({ ...s }))` でシャローコピーを作成し、propのミューテーションを防止（`StoredScenario` はフラット構造のためシャローコピーで十分）

### なぜ `deep: true` が必要か

`App.vue` の `loadScenarios()` では `scenarios.value = loaded;` で**配列全体を置換**しているため、`deep: true` は本来不要。しかし、以下の理由で安全策として残す：
- 将来的なコード変更への耐性
- `handleOrderUpdate()` でも同様に配列を置換しているが、一貫性のため
- パフォーマンスへの影響は軽微（シナリオ数は通常数十件程度）

## 影響範囲

### 変更が必要なファイル（本問題の修正に直接必要）

| ファイル | 変更理由 | 変更内容 |
|---------|---------|---------|
| `src/components/ScenarioList.vue` | リアクティビティ問題の修正 | `watch`への変更は**既にワーキングディレクトリに適用済み**。デバッグログを削除する |

### 変更が不要なファイル（本問題と無関係）

以下のファイルは本問題の修正とは**直接関係がない**ため、今回のスコープから除外する：

| ファイル | 状態 | 除外理由 |
|---------|------|---------|
| `src/__tests__/ScenarioList.test.ts` | テスト期待値が古い文言 | UI文言変更（シナリオ→テストステップ）の追従であり、一覧表示問題とは別のタスク |
| `src/__tests__/scenarioRunner.test.ts` | テスト期待値が古い文言 | ログメッセージ変更の追従であり、一覧表示問題とは別のタスク |

**注意**: 上記テストの修正は「UI文言統一タスク」として別途対応することを推奨。

### 既に変更済みだが関係のないファイル

以下のファイルはワーキングディレクトリで変更されているが、今回の問題とは無関係：

| ファイル | 変更内容 | 状態 |
|---------|---------|------|
| `src/App.vue` | UI文言変更 | 変更済み（問題なし） |
| `src/components/ScenarioForm.vue` | UI文言変更 | 変更済み（問題なし） |
| `src/components/DeleteConfirmDialog.vue` | UI文言変更 | 変更済み（問題なし） |
| `src/pages/ResultPage.vue` | UI文言変更 | 変更済み（問題なし） |
| `src/services/scenarioRunner.ts` | ログメッセージ変更 | 変更済み（問題なし） |
| `src/services/resultWindowService.ts` | レースコンディション対策 | 変更済み（問題なし） |
| `src/services/scenarioDatabase.ts` | デバッグログ追加 | 変更済み（問題なし） |

## 実装ステップ

### ステップ 0: データ層の正当性確認（実装前の確認作業）

**目的**: 問題がデータ層にないことを確定させる

1. **アプリを起動し、開発者コンソールを開く**
2. **新規テストステップを登録**
3. **コンソールログを確認**:
   - `[scenarioDatabase] getAllScenarios returned: N scenarios` で件数が+1されているか確認
   - `[App] loadScenarios: loaded N scenarios` で件数が正しいか確認
   - `[ScenarioList] props.scenarios changed, length: N` で件数が正しいか確認

4. **判定**:
   - 全てのログで件数が正しく+1されている → データ層は問題なし、ステップ1へ進む
   - `getAllScenarios` の時点で件数が増えていない → データ層（DB）に問題あり、別途調査が必要
   - `loadScenarios` で件数が増えていない → `App.vue` に問題あり、別途調査が必要
   - `props.scenarios` で件数が増えていない → Vue のリアクティビティ問題、ステップ1で修正済みの内容で解決するはず

**現時点の予測**: デバッグログは既に追加済みであり、`watch` への変更も適用済みのため、問題は解決している可能性が高い。

### ステップ 1: ScenarioList.vue の修正を確認・保持

**確認事項**: 現在のワーキングディレクトリに以下の変更が適用されていることを確認する。

```typescript
// src/components/ScenarioList.vue
// Line 20-30: watch による props.scenarios の監視

const localScenarios = ref<StoredScenario[]>([]);

watch(
  () => props.scenarios,
  (newScenarios) => {
    // デバッグログ（ステップ2で削除）
    console.log('[ScenarioList] props.scenarios changed, length:', newScenarios.length);
    localScenarios.value = newScenarios.map((s) => ({ ...s }));
  },
  { immediate: true, deep: true }
);
```

**未適用の場合**: 上記のコードを適用する。

### ステップ 2: デバッグログの削除

**src/components/ScenarioList.vue (26行目)** のデバッグログを削除：

```typescript
// 削除する行
console.log('[ScenarioList] props.scenarios changed, length:', newScenarios.length);
```

**src/services/scenarioDatabase.ts (28行目)** のデバッグログも削除（任意）：

```typescript
// 削除する行（任意）
console.log('[scenarioDatabase] getAllScenarios returned:', results.length, 'scenarios');
```

**src/App.vue (70行目)** のデバッグログも削除（任意）：

```typescript
// 削除する行（任意）
console.log('[App] loadScenarios: loaded', loaded.length, 'scenarios');
```

### ステップ 3: 動作確認

1. アプリケーションを起動
2. 新規テストステップを登録
3. **確認ポイント**: 一覧に登録したテストステップが即座に表示されること
4. ページをリロードしても表示されることを確認

### ステップ 4: テストの実行

```bash
npm run test:run
```

**注意**: 以下のテストは「UI文言変更」の追従ができていないため失敗する可能性がある。これは本問題の修正とは別のタスクである：
- `src/__tests__/ScenarioList.test.ts` - 「シナリオがありません」→「テストステップがありません」
- `src/__tests__/scenarioRunner.test.ts` - 「シナリオ開始/成功」→「テストステップ開始/成功」

本タスクの完了後、別タスクとして対応する。

## 技術的考慮事項

### watch vs watchEffect vs computed

| 項目 | computed | watchEffect | watch |
|------|----------|-------------|-------|
| 用途 | 値の導出 | 副作用の実行 | 特定値の監視 |
| 依存関係 | 自動追跡 | 自動追跡（実行時） | 明示的に指定 |
| 初回実行 | 即時 | 即時 | `immediate: true`が必要 |
| 深い変更 | 自動 | 実行されない場合あり | `deep: true`が必要 |
| props監視 | getter使用で安全 | 不確実 | getter使用で確実 |

今回の問題では、`watch` + getter関数 + `immediate: true` の組み合わせが最も確実。

### Vue 3 のリアクティビティに関する注意点

- `props` は `shallowReactive` として実装されている
- プロパティの参照が変わった場合は検知される
- 配列全体の置換（`array = newArray`）は検知される
- 配列の直接変更（`array.push()`）は追加の工夫が必要な場合がある
- `watchEffect` は依存関係の自動追跡が不確実な場合がある（特にpropsの監視）

### シャローコピー vs ディープコピー

`map((s) => ({ ...s }))` は**シャローコピー（浅いコピー）**である。

- シャローコピー: オブジェクトの第1階層のみをコピー。ネストしたオブジェクトは参照を共有
- ディープコピー: ネストしたオブジェクトも含めて完全にコピー

`StoredScenario` の構造はフラット（ネストしたオブジェクトがない）ため、シャローコピーで十分：

```typescript
interface StoredScenario {
  id: string;
  title: string;
  description: string;
  order_index: number;
  created_at: string;
  updated_at: string;
}
```

## テスト計画

### 手動テスト（必須）

| テスト項目 | 手順 | 期待結果 |
|-----------|------|---------|
| 新規登録 | 1. アプリ起動 2. 新規登録 3. 一覧確認 | 登録したステップが即座に表示される |
| 編集 | 1. 既存ステップを編集 2. 保存 | 変更が反映される |
| 削除 | 1. ステップを削除 | 一覧から消える |
| ドラッグ＆ドロップ | 1. ステップの順序を変更 | 順序が保持される |
| リロード | 1. 新規登録 2. F5でリロード | 登録が保持されている |

### ユニットテスト

```bash
npm run test:run
```

**期待結果**:
- 本問題に関連するテスト（ScenarioList の機能テスト）はパスする
- UI文言に関するテストは失敗する可能性がある（別タスクで対応）

## リスクと対策

### リスク 1: deep オプションによるパフォーマンス低下

**評価**: 低リスク
**理由**: シナリオ数は通常数十件程度
**対策**: 問題発生時は `deep: true` を削除し、配列長の監視に切り替え

### リスク 2: 他のリアクティビティ問題の存在

**評価**: 低リスク
**対策**:
- 手動テストで各機能を確認
- ユーザーからのフィードバック収集

### リスク 3: データ層に未発見の問題がある可能性

**評価**: 低リスク（コード調査では問題なし）
**対策**: ステップ0でデバッグログを確認し、データ層に問題がないことを確定させる

## 調査ログ

### 実行した検索語（Grep/Glob）

| パターン | 目的 | 結果 |
|---------|------|------|
| `src/**/*.{ts,tsx,vue,js}` | ソースファイル一覧 | 32ファイル発見 |
| `シナリオ` | 「シナリオ」文言の使用箇所 | 複数ファイルで使用 |
| `watch\|watchEffect` | Vue監視機能の使用箇所 | ScenarioList, ScenarioForm |
| `scenarios` | シナリオ関連の処理 | 複数ファイル |
| `props.scenarios` | propsの参照方法 | ScenarioList.vue |
| `scenarios.value` | scenariosの更新方法 | App.vue |
| `getAllScenarios` | DBからの取得処理 | scenarioDatabase.ts, App.vue |
| `createScenario` | 新規登録処理 | scenarioDatabase.ts, App.vue |
| `loadScenarios` | 読み込み処理 | App.vue |

### 読んだファイル一覧

**主要ファイル**:
- `src/components/ScenarioList.vue` - **問題の発生箇所、修正対象**
- `src/App.vue` - 親コンポーネント、データフロー確認
- `src/services/scenarioDatabase.ts` - DB操作確認

**テスト**:
- `src/__tests__/ScenarioList.test.ts` - テスト内容確認
- `src/__tests__/scenarioRunner.test.ts` - テスト内容確認

### 辿った import/依存チェーン

```
App.vue
├── scenarioDatabase.ts (getAllScenarios, createScenario, etc.)
│   └── @tauri-apps/plugin-sql (Database)
├── ScenarioList.vue
│   ├── ref, watch, computed (vue)
│   └── vue-draggable-plus (VueDraggable)
├── ScenarioForm.vue
└── DeleteConfirmDialog.vue
```

### Git 差分確認

`git diff HEAD -- src/components/ScenarioList.vue` で以下の変更を確認：
- `computed` → `ref` + `watch` への変更が**既に適用済み**
- `handleDragEnd()` 関数の追加
- UI文言の変更
- デバッグログの追加（要削除）

### 非TSファイル確認

- `package.json`: 依存関係確認
- 設定ファイル: 特記事項なし

### 調査中に発見した関連情報・懸念事項

1. **現在のワーキングディレクトリの状態**: `watch`への変更が既に適用されている
2. **デバッグログの残存**: 本番用には削除が必要
3. **テスト期待値の不整合**: UI文言変更に追従していないテストが存在（別タスク）
4. **UI文言の一貫性**: 「シナリオ」から「テストステップ」への変更が進行中だが、内部プロンプトでは「シナリオ」が残存（意図的）
5. **データ層の確認**: SQLクエリ・トランザクション処理に問題は見られないが、実装前にデバッグログで確認することを推奨

---

## 除外タスク一覧（今回のスコープ外）

以下は本問題の修正とは直接関係がないため、別タスクとして対応する：

### 1. UI文言統一タスク

**対象ファイル**:
- `src/__tests__/ScenarioList.test.ts`
  - 53行目: `'シナリオがありません'` → `'テストステップがありません'`
- `src/__tests__/scenarioRunner.test.ts`
  - 371行目: `'シナリオ開始'` → `'テストステップ開始'`
  - 372行目: `'シナリオ成功'` → `'テストステップ成功'`

**理由**: 本問題（一覧に新規が出ない）とは無関係。UI文言の変更は過去のコミットで行われており、テストの追従は機能修正ではなくリファクタリングである。

---

## 変更履歴

| バージョン | 日付 | 変更内容 |
|-----------|------|---------|
| v2.0 | - | 初版作成 |
| v2.1 | - | スコープ整理、除外タスク明確化 |
| v2.2 | - | データ層確認手順追加（ステップ0）、「ディープコピー」→「シャローコピー」表現修正 |

---

計画書ファイルパス: /Users/satoshizerocolored/dev/localtester2/implementation-plan-scenario-list-fix-v2.md
