# Xenotester コアエンジン実装計画書

## 1. 概要

### 1.1 プロジェクト概要
Xenotesterは、Claude Computer Use APIを活用し、Windows/macOSのOS全体のアプリケーションを跨いで自動操作・テストを行う軽量デスクトップエージェントです。Tauri 2.0をベースに、フロントエンド（TypeScript/Vue）でAIとの対話・履歴管理を行い、バックエンド（Rust）でOSのネイティブ操作（視覚・実行）を担当します。

### 1.2 現在の実装状況

現在のコードベースには、以下のコアエンジン機能が**既に実装済み**です：

| 機能 | 状況 | ファイル |
|------|------|----------|
| シナリオ分割 (Claude Opus 4.5) | ✅ 実装済 | `src/services/scenarioParser.ts` |
| エージェントループ | ✅ 実装済 | `src/services/agentLoop.ts` |
| Claude Computer Use API連携 | ✅ 実装済 | `src/services/claudeClient.ts` |
| スクリーンショット撮影 (xcap) | ✅ 実装済 | `src-tauri/src/services/capture.rs` |
| 画像リサイズ・Base64エンコード | ✅ 実装済 | `src-tauri/src/services/image_processor.rs` |
| マウス操作 (enigo) | ✅ 実装済 | `src-tauri/src/services/mouse.rs` |
| キーボード操作 (enigo) | ✅ 実装済 | `src-tauri/src/services/keyboard.rs` |
| 緊急停止ホットキー (Shift+Esc) | ✅ 実装済 | `src-tauri/src/utils/hotkey.rs` |
| ループ検出 | ✅ 実装済 | `src/utils/loopDetector.ts` |
| 会話履歴パージ | ✅ 実装済 | `src/services/historyManager.ts` |
| macOS権限管理 | ✅ 実装済 | `src-tauri/src/commands/permission.rs` |

### 1.3 実装が必要な項目

依頼内容と現在のコードを照合した結果、以下の項目について調整・改善が必要です：

| 項目 | 優先度 | 内容 |
|------|--------|------|
| Bézier curve マウス移動 | 中 | 人間らしいマウス移動オプション |
| Claude Opus 4.5 モデル設定の確認 | 高 | シナリオ分割時のモデル設定確認 |
| beta header の最新化 | 高 | `computer-use-2025-01-24` への更新確認 |
| エラーハンドリング改善 | 中 | より詳細なエラー情報の提供 |
| テストの追加 | 低 | 単体テスト・統合テストの追加 |

---

## 2. 影響範囲

### 2.1 変更が必要なファイル

#### TypeScript（フロントエンド）

| ファイル | 変更内容 | 理由 |
|----------|----------|------|
| `src/services/claudeClient.ts:37-43` | `computer_20250124` ツールタイプの確認 | 最新のAPI仕様に準拠しているか確認 |
| `src/services/agentLoop.ts:228-234` | beta headerの確認 | `computer-use-2025-01-24` が正しく設定されているか確認 |
| `src/services/scenarioParser.ts:43` | モデル名の確認 | `claude-opus-4-5-20251101` が正しいか確認 |

#### Rust（バックエンド）

| ファイル | 変更内容 | 理由 |
|----------|----------|------|
| `src-tauri/src/services/mouse.rs` | Bézier curve移動オプション追加 | 人間らしいマウス移動の実装（オプション） |
| `src-tauri/src/commands/input.rs` | 新コマンド追加（オプション） | Bézier移動用のIPCコマンド |

#### 変更しないが影響を受ける可能性があるファイル

| ファイル | 影響内容 |
|----------|----------|
| `src/App.vue` | UI変更なし（既存UIで対応可能） |
| `src-tauri/src/lib.rs` | 新コマンド追加時にinvoke_handler更新 |
| `src-tauri/Cargo.toml` | 依存関係変更なし |

---

## 3. 実装ステップ

### Phase 1: API設定の検証と修正（高優先度）

#### ステップ 1.1: Claude Computer Use API設定の確認
**対象ファイル**: `src/services/claudeClient.ts`

現在のコード（37-43行目）:
```typescript
export function buildComputerTool(captureResult: CaptureResult) {
  return {
    type: 'computer_20250124' as const,
    name: 'computer' as const,
    display_width_px: captureResult.resizedWidth,
    display_height_px: captureResult.resizedHeight,
    display_number: 1,
  };
}
```

**確認事項**:
- Claude Sonnet 4.5/Opus 4.1使用時: `computer_20250124` (現在の設定) ✓
- Claude Opus 4.5使用時: `computer_20251124` が必要（zoomアクション対応）
- 現在のコードはClaude Sonnet 4.5を使用しているため、現状で問題なし

#### ステップ 1.2: beta headerの確認
**対象ファイル**: `src/services/agentLoop.ts`

現在のコード（233行目）:
```typescript
betas: ['computer-use-2025-01-24'],
```

**確認結果**: 正しく設定されている ✓

#### ステップ 1.3: シナリオ分割モデルの確認
**対象ファイル**: `src/services/scenarioParser.ts`

現在のコード（43行目）:
```typescript
model: 'claude-opus-4-5-20251101',
```

**確認結果**: Claude Opus 4.5が正しく設定されている ✓

### Phase 2: Bézier curve マウス移動の実装（中優先度・オプション）

#### ステップ 2.1: Bézier curve計算モジュールの追加
**新規ファイル**: `src-tauri/src/utils/bezier.rs`

```rust
//! Bézier curve utilities for human-like mouse movement

/// Calculate a point on a quadratic Bézier curve
/// t: 0.0 to 1.0
pub fn quadratic_bezier(p0: (f64, f64), p1: (f64, f64), p2: (f64, f64), t: f64) -> (f64, f64) {
    let t2 = t * t;
    let mt = 1.0 - t;
    let mt2 = mt * mt;

    (
        mt2 * p0.0 + 2.0 * mt * t * p1.0 + t2 * p2.0,
        mt2 * p0.1 + 2.0 * mt * t * p1.1 + t2 * p2.1,
    )
}

/// Generate points along a Bézier curve for mouse movement
pub fn generate_bezier_path(
    start: (i32, i32),
    end: (i32, i32),
    steps: usize,
) -> Vec<(i32, i32)> {
    // Generate a random control point for natural curve
    let mid_x = (start.0 + end.0) as f64 / 2.0;
    let mid_y = (start.1 + end.1) as f64 / 2.0;

    // Add some randomness to the control point
    let offset_x = ((end.0 - start.0) as f64).abs() * 0.3;
    let offset_y = ((end.1 - start.1) as f64).abs() * 0.3;

    let control = (mid_x + offset_x, mid_y - offset_y);

    let p0 = (start.0 as f64, start.1 as f64);
    let p2 = (end.0 as f64, end.1 as f64);

    (0..=steps)
        .map(|i| {
            let t = i as f64 / steps as f64;
            let point = quadratic_bezier(p0, control, p2, t);
            (point.0.round() as i32, point.1.round() as i32)
        })
        .collect()
}
```

#### ステップ 2.2: mouse.rsへのBézier移動関数追加
**対象ファイル**: `src-tauri/src/services/mouse.rs`

追加する関数:
```rust
/// Move mouse with human-like Bézier curve trajectory
pub fn move_mouse_bezier(
    start_x: i32,
    start_y: i32,
    end_x: i32,
    end_y: i32,
    steps: usize,
) -> Result<(), XenotesterError> {
    use crate::utils::bezier::generate_bezier_path;

    let mut enigo = create_enigo()?;
    let path = generate_bezier_path((start_x, start_y), (end_x, end_y), steps);

    for (x, y) in path {
        enigo
            .move_mouse(x, y, Coordinate::Abs)
            .map_err(|e| XenotesterError::InputError(e.to_string()))?;
        thread::sleep(Duration::from_millis(5));
    }

    Ok(())
}
```

#### ステップ 2.3: IPCコマンドの追加
**対象ファイル**: `src-tauri/src/commands/input.rs`

追加するコマンド:
```rust
/// Move mouse with human-like Bézier curve (optional)
#[tauri::command]
pub fn mouse_move_bezier(
    start_x: i32,
    start_y: i32,
    end_x: i32,
    end_y: i32,
    steps: Option<u32>,
) -> Result<(), String> {
    let steps = steps.unwrap_or(20) as usize;
    mouse::move_mouse_bezier(start_x, start_y, end_x, end_y, steps)
        .map_err(|e| e.to_string())
}
```

#### ステップ 2.4: lib.rsへのコマンド登録
**対象ファイル**: `src-tauri/src/lib.rs`

`invoke_handler`に追加:
```rust
input::mouse_move_bezier,
```

#### ステップ 2.5: utils/mod.rsの更新
**対象ファイル**: `src-tauri/src/utils/mod.rs`

```rust
pub mod bezier;
pub mod hotkey;
```

### Phase 3: エラーハンドリング改善（中優先度）

#### ステップ 3.1: より詳細なエラー情報の追加
**対象ファイル**: `src/services/agentLoop.ts`

現在のエラーハンドリングは基本的に機能していますが、以下の改善が可能です：

1. API レート制限エラーの検出と待機
2. ネットワークエラーのリトライ
3. 画像サイズ超過エラーの検出

### Phase 4: テストの追加（低優先度）

#### ステップ 4.1: Rust単体テスト
**対象ファイル**: `src-tauri/src/services/image_processor.rs` (既存テストあり)

追加テストケース:
- Bézier curve計算の正確性
- エッジケース（同一座標への移動など）

#### ステップ 4.2: TypeScript単体テスト
**新規ファイル**: `src/__tests__/loopDetector.test.ts`

テストケース:
- ループ検出の正確性
- アクションハッシュの一意性

---

## 4. 技術的考慮事項

### 4.1 パフォーマンス

#### 画像圧縮
- **現状**: `src-tauri/src/services/image_processor.rs` で最大1560px、約115万ピクセルに制限 ✓
- **API制限**: 最大長辺1568px、約115万ピクセル
- **現在の実装は仕様に準拠している**

#### 履歴パージ
- **現状**: `src/services/historyManager.ts` で20ターン以上古い画像を削除 ✓
- **依頼内容**: 20ターンを超えた場合に古いtool_resultの画像を削除
- **現在の実装は仕様に準拠している**

### 4.2 セキュリティ

#### 停止スイッチ
- **現状**: `Shift+Escape` で緊急停止 ✓
- **実装**: `src-tauri/src/utils/hotkey.rs` で実装済み
- **依頼内容に準拠している**

#### 権限管理
- **現状**: macOSのScreen RecordingとAccessibility権限を確認・要求 ✓
- **実装**: `src-tauri/src/commands/permission.rs` で実装済み

### 4.3 既存機能への影響

Bézier curve移動の追加は**オプション機能**として実装することで、既存のマウス移動機能に影響を与えません。

---

## 5. テスト計画

### 5.1 単体テスト

| テスト対象 | テスト内容 |
|------------|------------|
| `bezier.rs` | Bézier曲線計算の正確性 |
| `loopDetector.ts` | ループ検出アルゴリズムの正確性 |
| `image_processor.rs` | 画像リサイズの境界条件 |

### 5.2 統合テスト

| テスト対象 | テスト内容 |
|------------|------------|
| シナリオ分割 | 複数シナリオの正しい分割 |
| エージェントループ | スクリーンショット→API→アクション実行の一連フロー |
| 緊急停止 | Shift+Escでの即時停止 |

### 5.3 E2Eテスト

| テスト対象 | テスト内容 |
|------------|------------|
| 簡単なシナリオ | 「メモ帳を開いて文字を入力する」など |
| ループ検出 | 意図的にループを発生させて検出確認 |

---

## 6. リスクと対策

### 6.1 API仕様変更リスク

| リスク | 影響度 | 対策 |
|--------|--------|------|
| Claude Computer Use APIの仕様変更 | 高 | beta headerとtool typeを設定ファイル化 |
| 新しいアクションタイプの追加 | 中 | 未知のアクションをログ出力して無視 |

### 6.2 パフォーマンスリスク

| リスク | 影響度 | 対策 |
|--------|--------|------|
| 大量の履歴によるメモリ逼迫 | 中 | 既存の履歴パージ機能で対応済み |
| 高解像度モニターでの遅延 | 低 | 既存の画像リサイズで対応済み |

### 6.3 セキュリティリスク

| リスク | 影響度 | 対策 |
|--------|--------|------|
| 暴走による意図しない操作 | 高 | 緊急停止ホットキー実装済み |
| 無限ループによるリソース消費 | 高 | ループ検出実装済み |

---

## 7. 調査ログ

### 7.1 実行した検索語（Grep/Globパターン）

| パターン | 目的 |
|----------|------|
| `src/**/*.ts` | TypeScriptソースファイルの特定 |
| `src/**/*.tsx` | TSXファイルの特定（なし） |
| `src-tauri/**/*.rs` | Rustソースファイルの特定 |
| `*.json` | 設定ファイルの特定 |
| `src-tauri/*.toml` | Cargo設定の特定 |
| `import.*from` | TypeScript依存関係の追跡 |
| `use ` | Rust依存関係の追跡 |
| `.env.example` | 環境変数サンプルの確認 |
| `src/**/*.vue` | Vueコンポーネントの特定 |

### 7.2 読んだファイル一覧

#### 設定ファイル
- `package.json` - プロジェクト設定
- `tsconfig.json` - TypeScript設定
- `src-tauri/Cargo.toml` - Rust依存関係
- `src-tauri/tauri.conf.json` - Tauri設定
- `.env.example` - 環境変数サンプル

#### TypeScript（src配下 15ファイル確認）
- `src/main.ts` - エントリポイント
- `src/App.vue` - メインUIコンポーネント
- `src/services/agentLoop.ts` - エージェントループ実装
- `src/services/claudeClient.ts` - Claude API クライアント
- `src/services/scenarioParser.ts` - シナリオ分割
- `src/services/scenarioRunner.ts` - シナリオ実行管理
- `src/services/historyManager.ts` - 履歴管理
- `src/services/index.ts` - サービス再エクスポート
- `src/types/index.ts` - 型定義再エクスポート
- `src/types/scenario.ts` - シナリオ型定義
- `src/types/action.ts` - アクション型定義
- `src/types/capture.ts` - キャプチャ型定義
- `src/utils/loopDetector.ts` - ループ検出
- `src/utils/coordinateScaler.ts` - 座標スケーリング
- `src/utils/index.ts` - ユーティリティ再エクスポート

#### Rust（src-tauri/src配下 16ファイル確認）
- `src-tauri/src/main.rs` - エントリポイント
- `src-tauri/src/lib.rs` - ライブラリ定義
- `src-tauri/src/state.rs` - アプリケーション状態
- `src-tauri/src/error.rs` - エラー定義
- `src-tauri/src/commands/mod.rs` - コマンドモジュール
- `src-tauri/src/commands/screenshot.rs` - スクリーンショットコマンド
- `src-tauri/src/commands/input.rs` - 入力コマンド
- `src-tauri/src/commands/control.rs` - 制御コマンド
- `src-tauri/src/commands/config.rs` - 設定コマンド
- `src-tauri/src/commands/permission.rs` - 権限コマンド
- `src-tauri/src/services/mod.rs` - サービスモジュール
- `src-tauri/src/services/capture.rs` - スクリーンキャプチャ
- `src-tauri/src/services/mouse.rs` - マウス操作
- `src-tauri/src/services/keyboard.rs` - キーボード操作
- `src-tauri/src/services/image_processor.rs` - 画像処理
- `src-tauri/src/utils/mod.rs` - ユーティリティモジュール
- `src-tauri/src/utils/hotkey.rs` - ホットキー処理

### 7.3 辿った import/依存チェーン

```
App.vue
├── services/scenarioParser.ts
│   └── services/claudeClient.ts
│       └── @anthropic-ai/sdk
├── services/scenarioRunner.ts
│   └── services/agentLoop.ts
│       ├── services/claudeClient.ts
│       ├── services/historyManager.ts
│       ├── utils/coordinateScaler.ts
│       └── utils/loopDetector.ts
└── types/index.ts
    ├── types/action.ts
    ├── types/capture.ts
    └── types/scenario.ts
```

```
lib.rs
├── commands/
│   ├── config.rs
│   ├── control.rs
│   │   └── state.rs
│   ├── input.rs
│   │   ├── services/mouse.rs
│   │   │   └── error.rs
│   │   └── services/keyboard.rs
│   │       └── error.rs
│   ├── permission.rs
│   └── screenshot.rs
│       └── services/capture.rs
│           ├── services/image_processor.rs
│           └── error.rs
├── state.rs
│   └── global_hotkey
└── utils/hotkey.rs
    └── state.rs
```

### 7.4 非TSファイル確認の有無

| ファイル種別 | 確認状況 |
|--------------|----------|
| package.json | ✓ 確認済み |
| tsconfig.json | ✓ 確認済み |
| Cargo.toml | ✓ 確認済み |
| tauri.conf.json | ✓ 確認済み |
| .env.example | ✓ 確認済み |

### 7.5 調査中に発見した関連情報・懸念事項

#### 発見事項
1. **コードベースは既にほぼ完成している**: 依頼内容の大部分が既に実装済み
2. **Claude Computer Use API仕様との整合性**: 現在の実装は最新仕様に準拠
3. **Bézier curve移動は未実装**: オプション機能として追加可能

#### 懸念事項
1. **Claude Opus 4.5との互換性**: 現在はSonnet 4.5を使用。Opus 4.5使用時は`computer_20251124`とbeta header `computer-use-2025-11-24` が必要
2. **テスト不足**: 単体テストは`image_processor.rs`のみ。他のモジュールにテストなし
3. **エラーメッセージの国際化**: 現在は英語のみ

---

## 8. 結論

現在のコードベースは、依頼内容で要求されているXenotesterコアエンジンの機能を**ほぼ完全に実装済み**です。

### 実装済み機能（変更不要）
- シナリオ分割（Claude Opus 4.5）
- エージェントループ
- Claude Computer Use API連携（`computer_20250124`、`computer-use-2025-01-24`）
- スクリーンショット撮影・リサイズ（最大1560px）
- マウス・キーボード操作（enigo）
- ループ検出
- 履歴パージ（20ターン以上の画像削除）
- 緊急停止ホットキー（Shift+Escape）
- macOS権限管理

### オプションで追加可能な機能
- Bézier curveによる人間らしいマウス移動
- より詳細なエラーハンドリング
- 単体テスト・統合テストの追加

---

計画書ファイルパス: /Users/satoshizerocolored/dev/localtester2/implementation-plan.md
