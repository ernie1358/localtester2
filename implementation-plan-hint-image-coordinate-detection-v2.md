# 実装計画書: ヒント画像座標検出機能

## 1. 概要

**依頼内容**: ヒント画像をLLMに渡す前に画像認識（テンプレートマッチング）を実行し、スクリーンショット内でヒント画像が存在する位置の中心座標を検出してLLMに渡すことで、LLMの検出精度を向上させる。

## 2. 調査結果: 機能は既に完全に実装済み

徹底的な調査の結果、**依頼された機能は既に現在のブランチ（feature/hint-image-coordinate-detection）に完全に実装済み**であることが判明しました。

### 既存実装の詳細

#### 2.1 Rust側（テンプレートマッチング）

- **ファイル**: `src-tauri/src/services/template_matcher.rs`
- **内容**:
  - `imageproc` crate の Normalized Cross-Correlation (NCC) アルゴリズムを使用
  - 透明PNG（アイコン等）に対応したアルファ合成処理
  - 中心座標の計算（左上ではなく中央点を返す）
  - スケールファクターの考慮（LLMに渡すリサイズ済みスクリーンショットと同じスケール）
  - エラーコードによる堅牢なエラーハンドリング

```rust
// find_template_internal より抜粋
let center_x = match_x as i32 + (template_width / 2) as i32;
let center_y = match_y as i32 + (template_height / 2) as i32;
```

- **ファイル**: `src-tauri/src/commands/template_match.rs`
- **内容**: Tauri IPCコマンド `match_hint_images` の定義

#### 2.2 TypeScript側（agentLoop統合）

- **ファイル**: `src/services/agentLoop.ts`
- **内容**:
  - 初期スクリーンショット取得後に `match_hint_images` を呼び出し
  - 検出された座標をヒントテキストに含める
  - 画面遷移時に未検出画像の再マッチング
  - 画面変更時に検出済み画像の座標更新

**実装済みの座標フォーマット（246-261行目）**:
```typescript
const detectedCoordinates = matchResults
  .filter((r) => r.matchResult.found && !r.matchResult.error)
  .map(
    (r) =>
      `画像${r.index + 1}(${r.fileName}): ${r.matchResult.centerX},${r.matchResult.centerY}`
  )
  .join(' / ');

if (detectedCoordinates) {
  hintText += `\n\n【画像認識による座標（各画像の中心点）】\n${detectedCoordinates}\n\n上記の座標は画像認識で検出した位置です。これらを参考にして正確に操作してください。`;
}
```

#### 2.3 型定義

- **ファイル**: `src/types/capture.ts`
- **内容**: `HintImageMatchResult`, `MatchErrorCode` 型定義済み

### 2.4 テスト

- **ファイル**: `src/__tests__/agentLoop.test.ts`
- **ファイル**: `src/__tests__/agentLoop.screenChange.test.ts`
- **内容**:
  - 座標検出のメッセージ構築テスト
  - 部分的な検出時の動作テスト
  - 画面遷移時の再マッチングテスト
  - エラーハンドリングテスト

- **ファイル**: Rust側の単体テスト（`template_matcher.rs` 内）
- **内容**:
  - 中心座標計算テスト
  - スケールファクター適用テスト
  - 透明PNG処理テスト
  - バッチマッチングテスト

## 3. 影響範囲

**変更が必要なファイル: なし**

依頼された機能は既に完全に実装されており、追加の変更は不要です。

### 現在の実装で対応済みの要件

| 要件 | 実装状況 | 実装箇所 |
|------|----------|----------|
| スクリーン全体とヒント画像のテンプレートマッチング | ✅ 完了 | `template_matcher.rs` |
| 中心座標の計算（左上ではなく中央） | ✅ 完了 | `template_matcher.rs:320-321` |
| 複数画像の個別マッチング | ✅ 完了 | `match_templates_batch` |
| 座標をLLMに渡すメッセージに含める | ✅ 完了 | `agentLoop.ts:246-264` |
| Tauri/Rust での画像処理 | ✅ 完了 | `imageproc` crate 使用 |
| 画面遷移時の再マッチング | ✅ 完了 | `agentLoop.ts:754-901` |

## 4. 実装ステップ

**追加の実装は不要です。**

## 5. 技術的考慮事項

既存実装で考慮済み:

1. **パフォーマンス最適化**:
   - スクリーンショットは1回のみデコードし、複数テンプレートに再利用
   - `spawn_blocking` で重い処理をワーカースレッドにオフロード

2. **スケール整合性**:
   - ヒント画像とスクリーンショットに同じスケールファクターを適用
   - 座標はLLMに渡すリサイズ済み座標系で返却

3. **エラーハンドリング**:
   - 個別画像のエラーは他の画像の処理に影響しない
   - エラーコードによるプログラマティックなエラー識別

4. **透明PNG対応**:
   - アルファチャンネルを考慮した白背景合成
   - 不透明度チェックによる信頼性の低い画像の検出

## 6. テスト計画

既存テストでカバー済み:

- `src/__tests__/agentLoop.test.ts` - 座標検出メッセージ構築
- `src/__tests__/agentLoop.screenChange.test.ts` - 画面変更時の再マッチング
- Rust側ユニットテスト - テンプレートマッチングロジック

## 7. リスクと対策

**リスク: なし**

機能は既に実装・テスト済みであり、追加の変更は不要です。

## 8. 調査ログ

### 実行した検索語

- `hint.*image|image.*hint` (Grep)
- `StepImage|HintImageMatchResult|MatchResult` (Grep)
- `src/**/*.{ts,tsx,vue}` (Glob)
- `src-tauri/**/*.rs` (Glob)

### 読んだファイル一覧

**Rust側**:
- `src-tauri/src/services/template_matcher.rs` - テンプレートマッチング実装（965行）
- `src-tauri/src/commands/template_match.rs` - IPCコマンド定義（104行）
- `src-tauri/src/lib.rs` - コマンド登録確認
- `src-tauri/Cargo.toml` - 依存関係確認（`imageproc = "0.25"`）

**TypeScript側**:
- `src/services/agentLoop.ts` - メインエージェントループ（1205行）
- `src/services/scenarioRunner.ts` - シナリオ実行オーケストレーション
- `src/types/capture.ts` - 型定義
- `src/types/database.ts` - StepImage型定義
- `src/constants/hintImages.ts` - ヒント画像制約

**テスト**:
- `src/__tests__/agentLoop.test.ts` - 座標検出テスト（2071行）
- `src/__tests__/agentLoop.screenChange.test.ts` - 画面変更時テスト（793行）
- `src/__tests__/hintImages.test.ts` - ヒント画像制約テスト

**コンポーネント**:
- `src/components/ScenarioForm.vue` - ヒント画像UI

### 辿った import/依存チェーン

1. `agentLoop.ts` → `@tauri-apps/api/core` (invoke) → `match_hint_images` コマンド
2. `lib.rs` → `template_match.rs` → `template_matcher.rs`
3. `agentLoop.ts` → `types/capture.ts` (HintImageMatchResult)

### 非TSファイル確認

- `src-tauri/Cargo.toml` - `imageproc = "0.25"` 依存関係確認済み
- `src-tauri/migrations/002_create_step_images.sql` - マイグレーション確認済み

### 調査中に発見した関連情報

- 最近のコミット履歴から、この機能はすでに複数のイテレーションを経て改善されていることが確認できた:
  - `bd182f1` - async match_hint_images + error codes for robust error handling
  - `cbe792e` - fix: improve hint image error handling for edge cases
  - `6864849` - fix: correctly identify screenshot decode errors as transient
  - `5fb4985` - fix: improve hint image error handling and add screen change tests
  - `73547a2` - fix: update hint image re-matching to handle screen changes and permanent errors

## 9. 結論

**依頼された機能は既に完全に実装済みです。**

現在のブランチ `feature/hint-image-coordinate-detection` には、ヒント画像のテンプレートマッチングによる座標検出機能が以下の形で実装されています:

1. **Rust側**: `imageproc` crate を使用したNCC（正規化相互相関）アルゴリズムによるテンプレートマッチング
2. **座標計算**: 検出位置の中心点を計算（左上ではなく中央）
3. **LLMへの送信**: 「画像認識による座標（各画像の中心点）」として座標情報をヒントテキストに含める
4. **再マッチング**: 画面遷移時に座標を更新

追加の実装作業は不要です。

---

計画書ファイルパス: /Users/satoshizerocolored/dev/localtester2/implementation-plan-hint-image-coordinate-detection-v2.md
