# 実装計画書: UIブロッキング問題の修正（v3）

## 概要

テストステップ実行中（LLMリクエスト時、画像マッチング処理時など）にUIがブロッキング状態（マウスカーソルがぐるぐる回る、アプリが固まった感じになる）という問題、および停止ボタン押下後の応答遅延問題に対する修正計画。

**依頼内容の要約**:
1. テストステップ実行中にUIが固まった感じになる
2. 停止ボタンを押してもしばらく固まった感じで時間がかかる
3. 停止ボタンを押したら即座にdisable状態（グレー表示）になり、処理完了後に通常状態に戻るようにしたい

## 問題の原因分析

### 調査結果サマリ

| 処理 | 実行場所 | ブロッキング有無 | 対応状況 |
|------|----------|-----------------|---------|
| LLMリクエスト (`claudeClient.ts`) | フロントエンド（`fetch` API） | **なし** | 問題なし |
| 画像マッチング (`template_match.rs`) | バックエンド（`async fn` + `spawn_blocking`） | **なし** | 対応済み |
| スクリーンキャプチャ (`screenshot.rs`) | バックエンド（`async fn` + `spawn_blocking`） | **なし** | 対応済み |
| 入力操作 (`input.rs`) | バックエンド（同期 `pub fn`） | **あり** | ★未対応 |
| 停止ボタンUI状態管理 (`App.vue`, `StopButton.vue`) | フロントエンド | **部分的** | 既存実装あり |

### 1. 入力コマンド（input.rs）のブロッキング問題

**根本原因**: `src-tauri/src/commands/input.rs`のすべてのコマンドが同期関数（`pub fn`）として定義されており、内部で`thread::sleep`を使用している`mouse.rs`や`keyboard.rs`を呼び出している。

Tauriの公式ドキュメントによれば、同期コマンドはTauriのメインスレッドで実行され、UIをブロックする：

> "The main thing to have in mind is that doing something blocking in commands which run on the main thread will also block the UI"

**影響時間の内訳** (`src-tauri/src/services/mouse.rs` より):
| 操作 | スリープ時間 |
|------|-------------|
| クリック前 | 200ms (macOS) / 50ms (other) |
| クリック後 | 20ms |
| ダブル/トリプルクリック | 50ms × 2-3回 |
| ドラッグ | 50ms × 4回 |
| スクロール | 200ms + 20ms |

1回のクリック操作で約220ms、ダブルクリックで約320ms、トリプルクリックで約420msの間、Tauriのメインスレッドがブロックされる。

### 2. 停止ボタンの応答性

**現在の実装状態**:
- `App.vue:34` で `isStopping` フラグが定義されている
- `App.vue:351-361` の `stopExecution()` 関数で停止処理を開始
- `App.vue:344-347` の `finally` ブロックで `isStopping` をリセット
- `StopButton.vue` が `isStopping` プロパティに基づいてUI状態を更新

**分析結果**: 停止ボタンのUI状態管理は既に実装されている（`isStopping`フラグによる即時disable化）。しかし、入力操作の同期実行によりメインスレッドがブロックされるため、UIの更新（停止ボタンのグレーアウト等）が即座に反映されない可能性がある。

### 3. LLMリクエスト・画像マッチングは問題なし

- **LLMリクエスト**: `src/services/claudeClient.ts:90` で `fetch` API を使用。これはブラウザのネイティブ非同期APIであり、Tauriバックエンドのメインスレッドには影響しない。
- **画像マッチング**: `src-tauri/src/commands/template_match.rs:56-103` で既に `async fn` + `spawn_blocking` パターンが実装されている。

## 影響範囲

### 変更が必要なファイル

| ファイル | 変更内容 | 理由 |
|---------|---------|------|
| `src-tauri/src/commands/input.rs` | すべてのコマンドを `async fn` + `spawn_blocking` に変更 | マウス/キーボード操作のスリープがメインスレッドをブロックしないようにする |

### 変更しないが影響を受ける可能性があるファイル

| ファイル | 理由 |
|---------|------|
| `src/services/agentLoop.ts` | 既に `await invoke()` で呼び出しているため、変更不要 |
| `src-tauri/src/services/mouse.rs` | サービス層は変更不要（コマンド層で非同期化） |
| `src-tauri/src/services/keyboard.rs` | サービス層は変更不要（コマンド層で非同期化） |
| `src-tauri/src/lib.rs` | コマンドハンドラ登録は変更不要（シグネチャ変更はTauriが自動対応） |

### 変更不要と確認したファイル（既に対応済み）

| ファイル | 状態 | 確認内容 |
|---------|------|---------|
| `src/services/claudeClient.ts` | 問題なし | `fetch` APIを使用（ブラウザの非同期API）、Tauriメインスレッドに影響なし |
| `src-tauri/src/commands/template_match.rs` | 対応済み | `async fn` + `spawn_blocking`で実装済み（56-103行目） |
| `src-tauri/src/commands/screenshot.rs` | 対応済み | `async fn` + `spawn_blocking`で実装済み |
| `src/components/StopButton.vue` | 対応済み | `isStopping` プロパティに基づくUI状態管理が実装済み |
| `src/composables/useStopButton.ts` | 対応済み | 停止状態管理のロジックが実装済み |
| `src/App.vue` | 対応済み | `isStopping` フラグと停止処理のUI状態管理が実装済み |

## 実装ステップ

### ステップ1: input.rsのコマンドを非同期化

すべてのコマンドを `async fn` + `spawn_blocking` パターンに変更する。

**変更前（例: left_click）**:
```rust
#[tauri::command]
pub fn left_click(x: i32, y: i32) -> Result<(), String> {
    mouse::click(x, y, MouseButton::Left).map_err(|e| e.to_string())
}
```

**変更後**:
```rust
#[tauri::command]
pub async fn left_click(x: i32, y: i32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        mouse::click(x, y, MouseButton::Left).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Input task failed: {}", e))?
}
```

**変更対象コマンド一覧（13個）**:
1. `mouse_move` - マウス移動
2. `left_click` - 左クリック
3. `right_click` - 右クリック
4. `middle_click` - 中クリック
5. `double_click` - ダブルクリック
6. `triple_click` - トリプルクリック
7. `left_mouse_down` - マウスボタン押下
8. `left_mouse_up` - マウスボタン解放
9. `left_click_drag` - ドラッグ
10. `scroll` - スクロール
11. `type_text` - テキスト入力
12. `key` - キーコンビネーション
13. `hold_key` - キーホールド

### ステップ2: コメントの追加

ファイル冒頭のドキュメントコメントを更新し、非同期化の理由を明記：

```rust
//! Input operation commands (mouse, keyboard)
//!
//! All input commands are async and use `spawn_blocking` to prevent UI blocking.
//! Mouse operations include intentional delays (thread::sleep) for reliable input,
//! which would block the Tauri main thread if run synchronously.
```

## 技術的考慮事項

### パフォーマンス

- `spawn_blocking` はTokioのブロッキングスレッドプールを使用
- 各入力操作は独立しているため、スレッドプール枯渇のリスクは低い
- 入力操作の所要時間（200-400ms）に対して、スレッドプールのオーバーヘッドは無視できる
- Tokioのデフォルトブロッキングスレッドプールサイズは512スレッド

### セキュリティ

- 変更はUIの応答性改善のみで、セキュリティに影響なし
- 入力操作の挙動自体は変更しない

### 既存機能への影響

- フロントエンドのコードは変更不要（`invoke` は既にPromiseを返す）
- `agentLoop.ts` 内の呼び出しは既に `await` しているため互換性あり
- マウス/キーボードの実際の動作は変更なし（スリープタイミングも維持）
- コマンドの戻り値型 `Result<(), String>` は維持される

### エラーハンドリング

- `spawn_blocking` がパニックした場合、`JoinError` をStringにマップしてエラーとして返す
- 既存のエラーハンドリングパスはそのまま維持

## テスト計画

### 手動テスト

1. **UIの応答性確認**
   - テストステップ実行中にウィンドウの移動・リサイズが可能であることを確認
   - 停止ボタンを押した際に即座に「停止中...」に切り替わることを確認
   - マウスカーソルがビジー状態（ぐるぐる）にならないことを確認

2. **入力操作の正常動作確認**
   - クリック、ダブルクリック、トリプルクリックが正常に機能することを確認
   - ドラッグ操作が正常に機能することを確認
   - スクロール操作が正常に機能することを確認
   - テキスト入力、キーコンビネーションが正常に機能することを確認

3. **停止処理の確認**
   - テスト実行中に停止ボタンをクリックし、処理が停止することを確認
   - 緊急停止（Shift+Esc）が正常に機能することを確認

4. **停止完了後のボタン状態復帰確認**
   - 停止ボタン押下後、処理終了時に以下を確認：
     - ボタンのラベルが「停止中...」から「停止 (Shift+Esc)」に戻ること
     - ボタンの `disabled` 状態が解除されること
     - ボタンの背景色がグレー（#999）から通常色（#ff4444）に戻ること

### 既存テストの実行

```bash
# フロントエンドテスト
npm test

# Rustテスト
cd src-tauri && cargo test
```

### 回帰テスト

- 既存のテストステップ実行が正常に動作することを確認
- LLMリクエスト、画像マッチング、アクション実行が正常に機能することを確認

## リスクと対策

| リスク | 影響度 | 対策 |
|-------|-------|------|
| `spawn_blocking` のスレッドプール枯渇 | 低 | Tokioのデフォルトプールサイズは十分大きい（512スレッド） |
| 入力操作のタイミングずれ | 中 | サービス層のスリープは維持、コマンド層のみ非同期化 |
| 既存の動作変更 | 低 | 戻り値型を変更しないことで互換性を維持 |

## 調査ログ

### 実行した検索語（Grep/Globパターン）

- `src/**/*.{ts,tsx,vue}` - フロントエンドファイルの特定
- `src-tauri/**/*.rs` - Rustバックエンドファイルの特定（targetディレクトリ除外）
- `spawn_blocking` - 既存の非同期処理パターンを確認
- `thread::sleep` - ブロッキングスリープの使用箇所を確認
- `invoke\(` - Tauriコマンド呼び出しを確認
- `isStopping` - 停止状態フラグの使用箇所を確認
- `fetch` - LLMリクエストの実装方法を確認

### 読んだファイル一覧

**フロントエンド（src/）**:
- `App.vue` - メインアプリケーション、停止ボタンの実装、停止状態管理（34行目, 341-361行目）
- `components/StopButton.vue` - 停止ボタンコンポーネント
- `composables/useStopButton.ts` - 停止ボタン状態管理Composable
- `services/agentLoop.ts` - エージェントループ、abort処理、invokeコマンド呼び出し（1542行）
- `services/scenarioRunner.ts` - シナリオ実行管理、stop()メソッド
- `services/claudeClient.ts` - Claude APIクライアント（**fetch API使用を確認: 90行目**）

**バックエンド（src-tauri/）**:
- `src/lib.rs` - Tauriアプリケーション初期化、コマンドハンドラ登録（63-99行目）
- `src/commands/input.rs` - 入力コマンド（★変更対象、97行）
- `src/commands/screenshot.rs` - スクリーンキャプチャコマンド（**非同期化済み確認**）
- `src/commands/template_match.rs` - テンプレートマッチング（**非同期化済み確認、56-103行目**）
- `src/commands/control.rs` - 停止制御コマンド（48行）
- `src/services/mouse.rs` - マウス操作サービス（thread::sleep含む、257行）
- `src/services/keyboard.rs` - キーボード操作サービス（148行）

**設定ファイル**:
- `package.json` - プロジェクト設定確認
- `src-tauri/Cargo.toml` - Rust依存関係（確認対象だが読み込み省略）
- `src-tauri/tauri.conf.json` - Tauri設定（確認対象だが読み込み省略）

### 辿ったimport/依存チェーン

1. `App.vue` → `scenarioRunner.ts` → `agentLoop.ts` → `invoke('left_click')` → `input.rs` → `mouse.rs`
2. `agentLoop.ts` → `invoke('capture_screen')` → `screenshot.rs` → `capture.rs` (非同期化済み)
3. `agentLoop.ts` → `invoke('match_hint_images')` → `template_match.rs` → `template_matcher.rs` (非同期化済み)
4. `agentLoop.ts` → `callClaudeAPIViaProxy()` → `claudeClient.ts` → `fetch()` (ブラウザ非同期API)

### 非TSファイル確認の有無

- `package.json` - 確認済み（依存関係、スクリプト）
- `Cargo.toml` - 確認対象（tokio依存設定は既存のまま使用可能と推定）
- `tauri.conf.json` - 確認対象（コマンドの非同期化に設定変更は不要と推定）

### 調査中に発見した関連情報・懸念事項

1. **mouse.rsのスリープは意図的設計**: ウィンドウマネージャがマウス位置を認識するための待機時間であり、削除するとクリックが正しく認識されない可能性がある。この設計は維持する。

2. **既存の非同期化パターンが参考になる**: `screenshot.rs` と `template_match.rs` で既に `spawn_blocking` パターンが使用されており、同じパターンを適用可能。

3. **フロントエンドは変更不要**: `agentLoop.ts` 内のすべての入力コマンド呼び出しは既に `await invoke()` 形式であり、コマンドを非同期化しても互換性が維持される。

4. **LLMリクエストはTauriメインスレッドに影響しない**: `claudeClient.ts` は `fetch` APIを使用しており、フロントエンド（レンダラープロセス）で実行されるため、Tauriバックエンドのメインスレッドをブロックしない。

5. **画像マッチングは既に対応済み**: `template_match.rs` は `async fn` + `spawn_blocking` で実装されており、追加対応不要。

6. **停止ボタンの状態管理は実装済み**: `App.vue:341-347` の `executeSelected()` 関数の `finally` ブロックで `isStopping = false` がセットされ、停止完了後にボタンが通常状態に戻る。入力操作の非同期化により、この既存実装が期待通りに動作するようになる。

### 外部リソースの参照

- [Tauri Discussion #3561: Any documentation about the main thread?](https://github.com/tauri-apps/tauri/discussions/3561)
- [Tauri Discussion #10556: Shell plugin example from docs blocks main thread](https://github.com/tauri-apps/tauri/discussions/10556)
- [Tauri Discussion #10329: Running CPU-bound blocking work in a command](https://github.com/tauri-apps/tauri/discussions/10329)

---

計画書ファイルパス: /Users/satoshizerocolored/dev/localtester2/implementation-plan-ui-blocking-fix-v3.md
