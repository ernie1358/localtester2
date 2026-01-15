# 実装計画書: UIブロッキング問題の修正

## 概要

テストステップ実行中および停止時にUIがブロッキング状態（マウスカーソルがぐるぐる回る）になる問題を修正する。具体的には以下の改善を行う：

1. **停止ボタンの即時応答**: 停止ボタンを押した瞬間にボタンをdisabled状態にし、UIの応答性を維持
2. **停止処理のバックグラウンド実行**: 重いクリーンアップ処理をUIスレッドから分離
3. **既存のブロッキング箇所の確認と改善**: 必要に応じてRust側のコマンドを非同期化
4. **緊急停止（Shift+Esc）でも同等のUI挙動を実現**: 緊急停止時もボタンがdisabled/「停止中...」表示になるよう対応

## 問題の原因分析

調査の結果、以下の点が判明：

### 1. フロントエンド側（TypeScript/Vue）
- `App.vue`の`stopExecution()`は`scenarioRunner.stop()`を呼び出すが、**同期的に実行される**
- `scenarioRunner.stop()`は以下を行う：
  - `invoke('request_stop')`: Rust側に停止要求を送信
  - `abortController.abort()`: AbortControllerでシグナルを送信
  - 現在実行中のシナリオのステータス更新
- 停止後も`agentLoop`内でLLMリクエストの完了を待つ可能性がある

### 2. バックエンド側（Rust）
- `capture_screen`コマンドは**同期的**（`#[tauri::command] pub fn capture_screen()`）
  - スクリーンキャプチャ、画像リサイズ、Base64エンコードをメインスレッドで実行
- `match_hint_images`コマンドは**非同期化済み**（`spawn_blocking`を使用）
- その他の入力コマンド（`left_click`など）は軽量なため問題なし

### 3. 停止時の問題
- 停止ボタンを押しても、進行中のLLMリクエスト（`callClaudeAPIViaProxy`）が完了するまでUIが応答しない
- `agentLoop`内のwhileループは`abortSignal.aborted`をチェックするが、**API呼び出し中はチェックされない**

### 4. 停止ボタン表示条件の分析（フィードバック対応）

**重要な発見**: App.vueの`isRunning`（31行目）とscenarioRunner.tsの`state.isRunning`（35行目）は**別々の変数**である。

- `App.vue:31`の`isRunning`は`ref(false)`で定義されたローカル変数
- `scenarioRunner.ts:35`の`this.state.isRunning`はScenarioRunnerクラス内部の状態
- **App.vueでは`onStateChange`コールバックを使用していない**
- App.vueの`isRunning`は`executeSelected()`の開始時にtrue、`finally`ブロックでのみfalseに設定される

**結論**:
- `scenarioRunner.stop()`内で`this.state.isRunning = false`を設定しても、App.vueのローカル`isRunning`には**影響しない**
- したがって、`stop()`内の`isRunning=false`を削除する必要は**ない**（削除しても影響がない）
- `isStopping`フラグの導入のみで目的達成可能

### 5. 緊急停止（Shift+Esc）の経路分析（フィードバック対応）

**経路の確認**:
```
hotkey.rs:43 → emit("emergency-stop") → scenarioRunner.ts:53 listen() → this.stop()
```

**問題点**:
- 緊急停止は`scenarioRunner.stop()`を直接呼び出すため、App.vueの`stopExecution()`を**経由しない**
- よって、`isStopping`フラグが立たず、「停止中...」表示/無効化がされない

**対応方針**:
- App.vueでも`emergency-stop`イベントをlistenし、`isStopping`フラグを更新する
- これにより、停止ボタンクリック/緊急停止の両方で同等のUI挙動を実現

## 影響範囲

### 変更が必要なファイル

| ファイル | 変更内容 | 理由 |
|---------|---------|------|
| `src/App.vue` | `isStopping`フラグ追加、`emergency-stop`リスナー追加、テンプレート条件変更 | 停止ボタン/緊急停止両方で即座にUI状態を更新 |
| `src/services/scenarioRunner.ts` | **変更なし**（`state.isRunning`はApp.vueに影響しないため維持） | フィードバック対応：`state.isRunning`更新は内部状態管理のため維持 |
| `src-tauri/src/commands/screenshot.rs` | `capture_screen`、`ensure_directory`、`save_base64_image`を非同期化（`spawn_blocking`適用） | メインスレッドのブロッキング防止 |

### 影響を受ける可能性があるファイル（変更不要）

| ファイル | 理由 |
|---------|------|
| `src/services/agentLoop.ts` | 既存のabort処理は適切に機能している |
| `src/services/claudeClient.ts` | fetchはブラウザ/Tauri WebViewで非同期処理される |
| `src-tauri/src/commands/template_match.rs` | 既に`spawn_blocking`で非同期化済み |
| `src-tauri/src/services/capture.rs` | `capture_primary_monitor()`自体は変更不要（呼び出し元で`spawn_blocking`適用） |
| `src-tauri/src/utils/hotkey.rs` | 既存の`emergency-stop`イベント発火は維持（App.vue側でlistenを追加） |

## 実装ステップ

### ステップ1: 停止ボタンのUI状態管理を追加（App.vue）

**目的**: 停止ボタン/緊急停止の両方で、即座にUIを更新し、ユーザーに停止処理中であることを明示する

```typescript
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// 追加するref
const isStopping = ref(false);

// 緊急停止リスナーの解除用
let emergencyStopUnlisten: UnlistenFn | null = null;

// onMounted内に追加: 緊急停止イベントのリスナー設定
onMounted(async () => {
  // ... 既存のコード ...

  // 緊急停止イベントをlistenしてisStopping更新
  emergencyStopUnlisten = await listen('emergency-stop', () => {
    if (isRunning.value && !isStopping.value) {
      isStopping.value = true;
      addLog('緊急停止が発動しました...');
    }
  });
});

// onUnmounted内に追加: リスナー解除
onUnmounted(async () => {
  // ... 既存のコード ...
  if (emergencyStopUnlisten) {
    emergencyStopUnlisten();
  }
});

// stopExecutionの改善
function stopExecution() {
  if (isStopping.value) return; // 二重クリック防止

  isStopping.value = true;
  addLog('停止処理を開始しています...');

  // stop()は停止シグナルを送信するのみ（即座に完了）
  scenarioRunner.stop();

  // 注意: isStopping.value = false はここでは設定しない
  // executeSelected()のfinally内で runSelectedScenarios 完了後に設定される
}

// executeSelected()の修正（finallyブロック）
async function executeSelected() {
  if (!canExecute.value) return;

  errorMessage.value = '';
  logs.value = [];
  isRunning.value = true;

  try {
    // ... 既存の実行処理 ...
  } catch (error) {
    // ... エラーハンドリング ...
  } finally {
    isRunning.value = false;
    // 停止処理が完了したので isStopping を解除
    if (isStopping.value) {
      isStopping.value = false;
      addLog('停止処理が完了しました');
    }
  }
}
```

テンプレート側の変更:
```html
<!-- isRunning || isStopping で停止中もボタンを表示 -->
<button
  v-if="!isRunning && !isStopping"
  @click="executeSelected"
  :disabled="!canExecute"
  class="execute-button"
>
  チェックしたテストステップを実行
</button>
<button
  v-else
  @click="stopExecution"
  :disabled="isStopping"
  :class="['danger-button', { 'stopping': isStopping }]"
>
  {{ isStopping ? '停止中...' : '停止 (Shift+Esc)' }}
</button>
```

**設計のポイント**:
- `stop()`は停止シグナルを送信するのみで即座に戻る
- `isStopping`の解除は`executeSelected()`の`finally`ブロックで行う
- 緊急停止（Shift+Esc）時も`emergency-stop`イベント経由で`isStopping`が立つ
- これにより、停止ボタンクリック/緊急停止の両方で「停止中...」表示が維持される

### ステップ2: ScenarioRunnerの停止処理について（変更不要）

**フィードバック対応**: 当初の計画では`stop()`内の`this.state.isRunning = false`を削除する予定でしたが、精査の結果**変更不要**と判断しました。

**理由**:
- `scenarioRunner.ts:203`の`this.state.isRunning`と`App.vue:31`の`isRunning`は**別の変数**
- App.vueでは`onStateChange`コールバックを使用していないため、`state.isRunning`の変更はUIに影響しない
- `state.isRunning = false`はScenarioRunner内部のループ制御（`if (!this.state.isRunning) break;`）に使用されている
- この内部ロジックを維持することで、停止シグナル後にforループが即座に抜けられる

**現状維持とする`stop()`メソッド（参考）**:
```typescript
public stop(finalStatus: 'stopped' | 'failed' = 'stopped'): void {
  this.state.isRunning = false; // ← 維持（内部ループ制御用）

  invoke('request_stop').catch((err) => {
    console.error('[Scenario Runner] Failed to request stop:', err);
  });

  if (this.abortController) {
    this.abortController.abort();
  }

  // ... 以降は既存のまま ...
}
```

### ステップ3: screenshot.rs内コマンドの非同期化（Rust側）

**目的**: スクリーンキャプチャ、ディレクトリ作成、画像保存をワーカースレッドで実行

**変更対象**: `src-tauri/src/commands/screenshot.rs`のみ（`capture.rs`は変更不要）

#### 3-1. capture_screenの非同期化

```rust
/// Capture screenshot from primary monitor (for Computer Use API)
/// Now async with spawn_blocking to prevent UI blocking
#[tauri::command]
pub async fn capture_screen() -> Result<CaptureResult, String> {
    // Offload CPU-intensive capture and image processing to worker thread
    tauri::async_runtime::spawn_blocking(move || {
        capture_primary_monitor()
    })
    .await
    .map_err(|e| format!("Capture task failed: {}", e))?
    .map_err(|e| e.to_string())
}
```

#### 3-2. ensure_directoryの非同期化（フィードバック3対応）

```rust
/// Ensure a directory exists (create if needed)
/// Now async with spawn_blocking to prevent UI blocking during directory operations
#[tauri::command]
pub async fn ensure_directory(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Directory creation task failed: {}", e))?
}
```

#### 3-3. save_base64_imageの非同期化（フィードバック3対応）

```rust
/// Save base64-encoded image data to a file
/// Now async with spawn_blocking to prevent UI blocking during Base64 decode and file I/O
#[tauri::command]
pub async fn save_base64_image(base64_data: String, file_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let image_data = BASE64_STANDARD
            .decode(&base64_data)
            .map_err(|e| format!("Failed to decode base64: {}", e))?;

        // Ensure parent directory exists
        if let Some(parent) = Path::new(&file_path).parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        fs::write(&file_path, image_data).map_err(|e| format!("Failed to write file: {}", e))
    })
    .await
    .map_err(|e| format!("Save image task failed: {}", e))?
}
```

**補足**:
- `capture_monitor_by_id`も同様に非同期化可能だが、現在使用されていないため変更対象外。必要に応じて後から対応可能。
- `get_monitors`は軽量な処理であり、非同期化の必要性は低い。

### ステップ4: CSSスタイルの追加（App.vue）

```css
.danger-button.stopping {
  background-color: #6c757d;
  cursor: wait;
}

.danger-button:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}
```

## 技術的考慮事項

### パフォーマンス

- `spawn_blocking`はTokioのブロッキングスレッドプールを使用
- スクリーンキャプチャは約50-200ms程度（解像度依存）
- 画像リサイズとBase64エンコードは追加で50-100ms程度
- ワーカースレッドで実行することでUIスレッドは即座に応答可能

### セキュリティ

- 変更はUIの応答性改善のみで、セキュリティに影響なし
- 既存の権限チェック（Screen Recording、Accessibility）は変更なし

### 既存機能への影響

- `capture_screen`の戻り値型は変更なし（`Result<CaptureResult, String>`）
- フロントエンドのコードは変更不要（`invoke`は既にPromiseを返す）
- `agentLoop`内の呼び出しは既に`await`しているため互換性あり
- `scenarioRunner.ts`の`state.isRunning`は維持（内部ループ制御に必要）

### エラーハンドリング

- `spawn_blocking`がパニックした場合、`JoinError`をStringにマップしてエラーとして返す
- 既存のエラーハンドリングパスはそのまま維持

### LLMリクエスト/画像マッチングの非同期処理確認

調査により以下が確認済み（変更不要）：

| 処理 | 実装 | UIブロッキング |
|------|------|----------------|
| LLMリクエスト | `claudeClient.ts`: `fetch` API使用 | なし（ブラウザ/WebView内で非同期実行） |
| テンプレートマッチング | `template_match.rs`: `spawn_blocking`使用 | なし（ワーカースレッドで実行） |
| Abort処理 | `agentLoop.ts`: `Promise.race`で即座にabort検知 | なし |

**確認方法**（テスト時に実施）:
1. テストステップ実行中にウィンドウの移動・リサイズが可能であることを確認
2. 長時間のLLMリクエスト中（APIレスポンス待ち）にUIが応答することを確認
3. 停止ボタン押下後、即座に「停止中...」表示に切り替わることを確認

## テスト計画

### 手動テスト

1. **停止ボタンの即時応答確認**
   - テストステップ実行中に停止ボタンをクリック
   - ボタンが即座にdisabled状態になり「停止中...」と表示されることを確認
   - マウスカーソルがビジー状態（ぐるぐる）にならないことを確認

2. **緊急停止（Shift+Esc）の即時応答確認**
   - テストステップ実行中にShift+Escを押下
   - ボタンが即座にdisabled状態になり「停止中...」と表示されることを確認
   - 「緊急停止が発動しました...」ログが表示されることを確認
   - 停止処理完了後に「停止処理が完了しました」ログが表示されることを確認

3. **停止処理完了の確認**
   - 停止後に「停止処理が完了しました」ログが表示されることを確認
   - `runSelectedScenarios`が実際に終了した後にボタンが「チェックしたテストステップを実行」に戻ることを確認
   - 停止中は「停止中...」が維持されることを確認

4. **スクリーンキャプチャのUI応答性確認**
   - テストステップ実行中にウィンドウの移動やリサイズが可能であることを確認
   - アプリが「応答なし」状態にならないことを確認

5. **表示条件の確認**
   - `isRunning=true`時に停止ボタンが表示されることを確認
   - 停止シグナル送信後、`runSelectedScenarios`完了前も停止ボタンが表示されることを確認
   - `runSelectedScenarios`完了後に実行ボタンが表示されることを確認

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
- 緊急停止（Shift+Esc）が正常に機能することを確認

## リスクと対策

| リスク | 影響度 | 対策 |
|-------|-------|------|
| `spawn_blocking`のスレッドプール枯渇 | 低 | Tokioのデフォルトプールサイズは十分大きい（512スレッド） |
| 停止処理中の二重クリック | 中 | `isStopping`フラグで二重実行を防止 |
| 既存の動作変更 | 低 | 戻り値型を変更しないことで互換性を維持 |
| テスト失敗 | 低 | 変更後に全テストを実行して確認 |
| 緊急停止時のUI状態不整合 | 中 | App.vueで`emergency-stop`をlistenして`isStopping`更新 |

## 調査ログ

### 実行した検索語（Grep/Globパターン）

- `停止|stop|abort|cancel` - 停止関連のコードを検索
- `agentLoop|agent.*loop` - エージェントループの実装を検索
- `capture_screen|capture_primary` - スクリーンキャプチャ関連
- `spawn_blocking` - 既存の非同期処理パターンを確認
- `invoke\(` - Tauriコマンド呼び出しを確認
- `*.{ts,tsx,vue,rs}` - 関連ファイルの特定
- `isRunning` - 実行状態フラグの使用箇所を確認
- `v-if.*isRunning` - テンプレート内の条件分岐を確認
- `emergency-stop|emergency_stop|Shift.*Esc|hotkey` - 緊急停止関連（フィードバック対応で追加）
- `ensure_directory|save_base64_image` - デバッグ用スクリーンショット保存（フィードバック3対応で追加）

### 読んだファイル一覧

**フロントエンド（src/）**:
- `App.vue` - メインアプリケーション、停止ボタンの実装、テンプレートの表示条件
- `services/agentLoop.ts` - エージェントループ、abort処理の実装
- `services/scenarioRunner.ts` - シナリオ実行管理、stop()メソッド
- `services/claudeClient.ts` - Claude APIクライアント、非同期リクエスト
- `services/actionValidator.ts` - アクション検証、LLMリクエスト

**バックエンド（src-tauri/）**:
- `src/lib.rs` - Tauriアプリケーション初期化
- `src/commands/screenshot.rs` - スクリーンキャプチャコマンド（★ブロッキング問題あり）
- `src/commands/template_match.rs` - テンプレートマッチング（非同期化済み、参考実装）
- `src/commands/control.rs` - 停止制御コマンド
- `src/commands/input.rs` - 入力コマンド
- `src/services/capture.rs` - スクリーンキャプチャサービス（変更不要と判断）
- `src/services/image_processor.rs` - 画像処理
- `src/services/template_matcher.rs` - テンプレートマッチング
- `src/state.rs` - アプリケーション状態
- `src/utils/hotkey.rs` - 緊急停止ホットキーハンドラ（フィードバック対応で追加確認）
- `Cargo.toml` - Rust依存関係

### 辿ったimport/依存チェーン

1. `App.vue` → `scenarioRunner.ts` → `agentLoop.ts` → `claudeClient.ts`
2. `App.vue` → `scenarioRunner.ts` → `invoke('request_stop')` → `control.rs`
3. `agentLoop.ts` → `invoke('capture_screen')` → `screenshot.rs` → `capture.rs`
4. `agentLoop.ts` → `invoke('match_hint_images')` → `template_match.rs` → `template_matcher.rs`
5. `hotkey.rs` → `emit("emergency-stop")` → `scenarioRunner.ts:53` (listen) → `stop()` （フィードバック対応で追加）
6. `agentLoop.ts:725,727` → `invoke('ensure_directory')` / `invoke('save_base64_image')` → `screenshot.rs:30,36`（フィードバック3対応で追加）

### 非TSファイル確認

- `package.json` - 確認済み（依存関係）
- `Cargo.toml` - 確認済み（Rust依存関係、tokio設定）
- `tsconfig.json` - 未確認（今回の変更に影響なし）

### 調査中に発見した関連情報・懸念事項

1. **template_match.rsは既に非同期化済み**: `spawn_blocking`パターンが既に使用されており、同じパターンをscreenshot.rsに適用可能

2. **ScenarioRunner.stop()は現在同期的**: `invoke('request_stop')`を非同期で呼び出しているが、`.catch()`でエラーを無視しているため、実質的には非同期だが、UIの状態更新は同期的に行われている

3. **agentLoopのabort処理は適切**: `Promise.race`を使用してAPI呼び出しとabortシグナルを競合させており、abortが発生すればnullを返す実装になっている

4. **App.vueのisRunningとscenarioRunner.state.isRunningは別変数**（フィードバック対応で確認）:
   - `App.vue:31`の`isRunning`はローカルの`ref(false)`
   - `scenarioRunner.ts:35`の`state.isRunning`はクラス内部状態
   - App.vueでは`onStateChange`を使っていないため、`state.isRunning`の変更はUIに影響しない
   - よって、`stop()`内の`state.isRunning = false`は**維持**（内部ループ制御に必要）

5. **緊急停止（Shift+Esc）はApp.vueのstopExecution()を経由しない**（フィードバック対応で確認）:
   - `hotkey.rs`が`emergency-stop`イベントを発火
   - `scenarioRunner.ts`のコンストラクタでlistenし、直接`this.stop()`を呼び出す
   - App.vueの`stopExecution()`は呼ばれないため、`isStopping`フラグが立たない
   - **対応**: App.vueでも`emergency-stop`をlistenして`isStopping`を更新

6. **spawn_blocking適用箇所**: `screenshot.rs`のコマンドレベルで適用（`capture.rs`は変更不要）

---

## フィードバック対応履歴

### フィードバック1: `isRunning`更新の不要性

**指摘**: `App.vue:31`はローカル`isRunning`のみを参照しており、`scenarioRunner.ts:202`の`state.isRunning`はUIに影響しない

**対応**:
- 精査の結果、指摘は**妥当**と判断
- `scenarioRunner.ts`の`stop()`内の`state.isRunning = false`は**維持**に変更
- 理由: 内部ループ制御（`if (!this.state.isRunning) break;`）に必要であり、App.vueのUIには影響しないため削除する意味がない
- App.vueには`isStopping`フラグのみを導入

### フィードバック2: 緊急停止でのUI状態更新

**指摘**: `emergency-stop`イベント経由の停止は`stopExecution()`を通らないため、UI状態更新がされない

**対応**:
- 指摘は**妥当**と判断
- App.vueで独自に`emergency-stop`イベントをlistenし、`isStopping`フラグを更新する設計を追加
- これにより、停止ボタンクリック/緊急停止の両方で同等のUI挙動（即時disabled/「停止中...」表示）を実現

### フィードバック3: ensure_directory/save_base64_imageの同期ブロッキング

**指摘**: `ensure_directory`（30行目）と`save_base64_image`（36行目）が同期コマンドのまま実行されており、ファイルI/OとBase64デコードがメインプロセスをブロックし得る。呼び出し元は`agentLoop.ts:725`と`agentLoop.ts:727`。

**精査結果**:
- 指摘は**技術的に妥当**と判断
- `ensure_directory`: `fs::create_dir_all`は通常軽量（ディレクトリ既存時は特に）だが、理論上ブロッキング対象
- `save_base64_image`: Base64デコード + ファイル書き込みは画像サイズ依存で数十ms程度かかる可能性あり
- これらは`verificationText`が設定されているテストステップでのみ実行される（デバッグ用）
- 呼び出しは`try-catch`で囲まれており、失敗してもログ出力のみで処理は続行

**影響度評価**: 低〜中
- デバッグ用途であり、常時実行されるわけではない
- ただし計画の「mainプロセスで重い処理をしない」方針との整合性を考慮し、対応を追加

**対応**:
- `ensure_directory`と`save_base64_image`も`spawn_blocking`で非同期化
- ステップ3に「3-2. ensure_directoryの非同期化」「3-3. save_base64_imageの非同期化」を追加
- 影響範囲テーブルの`screenshot.rs`説明を更新

---

計画書ファイルパス: /Users/satoshizerocolored/dev/localtester2/implementation-plan-ui-blocking-fix.md
