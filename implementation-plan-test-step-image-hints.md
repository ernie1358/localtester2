# 実装計画書: テストステップ画像ヒント機能

## 概要

テストステップの登録画面に、ドラッグ&ドロップで複数の画像ファイル（スクリーンショット）を添付できる機能を追加する。添付された画像はテストステップに紐づけてSQLiteに保存され、テスト実行時にClaude Computer Use APIへのリクエストに「探してほしい部分のヒント」として添付される。

これにより、Computer Useがクリック対象や探索対象の要素をより正確に認識できるようになり、座標ズレや誤認識を軽減することを目指す。

## 影響範囲

### 変更が必要なファイル

| ファイル | 変更内容 | 理由 |
|---------|---------|------|
| `src-tauri/migrations/002_create_step_images.sql` | **新規作成** | 画像データ保存用のテーブルを追加 |
| `src-tauri/src/lib.rs` | マイグレーション追加 | 新しいマイグレーションを登録 |
| `src/types/database.ts` | 型定義追加 | `StepImage`型と`StoredScenario`への画像参照を追加 |
| `src/services/scenarioDatabase.ts` | CRUD関数追加 | 画像の保存・取得・削除関数を追加 |
| `src/components/ScenarioForm.vue` | UIコンポーネント追加 | ドラッグ&ドロップエリアと画像プレビュー機能を追加 |
| `src/services/agentLoop.ts` | API呼び出し変更 | 初回メッセージにヒント画像を添付 |
| `src/services/claudeClient.ts` | プロンプト変更 | ヒント画像に関する説明をシステムプロンプトに追加 |
| `src/__tests__/scenarioDatabase.test.ts` | テスト追加 | 画像CRUD操作のテストを追加 |
| `src/__tests__/ScenarioForm.test.ts` | **新規作成** | ドラッグ&ドロップ機能のテストを追加 |
| `src/App.vue` | 状態管理・関数変更 | `editingScenarioImages`状態追加、`openEditForm`/`openNewScenarioForm`/`handleSaveScenario`/`handleCancelForm`の変更、ScenarioFormへの`:existing-images`props追加 |
| `src/services/scenarioRunner.ts` | hintImages対応 | `runSelected`メソッドで画像取得、`runAgentLoop`への画像渡し |

### 変更しないが影響を受ける可能性があるファイル

| ファイル | 影響 |
|---------|------|
| `src/types/scenario.ts` | Scenario型に画像参照を追加する可能性（今回のスコープでは変更不要） |

## 実装ステップ

### ステップ1: データベーススキーマの拡張

1. **マイグレーションファイルの作成**
   ```sql
   -- src-tauri/migrations/002_create_step_images.sql
   CREATE TABLE IF NOT EXISTS step_images (
       id TEXT PRIMARY KEY NOT NULL,
       scenario_id TEXT NOT NULL,
       image_data TEXT NOT NULL,  -- 生Base64（data:プレフィックスなし）
       file_name TEXT NOT NULL,
       mime_type TEXT NOT NULL DEFAULT 'image/png',
       order_index INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE
   );

   CREATE INDEX IF NOT EXISTS idx_step_images_scenario ON step_images(scenario_id);
   ```

2. **lib.rsにマイグレーションを追加**
   ```rust
   fn get_migrations() -> Vec<Migration> {
       vec![
           Migration { version: 1, ... },
           Migration {
               version: 2,
               description: "create_step_images_table",
               sql: include_str!("../migrations/002_create_step_images.sql"),
               kind: MigrationKind::Up,
           }
       ]
   }
   ```

### ステップ2: 型定義の追加

**`src/types/database.ts`に追加:**
```typescript
/** テストステップに紐づく画像ヒント */
export interface StepImage {
  id: string;
  scenario_id: string;
  image_data: string;  // 生Base64（data:プレフィックスなし）
  file_name: string;
  mime_type: string;
  order_index: number;
  created_at: string;
}

/** 画像付きシナリオ（読み込み用） */
export interface StoredScenarioWithImages extends StoredScenario {
  images: StepImage[];
}

/** フォームで扱う画像データ（新規・既存を区別） */
export interface FormImageData {
  /** 既存画像のID（新規の場合はundefined） */
  existingId?: string;
  /** 生Base64データ（data:プレフィックスなし） */
  base64: string;
  fileName: string;
  mimeType: string;
  /** 削除フラグ（編集時に既存画像を削除する場合true） */
  markedForDeletion?: boolean;
}
```

### ステップ3: データベースサービスの拡張

**`src/services/scenarioDatabase.ts`に追加:**

```typescript
/**
 * テストステップに画像を追加
 * @param scenarioId シナリオID
 * @param base64Data 生Base64データ（data:プレフィックスなし）
 * @param fileName ファイル名
 * @param mimeType MIMEタイプ
 */
export async function addStepImage(
  scenarioId: string,
  base64Data: string,
  fileName: string,
  mimeType: string = 'image/png'
): Promise<StepImage> { ... }

/**
 * テストステップの画像一覧を取得
 */
export async function getStepImages(scenarioId: string): Promise<StepImage[]> { ... }

/**
 * 画像を削除
 */
export async function deleteStepImage(imageId: string): Promise<void> { ... }

/**
 * テストステップの画像を全削除（シナリオ削除時に自動で呼ばれるがCASCADEで対応）
 */
export async function deleteAllStepImages(scenarioId: string): Promise<void> { ... }

/**
 * 画像の並び順を更新
 */
export async function updateStepImageOrders(
  orders: { id: string; orderIndex: number }[]
): Promise<void> { ... }
```

### ステップ4: ScenarioFormコンポーネントの拡張

**`src/components/ScenarioForm.vue`の変更:**

1. **propsに既存画像を受け取る（既存propsを維持）**
   ```typescript
   // 既存のprops（scenario, visible）を維持しつつ、existingImagesを追加
   const props = defineProps<{
     scenario?: StoredScenario | null;  // 既存：編集対象シナリオ
     visible: boolean;                   // 既存：モーダル表示状態
     existingImages?: StepImage[];       // 新規：編集時に既存画像を受け取る
   }>();
   ```

   **注意**: 既存の`scenario`と`visible` propsは維持すること。App.vueからの呼び出しと既存のwatchロジックとの整合性を保つため。

2. **ドラッグ&ドロップエリアの追加**
   - テキストエリアの下に配置
   - `dragover`, `dragleave`, `drop`イベントハンドラを実装
   - ドラッグ中のビジュアルフィードバック（ボーダーハイライト等）

3. **画像プレビュー表示**
   - サムネイル形式で添付画像を一覧表示
   - 各画像に削除ボタンを配置
   - 画像の並び替え機能（オプション：vue-draggable-plus使用）
   - **既存画像と新規画像を視覚的に区別しない（ユーザー体験の一貫性のため）**

4. **ファイル選択のフォールバック**
   - クリックでファイル選択ダイアログを開く機能
   - 複数ファイル選択対応（`multiple`属性）

5. **バリデーション**
   - 画像ファイルタイプのチェック（PNG, JPG, JPEG, GIF, WebP）
   - ファイルサイズ上限チェック（例：5MB/枚）
   - **画像枚数は無制限（依頼要件に従う）**

6. **Base64変換処理**
   ```typescript
   /**
    * FileオブジェクトをBase64に変換
    * Data URL形式から data:xxx;base64, プレフィックスを除去して生Base64を返す
    */
   async function fileToBase64(file: File): Promise<{ base64: string; mimeType: string }> {
     return new Promise((resolve, reject) => {
       const reader = new FileReader();
       reader.onload = () => {
         const dataUrl = reader.result as string;
         // "data:image/png;base64,xxxx" → "xxxx" に変換
         const base64 = dataUrl.split(',')[1];
         const mimeType = dataUrl.split(':')[1].split(';')[0];
         resolve({ base64, mimeType });
       };
       reader.onerror = reject;
       reader.readAsDataURL(file);
     });
   }
   ```

7. **emitイベントの拡張**
   ```typescript
   const emit = defineEmits<{
     save: [title: string, description: string, images: FormImageData[]];
     cancel: [];
   }>();
   ```

8. **画像状態の管理（リアクティブ変数）**
   ```typescript
   // 表示中の画像リスト（既存画像も新規画像も同じ形式で管理）
   const images = ref<FormImageData[]>([]);

   /**
    * 画像状態を初期化するヘルパー関数
    * visible/existingImages/scenario変更時に呼び出される
    */
   function initializeImages() {
     if (props.existingImages && props.existingImages.length > 0) {
       images.value = props.existingImages.map(img => ({
         existingId: img.id,
         base64: img.image_data,
         fileName: img.file_name,
         mimeType: img.mime_type,
         markedForDeletion: false,
       }));
     } else {
       // 新規登録時または画像がない場合は空配列
       images.value = [];
     }
   }

   // マウント時に初期化
   onMounted(() => {
     initializeImages();
   });

   // フォーム表示状態の変更を監視（既存パターンに従う）
   watch(
     () => props.visible,
     (newVal) => {
       if (newVal) {
         // フォームが表示されるたびに画像状態を再初期化
         initializeImages();
       }
     }
   );

   // 既存画像propsの変更を監視
   watch(
     () => props.existingImages,
     () => {
       // existingImagesが変更されたら画像状態を再初期化
       if (props.visible) {
         initializeImages();
       }
     },
     { deep: true }
   );

   // 画像削除ハンドラ
   function removeImage(index: number) {
     const image = images.value[index];
     if (image.existingId) {
       // 既存画像は削除フラグを立てる（emit時に処理）
       image.markedForDeletion = true;
     } else {
       // 新規画像は配列から除去
       images.value.splice(index, 1);
     }
   }

   // キャンセル時の画像状態クリア（handleCancel内で呼び出す）
   function clearImages() {
     images.value = [];
   }
   ```

   **重要**: 既存のScenarioFormでは`watch(() => props.visible)`と`watch(() => props.scenario)`で
   フォームデータ（title, description）を再初期化している。画像状態も同様のパターンで
   管理することで、フォーム再オープン時や編集対象切替時に画像が正しくリセットされる。

### ステップ5: App.vueの変更

**`src/App.vue`の変更:**

1. **import文の追加**
   ```typescript
   import {
     getAllScenarios,
     createScenario,
     updateScenario,
     deleteScenario,
     updateScenarioOrders,
     getStepImages,      // 追加
     addStepImage,       // 追加
     deleteStepImage,    // 追加
   } from './services/scenarioDatabase';
   import type { StoredScenario, PermissionStatus, StepImage, FormImageData } from './types';
   ```

2. **状態変数の追加**
   ```typescript
   const editingScenarioImages = ref<StepImage[]>([]);
   ```

3. **編集時の画像読み込み（openEditForm関数の変更）**
   ```typescript
   // 既存の openEditForm を修正
   async function openEditForm(scenario: StoredScenario) {
     editingScenario.value = scenario;
     // 既存画像を取得
     editingScenarioImages.value = await getStepImages(scenario.id);
     showScenarioForm.value = true;
   }
   ```

4. **新規登録時の画像状態クリア（openNewScenarioForm関数の変更）**
   ```typescript
   function openNewScenarioForm() {
     editingScenario.value = null;
     editingScenarioImages.value = [];  // 追加：前回の画像をクリア
     showScenarioForm.value = true;
   }
   ```

5. **ScenarioFormに既存画像を渡す（テンプレート変更）**
   ```vue
   <!-- 既存のprops（:visible, :scenario）を維持しつつ、:existing-imagesを追加 -->
   <ScenarioForm
     :visible="showScenarioForm"
     :scenario="editingScenario"
     :existing-images="editingScenarioImages"
     @save="handleSaveScenario"
     @cancel="handleCancelForm"
   />
   ```

   **重要**: 既存のApp.vueでは`:visible`と`:scenario`を使用している。
   計画書v3までの`:edit-scenario`は誤りであり、実際のprops名は`:scenario`である。

6. **handleSaveScenario関数の更新**
   ```typescript
   async function handleSaveScenario(
     title: string,
     description: string,
     images: FormImageData[]
   ) {
     try {
       let scenarioId: string;

       // 1. シナリオを保存（新規/更新）
       // 注意: saveOrUpdateScenarioという関数は存在しない
       // 既存のcreateScenario/updateScenarioを使用する
       if (editingScenario.value) {
         // 更新の場合：既存IDを使用
         scenarioId = editingScenario.value.id;
         await updateScenario(scenarioId, title, description);
         addLog(`テストステップを更新しました: ${title}`);
       } else {
         // 新規作成の場合：createScenarioの戻り値からIDを取得
         const newScenario = await createScenario(title, description);
         scenarioId = newScenario.id;
         addLog(`テストステップを登録しました: ${title}`);
       }

       // 2. 画像の差分処理
       for (const image of images) {
         if (image.existingId && image.markedForDeletion) {
           // 削除対象の既存画像を削除
           await deleteStepImage(image.existingId);
         } else if (!image.existingId && !image.markedForDeletion) {
           // 新規画像を追加
           await addStepImage(scenarioId, image.base64, image.fileName, image.mimeType);
         }
         // 既存画像で削除フラグがない場合は何もしない（保持）
       }

       await loadScenarios();
       showScenarioForm.value = false;
       editingScenario.value = null;
       editingScenarioImages.value = [];  // 追加：保存後に画像状態をクリア
     } catch (error) {
       errorMessage.value =
         error instanceof Error ? error.message : String(error);
     }
   }
   ```

7. **handleCancelForm関数の更新**
   ```typescript
   function handleCancelForm() {
     showScenarioForm.value = false;
     editingScenario.value = null;
     editingScenarioImages.value = [];  // 追加：キャンセル時に画像状態をクリア
   }
   ```

**画像状態のクリアタイミングまとめ:**
| タイミング | 処理 |
|-----------|------|
| 新規登録フォームを開く時 | `openNewScenarioForm`で`editingScenarioImages = []` |
| 保存完了後 | `handleSaveScenario`で`editingScenarioImages = []` |
| キャンセル時 | `handleCancelForm`で`editingScenarioImages = []` |
| 編集フォームを開く時 | `openEditForm`で既存画像を`getStepImages`で取得 |

### ステップ6: agentLoopの変更

**`src/services/agentLoop.ts`の変更:**

1. **AgentLoopOptionsの拡張**
   ```typescript
   export interface AgentLoopOptions {
     scenario: Scenario;
     hintImages?: StepImage[];  // 追加
     abortSignal: AbortSignal;
     ...
   }
   ```

2. **初回メッセージの構築変更**
   ```typescript
   // ヒント画像がある場合、メッセージに追加
   if (options.hintImages && options.hintImages.length > 0) {
     const hintSection = {
       type: 'text',
       text: `\n\n【ヒント画像】\n以下は、探してほしい要素やクリック対象のキャプチャです。これらを参考にして正確に操作してください：`
     };

     // 生Base64データをそのまま使用（DBには data: プレフィックスなしで保存済み）
     const hintImages = options.hintImages.map((img, index) => ({
       type: 'image',
       source: {
         type: 'base64',
         media_type: img.mime_type,  // 例: "image/png"
         data: img.image_data,       // 生Base64（data:プレフィックスなし）
       },
     }));

     // messagesの初回ユーザーメッセージのcontentに追加
   }
   ```

### ステップ7: claudeClientの変更

**`src/services/claudeClient.ts`の変更:**

`RESULT_SCHEMA_INSTRUCTION`にヒント画像に関する説明を追加：
```typescript
export const RESULT_SCHEMA_INSTRUCTION = `
あなたはE2Eテスト自動化ツールです。以下のルールを厳守してください。

【ヒント画像について】
ユーザーからヒント画像が提供される場合があります。これらの画像は：
- クリックすべきアイコンやボタンの見本
- 探すべきUI要素のスクリーンショット
- 操作対象の参考画像
として活用してください。ヒント画像と現在の画面を照合し、同一または類似の要素を正確に特定してください。

【最重要ルール - 絶対に守ること】
...
`;
```

### ステップ8: scenarioRunnerの変更

**`src/services/scenarioRunner.ts`の変更:**

1. **runSelectedメソッドの変更**
   - シナリオ実行前に画像を取得
   - runAgentLoopにhintImagesを渡す

```typescript
// シナリオ実行前に画像を取得
const hintImages = await getStepImages(scenario.id);

const agentResult = await runAgentLoop({
  scenario: { ... },
  hintImages,  // 追加
  abortSignal: this.abortController.signal,
  ...
});
```

**実行経路についての補足:**
- 現在App.vueからの実行は`runSelectedScenarios`経由で`runSelected`メソッドのみを使用
- `run`メソッドおよび`executeScenario`メソッドは現時点では呼び出されていない
- 将来的にこれらのメソッドが使用される場合は、同様にhintImages対応を追加する必要がある
- 今回の実装スコープでは`runSelected`のみを対象とし、他の経路は未使用のため対象外とする

### ステップ9: テストの追加

1. **scenarioDatabase.test.ts**
   - 画像追加テスト
   - 画像取得テスト
   - 画像削除テスト
   - シナリオ削除時の画像カスケード削除テスト
   - 生Base64形式での保存・取得テスト

2. **ScenarioForm.test.ts（新規）**
   - ドラッグ&ドロップのモックテスト
   - 画像プレビュー表示テスト
   - 画像削除テスト
   - ファイルタイプバリデーションテスト
   - Base64変換テスト（data:プレフィックス除去）
   - 編集時の既存画像読み込みテスト
   - 削除/保持/追加の差分処理テスト

## 技術的考慮事項

### パフォーマンス

1. **画像サイズ最適化**
   - 大きな画像は自動リサイズ（例：最大1280px）を検討
   - Base64エンコードによるデータ膨張（約33%増）を考慮

2. **データベースサイズ**
   - SQLiteのBLOB上限（約1GB）には余裕があるが、大量の画像で肥大化する可能性
   - 将来的にはファイルシステム保存への移行を検討

3. **API呼び出しのトークン消費**
   - 画像1枚あたり約1000-2000トークン（Claudeの見積もり）
   - **画像枚数は無制限**（依頼要件に従う）
   - 注意: 大量の画像を添付するとAPIコストが増加する旨をUI上で通知することを推奨

### セキュリティ

1. **ファイルタイプ検証**
   - MIMEタイプとファイル拡張子の両方をチェック
   - 画像以外のファイルを拒否

2. **XSS対策**
   - Base64データのサニタイズは不要（バイナリデータ）
   - ファイル名の表示時はエスケープ

### 既存機能への影響

1. **シナリオ削除**
   - `ON DELETE CASCADE`により画像も自動削除される
   - フロントエンド側での追加処理は不要

2. **シナリオ編集**
   - 既存画像はIDで識別し、削除フラグで管理
   - 新規画像はIDなしで追加
   - 保存時に差分処理を実行

## テスト計画

### ユニットテスト

1. **データベース操作**
   - 画像のCRUD操作
   - カスケード削除の動作確認
   - 生Base64形式での保存・取得

2. **コンポーネント**
   - ドラッグ&ドロップイベント処理
   - ファイルバリデーション
   - 画像プレビュー表示
   - Base64変換（data:プレフィックス除去）
   - 編集時の既存画像読み込み

3. **サービス**
   - agentLoopでのヒント画像添付
   - メッセージ構築の正確性

### 統合テスト

1. **E2Eフロー**
   - 画像付きシナリオの登録
   - 画像付きシナリオの編集（削除/保持/追加の各パターン）
   - 画像付きシナリオの実行
   - シナリオ削除時の画像削除

### 手動テスト

1. **UIテスト**
   - ドラッグ&ドロップの動作確認
   - 画像プレビューの表示確認
   - エラーメッセージの表示確認
   - 編集時の既存画像表示確認

2. **API統合テスト**
   - Claude APIへの画像添付確認
   - ヒント画像による認識精度の改善確認

## リスクと対策

| リスク | 影響度 | 対策 |
|-------|-------|------|
| 画像サイズが大きすぎてDBが肥大化 | 中 | 画像の自動リサイズ、最大サイズ制限（5MB/枚） |
| Claude APIのトークン消費増加 | 中 | UI上で画像枚数に応じたコスト増加を通知（枚数制限はしない） |
| マイグレーション失敗 | 高 | バックアップ推奨、ロールバック手順の準備 |
| ドラッグ&ドロップが一部ブラウザで動作しない | 低 | ファイル選択ダイアログのフォールバック機能 |
| 画像読み込み時のメモリ消費 | 低 | 遅延読み込み、サムネイル表示での最適化 |
| Data URL形式のままAPIに送信してエラー | 中 | Base64変換時にdata:プレフィックスを確実に除去 |

## 画像データの変換フロー（重要）

```
[ファイルドロップ]
     ↓
FileReader.readAsDataURL()
     ↓
"data:image/png;base64,iVBORw0KGgo..."  ← Data URL形式
     ↓
split(',')[1] でプレフィックス除去
     ↓
"iVBORw0KGgo..."  ← 生Base64
     ↓
[SQLite保存] image_data列 + mime_type列
     ↓
[API送信時]
{
  type: 'image',
  source: {
    type: 'base64',
    media_type: 'image/png',  ← mime_type列から
    data: 'iVBORw0KGgo...'    ← image_data列から（生Base64）
  }
}
```

## 編集時の画像差分処理ルール

### FormImageData の状態遷移

| 状態 | existingId | markedForDeletion | 保存時の処理 |
|------|------------|-------------------|-------------|
| 新規画像 | undefined | false | `addStepImage()` で追加 |
| 既存画像（保持） | あり | false | 何もしない |
| 既存画像（削除） | あり | true | `deleteStepImage()` で削除 |

### 処理フロー

```
[編集開始]
     ↓
getStepImages(scenarioId) で既存画像取得
     ↓
FormImageData[] に変換（existingId をセット）
     ↓
[ユーザー操作]
  - 削除ボタン → markedForDeletion = true
  - 新規ドロップ → existingId = undefined で追加
     ↓
[保存実行]
     ↓
images.filter(img => img.markedForDeletion && img.existingId)
  → deleteStepImage() で削除
     ↓
images.filter(img => !img.existingId && !img.markedForDeletion)
  → addStepImage() で追加
```

---

## 調査ログ

### 実行した検索語（Grep/Globパターン）

- `src/**/*.{ts,tsx,vue}` - フロントエンドのソースファイル一覧
- `src-tauri/**/*.rs` - Rustバックエンドのソースファイル一覧
- `*.json` - 設定ファイル（package.json, tsconfig.json等）
- `src-tauri/migrations/**` - 既存マイグレーションファイル
- `CREATE TABLE` - テーブル定義箇所
- `scenarios` - シナリオ関連のコード参照箇所
- `image|hint|capture` - 画像・ヒント関連のキーワード
- `drag|drop` - ドラッグ&ドロップ関連のキーワード
- `file|path|write|read|fs` - ファイルシステム関連

### 読んだファイル一覧

**主要コンポーネント:**
- `src/components/ScenarioForm.vue` - テストステップ登録フォーム（今回の主要変更対象）
- `src/components/ScenarioList.vue` - シナリオ一覧（ドラッグ&ドロップの参考実装）
- `src/App.vue` - メインアプリケーション

**型定義:**
- `src/types/database.ts` - データベース型定義
- `src/types/scenario.ts` - シナリオ型定義
- `src/types/testResult.ts` - テスト結果型定義
- `src/types/action.ts` - アクション型定義
- `src/types/capture.ts` - キャプチャ型定義
- `src/types/index.ts` - 型エクスポート

**サービス:**
- `src/services/scenarioDatabase.ts` - シナリオDB操作
- `src/services/scenarioRunner.ts` - シナリオ実行
- `src/services/agentLoop.ts` - Claude API呼び出しループ
- `src/services/claudeClient.ts` - Claude APIクライアント
- `src/services/actionValidator.ts` - アクション検証
- `src/services/resultJudge.ts` - 結果判定
- `src/services/historyManager.ts` - 会話履歴管理

**テスト:**
- `src/__tests__/scenarioDatabase.test.ts` - DB操作テスト

**バックエンド（Rust）:**
- `src-tauri/src/lib.rs` - メインライブラリ
- `src-tauri/migrations/001_create_scenarios.sql` - 既存マイグレーション
- `src-tauri/Cargo.toml` - 依存関係
- `src-tauri/tauri.conf.json` - Tauri設定
- `src-tauri/capabilities/default.json` - 権限設定

**設定:**
- `package.json` - npm設定
- `vite.config.ts` - Vite設定

### 辿ったimport/依存チェーン

1. `ScenarioForm.vue`
   → `types/index.ts` → `types/database.ts` (StoredScenario)

2. `App.vue`
   → `services/scenarioDatabase.ts` (CRUD操作)
   → `services/scenarioRunner.ts` (実行)

3. `scenarioRunner.ts`
   → `agentLoop.ts` (runAgentLoop)

4. `agentLoop.ts`
   → `claudeClient.ts` (getClaudeClient, buildComputerTool, RESULT_SCHEMA_INSTRUCTION)
   → `types/scenario.ts`, `types/action.ts`, `types/testResult.ts`

5. SQLiteマイグレーション
   → `lib.rs` (get_migrations)
   → `migrations/*.sql`

### 非TSファイル確認

- **package.json**: vue-draggable-plus（ドラッグ&ドロップ用）の存在を確認
- **tsconfig.json**: 確認済み
- **vite.config.ts**: マルチエントリビルド設定を確認
- **Cargo.toml**: tauri-plugin-sql使用を確認
- **tauri.conf.json**: sql権限設定を確認
- **capabilities/default.json**: SQL操作権限を確認

### 調査中の発見事項・懸念事項

1. **vue-draggable-plus**: ScenarioListで使用されており、画像の並び替えにも流用可能
2. **SQLiteプラグイン**: 既に設定済みで追加設定不要
3. **ファイルシステムアクセス**: Tauriのfsプラグインは未導入（今回はDB保存で対応）
4. **Base64画像処理**: 既にagentLoop内で画像のBase64エンコード/デコードが実装済み
5. **CASCADE削除**: SQLiteでFOREIGN KEY制約とON DELETE CASCADEがサポートされている

---

## フィードバック対応履歴

### v4 (今回の更新)

| 指摘 | 重大度 | 対応 |
|------|-------|------|
| ScenarioForm呼び出し例が`:edit-scenario`かつ`:visible`抜け | 高 | ✅ 対応済み - ステップ5-5のテンプレート例を修正。`:visible="showScenarioForm"` `:scenario="editingScenario"` `:existing-images="editingScenarioImages"`の形式に修正。実際のApp.vueの既存実装と整合させた |
| `handleSaveScenario`で存在しない`saveOrUpdateScenario`を呼び出し | 高 | ✅ 対応済み - ステップ5-6を全面改訂。既存の`createScenario`（戻り値から`id`取得）と`updateScenario`を使用する実装に修正。`editingScenario.value`の有無で新規/更新を判断するロジックを明記 |
| `editingScenarioImages`の初期化/クリア手順が不足 | 中 | ✅ 対応済み - ステップ5を大幅拡充。(1)`openNewScenarioForm`で空配列にクリア (2)`handleSaveScenario`完了後にクリア (3)`handleCancelForm`でクリア の3箇所を明記。「画像状態のクリアタイミングまとめ」表を追加 |

### v3

| 指摘 | 重大度 | 対応 |
|------|-------|------|
| ScenarioFormのprops案が現行の`visible`/`scenario`を含まない | 中 | ✅ 対応済み - ステップ4-1のprops定義を修正し、既存の`scenario`と`visible`を維持。`existingImages`のみ追加する形に変更 |
| 画像状態の初期化が`onMounted`のみで再オープン時にリセットされない | 中 | ✅ 対応済み - ステップ4-8を大幅改訂。`initializeImages()`ヘルパー関数を追加し、`watch`で`visible`/`existingImages`の変更を監視して再初期化するように変更 |
| 実行時のヒント画像付与が`runSelected`のみ記載 | 低 | ✅ 対応済み - ステップ8に「実行経路についての補足」を追加。現時点では`runSelected`のみが使用されていること、他の経路は未使用のため今回のスコープ外であることを明記 |

### v2

| 指摘 | 重大度 | 対応 |
|------|-------|------|
| 画像枚数上限を設けず無制限にする | 高 | ✅ 対応済み - バリデーション項目から「最大画像数チェック」を削除、リスク表からも「最大画像数制限（10枚）」を削除 |
| Base64変換の手順を明記（data:プレフィックス除去） | 中 | ✅ 対応済み - 「画像データの変換フロー」セクションを追加、fileToBase64関数の実装例を追加 |
| 編集時の画像保持/差分処理を具体化 | 低 | ✅ 対応済み - FormImageData型の追加、「編集時の画像差分処理ルール」セクションを追加、App.vueの差分処理ロジックを具体化 |

---

計画書ファイルパス: /Users/satoshizerocolored/dev/localtester2/implementation-plan-test-step-image-hints.md
