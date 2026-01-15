# 実装計画書: UIブロッキング問題の修正（v4）

## 概要

テストステップ実行中（特にLLMリクエスト時、画像マッチング処理時）にUIがブロッキング状態（マウスカーソルがぐるぐる回る、アプリが固まった感じになる）という問題、および停止ボタン押下後の応答遅延問題に対する修正計画。

**依頼内容の要約**:
1. テストステップ実行中にUIが固まった感じになる（マウスカーソルぐるぐる）
2. 停止ボタンを押してもしばらく固まった感じで時間がかかる
3. 停止ボタンを押したら即座にdisable状態（グレー表示）になり、処理完了後に通常状態に戻るようにしたい

## 前回の計画（v3）からの変更点

v3の計画（`input.rs`の非同期化）は**すでに実装済み**であることを確認。しかし、依然としてUIブロッキングが発生しているため、他の原因を調査した。

## 問題の原因分析（再調査）

### Rustバックエンド側の状況（すべて対応済み）

| コンポーネント | ファイル | 状態 |
|--------------|---------|------|
| 入力操作 | `input.rs` | ✅ `async fn` + `spawn_blocking` 実装済み |
| 画像マッチング | `template_match.rs` | ✅ `async fn` + `spawn_blocking` 実装済み |
| スクリーンキャプチャ | `screenshot.rs` | ✅ `async fn` + `spawn_blocking` 実装済み |
| 停止制御 | `control.rs` | ✅ 軽量な操作（AtomicBool）でブロッキングなし |

Rustバックエンド側は適切に非同期化されており、UIブロッキングの原因ではない。

### フロントエンド側の状況

| コンポーネント | ファイル | 状態 |
|--------------|---------|------|
| LLM APIクライアント | `claudeClient.ts` | ⚠️ `fetch`使用だが、AbortSignalが渡されていない |
| エージェントループ | `agentLoop.ts` | ⚠️ シーケンシャルなawaitが連続している |
| シナリオランナー | `scenarioRunner.ts` | ✅ 停止処理は適切 |
| 停止ボタン | `useStopButton.ts`, `StopButton.vue` | ✅ 適切に実装済み |

### 根本原因の特定

**UIが「固まった感じになる」原因は、JavaScriptのシングルスレッドモデルとmacOSのアプリケーション応答性検知機構の組み合わせ**:

1. **JavaScriptのイベントループ**: `await`で待機中でも、イベントループ自体は動作しているが、現在実行中の非同期関数が`await`から戻るまで、その関数の続きは実行されない

2. **macOSの「応答なし」検知**: アプリケーションが一定時間（数秒）イベントを処理しないと、macOSはアプリケーションが「応答なし」状態と判断し、ビーチボールカーソル（ぐるぐる）を表示する

3. **`agentLoop.ts`の問題**: 1回のイテレーションで複数の重い`await`が連続して実行される：
   - `invoke('capture_screen')` - スクリーンショット取得
   - `callClaudeAPIViaProxy()` - LLM API呼び出し（数秒〜数十秒待ち）
   - `invoke('match_hint_images')` - テンプレートマッチング
   - 各アクションの実行（`invoke('left_click')`等）

4. **停止ボタンの問題**: 停止ボタンをクリックしても、クリックイベントのハンドラ（`stopExecution()`）はすぐに実行されるが：
   - `scenarioRunner.stop()`は即座に`abortController.abort()`を呼ぶ
   - しかし、現在実行中の`fetch`（LLM API呼び出し）にAbortSignalが渡されていないため、API呼び出しが完了するまで`await`が終わらない
   - 結果として、UIは「停止中...」になるが、実際の処理停止まで時間がかかる

## 解決方針

### 方針1: LLM API呼び出しのキャンセル対応（優先度: 最高）

`claudeClient.ts`の`fetch`呼び出しにAbortSignalを渡し、停止ボタン押下時に即座にAPIリクエストをキャンセルできるようにする。

### 方針2: イベントループへの制御返却（優先度: 高）

長時間処理の合間に`setTimeout(0)`を挿入して、イベントループに制御を戻す機会を作る。これにより、UIの更新やユーザー入力の処理が可能になる。

### 方針3: 停止状態チェックの強化（優先度: 中）

`agentLoop.ts`内で、各主要な処理の前にAbortSignalの状態をチェックし、早期リターンを追加する。

## 影響範囲

### 変更が必要なファイル

| ファイル | 変更内容 | 理由 |
|---------|---------|------|
| `src/services/claudeClient.ts` | `fetch`にAbortSignalを渡す | LLM API呼び出しのキャンセル対応 |
| `src/services/agentLoop.ts` | AbortSignalを`callClaudeAPIViaProxy`に渡す、`yieldToMain()`の追加 | 停止処理の即時性向上、UIレスポンス改善 |

### 変更しないが確認済みのファイル（対応不要）

| ファイル | 状態 | 理由 |
|---------|------|------|
| `src/App.vue` | 対応不要 | 停止ボタンの状態管理は適切に実装済み |
| `src/components/StopButton.vue` | 対応不要 | UIコンポーネントは適切 |
| `src/composables/useStopButton.ts` | 対応不要 | 状態管理ロジックは適切 |
| `src/services/scenarioRunner.ts` | 対応不要 | `stop()`メソッドは適切に実装済み |
| `src-tauri/src/commands/input.rs` | 対応済み | `async fn` + `spawn_blocking` 実装済み |
| `src-tauri/src/commands/screenshot.rs` | 対応済み | `async fn` + `spawn_blocking` 実装済み |
| `src-tauri/src/commands/template_match.rs` | 対応済み | `async fn` + `spawn_blocking` 実装済み |
| `src-tauri/src/commands/control.rs` | 対応不要 | 軽量な操作でブロッキングなし |

### テストファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/__tests__/agentLoop.test.ts` | AbortSignal動作確認テストの追加（オプション） |

## 実装ステップ

### ステップ1: claudeClient.tsの修正

`callClaudeAPIViaProxy`関数にAbortSignalパラメータを追加し、`fetch`に渡す。

**変更前** (`src/services/claudeClient.ts:62-116`):
```typescript
export async function callClaudeAPIViaProxy(
  messages: BetaMessageParam[],
  captureResult: CaptureResult,
  modelConfig: ClaudeModelConfig = DEFAULT_CLAUDE_MODEL_CONFIG,
  systemPrompt?: string
): Promise<BetaMessage> {
  // ...
  const response = await fetch(edgeFunctionUrl, {
    method: 'POST',
    headers: { /* ... */ },
    body: JSON.stringify(requestBody),
  });
  // ...
}
```

**変更後**:
```typescript
export async function callClaudeAPIViaProxy(
  messages: BetaMessageParam[],
  captureResult: CaptureResult,
  modelConfig: ClaudeModelConfig = DEFAULT_CLAUDE_MODEL_CONFIG,
  systemPrompt?: string,
  abortSignal?: AbortSignal  // 追加
): Promise<BetaMessage> {
  // ...
  const response = await fetch(edgeFunctionUrl, {
    method: 'POST',
    headers: { /* ... */ },
    body: JSON.stringify(requestBody),
    signal: abortSignal,  // 追加
  });
  // ...
}
```

### ステップ2: callClaudeMessagesViaProxyの修正

同様に`callClaudeMessagesViaProxy`関数にもAbortSignalを追加。

**変更後** (`src/services/claudeClient.ts:129-178`):
```typescript
export async function callClaudeMessagesViaProxy(
  model: string,
  maxTokens: number,
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string | MessageContent[] }>,
  abortSignal?: AbortSignal  // 追加
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  // ...
  const response = await fetch(edgeFunctionUrl, {
    method: 'POST',
    headers: { /* ... */ },
    body: JSON.stringify(requestBody),
    signal: abortSignal,  // 追加
  });
  // ...
}
```

### ステップ3: agentLoop.tsの修正

#### 3.1: yieldToMainユーティリティ関数の追加

ファイル先頭付近に追加:
```typescript
/**
 * Yield to the main thread to allow UI updates and event processing.
 * This prevents the app from appearing "frozen" during long-running operations.
 */
function yieldToMain(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
```

#### 3.2: callClaudeAPI関数の修正

`callClaudeAPI`関数（`src/services/agentLoop.ts:1382-1419`）で、AbortSignalを`callClaudeAPIViaProxy`に渡す。

**変更前**:
```typescript
async function callClaudeAPI(
  messages: BetaMessageParam[],
  captureResult: CaptureResult,
  abortSignal: AbortSignal,
  modelConfig: ClaudeModelConfig
): Promise<BetaMessage | null> {
  // ...
  const apiPromise = callClaudeAPIViaProxy(
    messages,
    captureResult,
    modelConfig,
    RESULT_SCHEMA_INSTRUCTION
  );
  // ...
}
```

**変更後**:
```typescript
async function callClaudeAPI(
  messages: BetaMessageParam[],
  captureResult: CaptureResult,
  abortSignal: AbortSignal,
  modelConfig: ClaudeModelConfig
): Promise<BetaMessage | null> {
  // ...
  const apiPromise = callClaudeAPIViaProxy(
    messages,
    captureResult,
    modelConfig,
    RESULT_SCHEMA_INSTRUCTION,
    abortSignal  // 追加
  );
  // ...
}
```

#### 3.3: メインループでのyieldToMain呼び出し追加

`runAgentLoop`関数内の主要な`await`の前に`yieldToMain()`を挿入:

```typescript
// Main agent loop
while (iteration < config.maxIterationsPerScenario) {
  // Check for abort
  if (options.abortSignal.aborted) {
    return { /* ... */ };
  }

  // Yield to main thread for UI responsiveness
  await yieldToMain();

  const stopRequested = await invoke<boolean>('is_stop_requested');
  if (stopRequested) {
    return { /* ... */ };
  }

  // ... rest of the loop
}
```

また、ツール実行ループ内にも追加:
```typescript
for (const toolUse of toolUseBlocks) {
  // Yield to main thread between tool executions
  await yieldToMain();

  // Check abort before each action
  if (options.abortSignal.aborted) {
    return { /* ... */ };
  }
  // ...
}
```

### ステップ4: actionValidator.tsの修正（影響波及）

`askClaudeForActionCompletion`と`verifyTextOnScreen`関数でもAbortSignalをサポートする必要がある可能性がある。

**確認すべき箇所**:
- `src/services/actionValidator.ts` - `callClaudeMessagesViaProxy`を呼び出している箇所

必要に応じて、これらの関数にもAbortSignalパラメータを追加し、伝播させる。

## 技術的考慮事項

### パフォーマンス

- `yieldToMain()`の呼び出しは最小限に抑える（各イテレーションの先頭と、ツール実行の合間のみ）
- `setTimeout(0)`のオーバーヘッドは約1-4ms程度で、テスト実行全体に対する影響は無視できる

### セキュリティ

- 変更なし（既存のセキュリティモデルを維持）

### 既存機能への影響

- AbortSignalの追加は後方互換（オプションパラメータ）
- 停止処理の応答性が向上（改善）
- テスト実行の正確性に影響なし

### エラーハンドリング

- `fetch`がAbortSignalによってキャンセルされた場合、`AbortError`がスローされる
- 既存の`callClaudeAPI`関数内で`AbortError`は適切にハンドリングされている（`null`を返す）

## テスト計画

### 手動テスト

1. **停止ボタンの即時応答確認**
   - テストステップ実行中（LLM待機中）に停止ボタンをクリック
   - ボタンが即座に「停止中...」（disabled状態）に変わることを確認
   - 数秒以内に実行が停止することを確認（以前は数十秒かかる場合があった）

2. **UIの応答性確認**
   - テストステップ実行中にウィンドウの移動・リサイズが可能であることを確認
   - マウスカーソルがビーチボール（ぐるぐる）にならないことを確認

3. **停止完了後のボタン状態復帰確認**
   - 停止処理完了後、ボタンが「停止 (Shift+Esc)」に戻ることを確認
   - ボタンがenabled状態に戻ることを確認

4. **通常実行の動作確認**
   - テストステップが最後まで正常に実行されることを確認
   - LLM API呼び出し、画像マッチング、アクション実行が正常に機能することを確認

### 既存テストの実行

```bash
# フロントエンドテスト
npm test
```

### 回帰テスト

- 停止ボタンを押さずにテストステップを実行し、正常完了することを確認
- 緊急停止（Shift+Esc）が正常に機能することを確認

## リスクと対策

| リスク | 影響度 | 対策 |
|-------|-------|------|
| AbortSignal伝播の漏れ | 中 | コードレビューで全呼び出し箇所を確認 |
| yieldToMainによるタイミング変化 | 低 | 最小限の箇所にのみ追加 |
| 既存テストの失敗 | 低 | テスト実行で確認、必要に応じて修正 |

## 調査ログ

### 実行した検索パターン

- `Glob: src/**/*.ts` - 48ファイル発見
- `Glob: src/**/*.vue` - 8ファイル発見
- `Glob: src-tauri/**/*.rs` - ソースファイル特定
- `Grep: invoke (src/**/*.ts)` - 7ファイル発見
- `Grep: spawn_blocking (src-tauri/)` - 使用箇所確認

### 読んだファイル一覧

**フロントエンド（src/配下）**:
- `App.vue` - メインアプリケーション、停止処理確認
- `components/StopButton.vue` - 停止ボタンコンポーネント
- `composables/useStopButton.ts` - 停止ボタン状態管理
- `services/agentLoop.ts` - エージェントループ（1546行、詳細確認）
- `services/scenarioRunner.ts` - シナリオ実行管理
- `services/claudeClient.ts` - Claude APIクライアント（詳細確認）
- `__tests__/stopButton.test.ts` - 停止ボタンテスト
- `__tests__/useStopButton.test.ts` - composableテスト
- `__tests__/asyncCommands.test.ts` - 非同期コマンドテスト

**バックエンド（src-tauri/配下）**:
- `src/main.rs` - エントリーポイント
- `src/lib.rs` - ライブラリルート、コマンド登録
- `src/state.rs` - アプリケーション状態
- `src/commands/control.rs` - 停止制御コマンド
- `src/commands/input.rs` - マウス/キーボード入力（**async + spawn_blocking確認済み**）
- `src/commands/screenshot.rs` - スクリーンキャプチャ（**async + spawn_blocking確認済み**）
- `src/commands/template_match.rs` - テンプレートマッチング（**async + spawn_blocking確認済み**）
- `src/services/template_matcher.rs` - マッチング実装
- `src/services/capture.rs` - キャプチャ実装
- `Cargo.toml` - 依存関係

**設定ファイル**:
- `package.json` - プロジェクト設定

### 辿ったimport/依存チェーン

```
App.vue
├── executeSelected() → runSelectedScenarios()
│   └── scenarioRunner.ts → runAgentLoop()
│       └── agentLoop.ts
│           ├── callClaudeAPI() → callClaudeAPIViaProxy()
│           │   └── claudeClient.ts (fetch API)
│           ├── invoke('capture_screen') → screenshot.rs (async)
│           ├── invoke('match_hint_images') → template_match.rs (async)
│           └── invoke('left_click'等) → input.rs (async)
└── stopExecution() → scenarioRunner.stop()
    ├── invoke('request_stop') → control.rs
    └── abortController.abort()
```

### 非TSファイル確認

- `package.json` - 確認済み
- `Cargo.toml` - 確認済み（tokio依存設定）

### 発見した関連情報・懸念事項

1. **v3の計画は実装済み**: `input.rs`の全コマンドは既に`async fn` + `spawn_blocking`で実装されている
2. **問題の核心はフロントエンド**: LLM API呼び出しにAbortSignalが渡されていないため、停止リクエスト後もAPI待ちが継続する
3. **既存の停止ボタン実装は適切**: `useStopButton`と`StopButton.vue`は正しく設計されており、変更不要
4. **yieldToMainで応答性向上**: 長時間処理の合間にイベントループに制御を戻すことで、UIの応答性が向上する

---

計画書ファイルパス: /Users/satoshizerocolored/dev/localtester2/implementation-plan-ui-blocking-fix-v4.md
