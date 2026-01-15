# 実装計画書: UIブロッキング問題の追加修正（v2.1）

## 概要

テストステップ実行中および停止時にUIがブロッキング状態（マウスカーソルがぐるぐる回る、アプリが固まった感じになる）という問題に対する追加修正計画。

既存の実装（コミット`b60fbf6`）では以下が対応済み：
- 停止ボタンの即時応答（`isStopping`フラグ導入）
- 緊急停止（Shift+Esc）でのUI状態更新
- `capture_screen`、`ensure_directory`、`save_base64_image`の`spawn_blocking`による非同期化
- `match_hint_images`の`spawn_blocking`による非同期化

**残存する問題**: 入力コマンド（マウス操作、キーボード操作）が同期的に実行されており、特に`thread::sleep`を含むため、Tauriのメインスレッドをブロックし得る。

## 問題の原因分析

### 1. 「LLMリクエスト時」および「画像マッチング時」のブロッキング検証

#### LLMリクエスト（claudeClient.ts）
**結論: 問題なし**

`src/services/claudeClient.ts`の`callClaudeAPIViaProxy`関数は`fetch` APIを使用しています（90行目）。`fetch`はブラウザのネイティブ非同期APIであり、フロントエンド（レンダラープロセス）で実行されます。Tauriのメインスレッド（Rustバックエンド）には一切影響しません。

```typescript
// claudeClient.ts:90 - fetchはブラウザの非同期API
const response = await fetch(edgeFunctionUrl, {
  method: 'POST',
  ...
});
```

#### 画像マッチング（template_match.rs）
**結論: 既に対応済み**

`src-tauri/src/commands/template_match.rs`の`match_hint_images`コマンドは、既に`async fn` + `spawn_blocking`パターンで実装されています（55-103行目）。

```rust
// template_match.rs:55-73
#[tauri::command]
pub async fn match_hint_images(...) -> Result<Vec<HintImageMatchResult>, String> {
    // Offload CPU-intensive template matching to a worker thread
    let results = tauri::async_runtime::spawn_blocking(move || {
        // 重い処理はワーカースレッドで実行
    })
    .await
    ...
}
```

### 2. Tauriの同期コマンドとメインスレッドブロッキングの検証

#### 検証根拠

Tauriの公式ドキュメントおよびGitHub Discussionsの調査結果より：

> "The main thing to have in mind is that doing something blocking in commands which run on the main thread will also block the UI (which also runs on the main thread)."
> — [Tauri Discussion #3561](https://github.com/tauri-apps/tauri/discussions/3561)

> "Using `#[tauri::command(async)]` works as expected, but if the async is removed, the function blocks"
> — [Tauri Discussion #10556](https://github.com/tauri-apps/tauri/discussions/10556)

#### 結論
**同期コマンド（`pub fn`で定義された`#[tauri::command]`）はTauriのメインスレッドで実行され、UIをブロックする**。これは計画書の前提が正しいことを裏付けています。

### 3. 入力コマンドの同期的なスリープ

`src-tauri/src/services/mouse.rs`のコードを確認すると、各マウス操作に`thread::sleep`が含まれている：

| 操作 | スリープ時間 | 理由 |
|------|-------------|------|
| クリック前 | 200ms (macOS) / 50ms (other) | ウィンドウマネージャがマウス位置を認識するまで待機 |
| クリック後 | 20ms | システムがクリックを処理するまで待機 |
| ダブル/トリプルクリック | 50ms × 2-3回 | 各クリック間の間隔 |
| ドラッグ | 50ms × 4回 | ドラッグの各ステップ間 |
| スクロール | 200ms + 20ms | 位置確定 + 処理待機 |

**影響**: 1回のクリック操作で約220ms、ダブルクリックで約320ms、トリプルクリックで約420msの間、Tauriのメインスレッドがブロックされる。

**注意**: これは意図的な設計であり、削除するとマウス操作が正しく認識されなくなる可能性がある。

### 4. 入力コマンドが同期コマンドとして定義されている

`src-tauri/src/commands/input.rs`では、すべての入力コマンドが`pub fn`（同期）として定義されている：

```rust
#[tauri::command]
pub fn left_click(x: i32, y: i32) -> Result<(), String> { ... }
```

これらを非同期化（`async fn` + `spawn_blocking`）することで、スリープ中もUIスレッドが応答可能になる。

### 5. 現在の処理フロー

```
フロントエンド(invoke) → Tauriメインスレッド → input.rs → mouse.rs(sleep含む)
                         ↑
                         ここがブロックされる
```

改善後：
```
フロントエンド(invoke) → Tauriメインスレッド → input.rs(async) → spawn_blocking → mouse.rs(sleep含む)
                         ↑
                         即座に戻る（Futureを返す）
```

## 影響範囲

### 変更が必要なファイル

| ファイル | 変更内容 | 理由 |
|---------|---------|------|
| `src-tauri/src/commands/input.rs` | すべてのコマンドを`async fn` + `spawn_blocking`に変更 | マウス/キーボード操作のスリープがメインスレッドをブロックしないようにする |

### 変更しないが影響を受ける可能性があるファイル

| ファイル | 理由 |
|---------|------|
| `src/services/agentLoop.ts` | 既に`await invoke()`で呼び出しているため、変更不要 |
| `src-tauri/src/services/mouse.rs` | サービス層は変更不要（コマンド層で非同期化） |
| `src-tauri/src/services/keyboard.rs` | サービス層は変更不要（コマンド層で非同期化） |

### 変更不要と確認したファイル（既に対応済み）

| ファイル | 状態 | 確認内容 |
|---------|------|---------|
| `src/services/claudeClient.ts` | 問題なし | `fetch` APIを使用（ブラウザの非同期API）、Tauriメインスレッドに影響なし |
| `src-tauri/src/commands/template_match.rs` | 対応済み | `async fn` + `spawn_blocking`で実装済み（55-103行目） |
| `src-tauri/src/commands/screenshot.rs` | 対応済み | `async fn` + `spawn_blocking`で実装済み |

## 実装ステップ

### ステップ1: input.rsのコマンドを非同期化

すべてのコマンドを`async fn` + `spawn_blocking`パターンに変更する。

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

**変更対象コマンド一覧**:
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

ファイル冒頭に非同期化の理由を明記：

```rust
//! Input operation commands (mouse, keyboard)
//!
//! All input commands are async and use `spawn_blocking` to prevent UI blocking.
//! Mouse operations include intentional delays (thread::sleep) for reliable input,
//! which would block the Tauri main thread if run synchronously.
```

## 技術的考慮事項

### パフォーマンス

- `spawn_blocking`はTokioのブロッキングスレッドプールを使用
- 各入力操作は独立しているため、スレッドプール枯渇のリスクは低い
- 入力操作の所要時間（200-400ms）に対して、スレッドプールのオーバーヘッドは無視できる

### セキュリティ

- 変更はUIの応答性改善のみで、セキュリティに影響なし
- 入力操作の挙動自体は変更しない

### 既存機能への影響

- フロントエンドのコードは変更不要（`invoke`は既にPromiseを返す）
- `agentLoop`内の呼び出しは既に`await`しているため互換性あり
- マウス/キーボードの実際の動作は変更なし（スリープタイミングも維持）

### エラーハンドリング

- `spawn_blocking`がパニックした場合、`JoinError`をStringにマップしてエラーとして返す
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

4. **停止完了後のボタン状態復帰確認** ★追加
   - 停止ボタン押下後、処理終了時に以下を確認：
     - ボタンのラベルが「停止中...」から「停止 (Shift+Esc)」に戻ること
     - ボタンの`disabled`状態が解除されること
     - ボタンの背景色がグレー（#999）から通常色（#ff4444）に戻ること
   - 正常終了時：実行ボタンが再度表示されること
   - 停止終了時：実行ボタンが再度表示されること
   - 関連コード箇所: `App.vue:341-347`（`executeSelected()`の`finally`ブロック）

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
| `spawn_blocking`のスレッドプール枯渇 | 低 | Tokioのデフォルトプールサイズは十分大きい（512スレッド） |
| 入力操作のタイミングずれ | 中 | サービス層のスリープは維持、コマンド層のみ非同期化 |
| 既存の動作変更 | 低 | 戻り値型を変更しないことで互換性を維持 |

## 調査ログ

### 実行した検索語（Grep/Globパターン）

- `停止|stop|abort|cancel` - 停止関連のコードを検索
- `LLM|claude|openai|anthropic` - LLMリクエスト関連
- `image.*(match|process)|template.*(match|process)` - 画像マッチング関連
- `spawn_blocking` - 既存の非同期処理パターンを確認
- `await invoke|invoke\(` - Tauriコマンド呼び出しを確認
- `isStopping` - 停止状態フラグの使用箇所を確認
- `resetStoppingState` - 停止状態リセットの実装を確認
- `*.{ts,tsx,vue,rs}` - 関連ファイルの特定
- `fetch` - LLMリクエストの実装方法を確認

### 読んだファイル一覧

**フロントエンド（src/）**:
- `App.vue` - メインアプリケーション、停止ボタンの実装、停止状態復帰の実装（341-347行目）
- `components/StopButton.vue` - 停止ボタンコンポーネント
- `composables/useStopButton.ts` - 停止ボタン状態管理
- `services/agentLoop.ts` - エージェントループ、abort処理、invokeコマンド呼び出し
- `services/scenarioRunner.ts` - シナリオ実行管理、stop()メソッド
- `services/claudeClient.ts` - Claude APIクライアント（**fetch API使用を確認**）
- `services/actionValidator.ts` - アクション検証

**バックエンド（src-tauri/）**:
- `src/lib.rs` - Tauriアプリケーション初期化、コマンドハンドラ登録
- `src/commands/input.rs` - 入力コマンド（★変更対象）
- `src/commands/screenshot.rs` - スクリーンキャプチャコマンド（**非同期化済み確認**）
- `src/commands/template_match.rs` - テンプレートマッチング（**非同期化済み確認**、55-103行目）
- `src/commands/control.rs` - 停止制御コマンド
- `src/services/mouse.rs` - マウス操作サービス（thread::sleep含む）
- `src/services/keyboard.rs` - キーボード操作サービス
- `src/services/capture.rs` - スクリーンキャプチャサービス
- `src/services/image_processor.rs` - 画像処理
- `src/services/template_matcher.rs` - テンプレートマッチング
- `src/state.rs` - アプリケーション状態
- `src/utils/hotkey.rs` - 緊急停止ホットキーハンドラ

**テストファイル**:
- `src/__tests__/useStopButton.test.ts` - 停止ボタンのユニットテスト（resetStoppingStateテスト含む）

### 辿ったimport/依存チェーン

1. `App.vue` → `scenarioRunner.ts` → `agentLoop.ts` → `invoke('left_click')` → `input.rs` → `mouse.rs`
2. `agentLoop.ts` → `invoke('capture_screen')` → `screenshot.rs` → `capture.rs` (非同期化済み)
3. `agentLoop.ts` → `invoke('match_hint_images')` → `template_match.rs` → `template_matcher.rs` (非同期化済み)
4. `agentLoop.ts` → `callClaudeAPIViaProxy()` → `claudeClient.ts` → `fetch()` (ブラウザ非同期API)

### 非TSファイル確認

- `Cargo.toml` - 確認済み（tokio設定は既存のまま使用可能）
- `package.json` - 確認済み（フロントエンドに影響なし）

### 調査中に発見した関連情報・懸念事項

1. **mouse.rsのスリープは意図的設計**: ウィンドウマネージャがマウス位置を認識するための待機時間であり、削除するとクリックが正しく認識されない可能性がある。

2. **既存の非同期化パターンが参考になる**: `screenshot.rs`と`template_match.rs`で既に`spawn_blocking`パターンが使用されており、同じパターンを適用可能。

3. **フロントエンドは変更不要**: `agentLoop.ts`内のすべての入力コマンド呼び出しは既に`await invoke()`形式であり、コマンドを非同期化しても互換性が維持される。

4. **LLMリクエストはTauriメインスレッドに影響しない**: `claudeClient.ts`は`fetch` APIを使用しており、フロントエンド（レンダラープロセス）で実行されるため、Tauriバックエンドのメインスレッドをブロックしない。

5. **画像マッチングは既に対応済み**: `template_match.rs`は`async fn` + `spawn_blocking`で実装されており、追加対応不要。

6. **停止ボタンの状態復帰は実装済み**: `App.vue:341-347`の`executeSelected()`関数の`finally`ブロックで`isStopping = false`がセットされ、停止完了後にボタンが通常状態に戻る。

### 外部リソースの参照

- [Tauri Discussion #3561: Any documentation about the main thread?](https://github.com/tauri-apps/tauri/discussions/3561)
- [Tauri Discussion #10556: Shell plugin example from docs blocks main thread](https://github.com/tauri-apps/tauri/discussions/10556)
- [Tauri Discussion #10329: Running CPU-bound blocking work in a command](https://github.com/tauri-apps/tauri/discussions/10329)

---

計画書ファイルパス: /Users/satoshizerocolored/dev/localtester2/implementation-plan-ui-blocking-fix-v2.md
