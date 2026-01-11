# Xenotester コアエンジン実装計画書

## 1. 概要

### 1.1 プロジェクト概要
Xenotesterは、自然言語（Claude Opus 4.5）を司令塔とし、OS（Windows/macOS）全体のアプリケーションを跨いで操作・テストを行う軽量デスクトップエージェントです。

### 1.2 コアバリュー
- Pythonランタイム不要の単一バイナリ配布
- 低リソース消費
- マルチアプリ連携（ブラウザ＋デスクトップアプリ）

### 1.3 技術スタック

| 役割 | ライブラリ / 技術 | 選定理由 |
|------|------------------|---------|
| ベース | Tauri 2.0 | Rustによる安全かつ軽量なデスクトップアプリ基盤 |
| 視覚（目） | xcap (v0.8.0) | クロスプラットフォーム・キャプチャ。特定エリアの高速切り抜きに強い |
| 操作（手） | enigo (v0.6.1) | マウス移動、クリック、キー入力のOSレベルシミュレーション |
| AI（脳） | Claude Opus 4.5 | Computer Use APIに対応した最高精度のLLM |
| 画像処理 | image (Rust crate) | スクリーンショットのリサイズ・圧縮・Base64エンコード |
| 認識（補助） | opencv-rust (v0.93) | 高速なテンプレートマッチング・画像認識。将来的なUI要素検出の拡張用 |
| macOS権限 | tauri-plugin-macos-permissions | 画面収録・アクセシビリティ権限の管理 |

---

## 2. システムアーキテクチャ

### 2.1 全体構成図

```
┌─────────────────────────────────────────────────────────────────┐
│                     Xenotester Application                       │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Frontend (TypeScript/Vite)                  │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │    │
│  │  │ Scenario     │  │ Scenario     │  │ History      │   │    │
│  │  │ Input UI     │  │ Runner       │  │ Manager      │   │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘   │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │    │
│  │  │ Claude API   │  │ Scenario     │  │ Result       │   │    │
│  │  │ Client       │  │ Parser       │  │ Viewer       │   │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘   │    │
│  └──────────────────────────────────────────────────────────┘    │
│                             │ Tauri IPC (invoke/emit)            │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                Backend (Rust/Tauri)                      │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │    │
│  │  │ Screenshot   │  │ Input        │  │ Permission   │   │    │
│  │  │ Module (xcap)│  │ Module(enigo)│  │ Manager      │   │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘   │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │    │
│  │  │ Image        │  │ Hotkey       │  │ Bezier       │   │    │
│  │  │ Processor    │  │ Guard        │  │ Movement     │   │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘   │    │
│  └──────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │    Anthropic Claude API        │
              │    (Computer Use Beta)         │
              └───────────────────────────────┘
```

### 2.2 エージェントループフロー

```
[ユーザー入力]
      │
      ▼
┌─────────────────┐
│ シナリオパース  │ ◄─── Claude Opus 4.5で複数シナリオ分割
│ (Frontend)      │
└─────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────┐
│              シナリオループ                      │
│  ┌───────────────────────────────────────────┐  │
│  │           エージェントループ              │  │
│  │  ┌─────────────────────────────────────┐  │  │
│  │  │ 1. スクリーンショット取得 (Rust)    │  │  │
│  │  │ 2. 画像リサイズ・圧縮 (Rust)        │  │  │
│  │  │ 3. Claude API送信 (TypeScript)      │  │  │
│  │  │ 4. tool_use解析                     │  │  │
│  │  │ 5. アクション実行 (Rust/enigo)      │  │  │
│  │  │ 6. 結果スクリーンショット           │  │  │
│  │  │ 7. tool_result送信                  │  │  │
│  │  │ 8. 完了判定 or 無限ループ検出       │  │  │
│  │  └─────────────────────────────────────┘  │  │
│  │           ↑                   │            │  │
│  │           └───────────────────┘            │  │
│  │        (tool_useがある限り繰り返し)        │  │
│  └───────────────────────────────────────────┘  │
│                     │                            │
│                     ▼                            │
│           次のシナリオへ                         │
└─────────────────────────────────────────────────┘
```

### 2.3 シナリオ完了判定ルール

エージェントループの終了条件は以下のルールで判定する：

#### 正常完了条件
1. **tool_useブロック不在**: Claudeの応答に`tool_use`コンテンツブロックが含まれない場合、シナリオ完了と判定
   - 応答が`text`ブロックのみで構成される場合
   - Claudeが「完了しました」等のテキストで完了を報告した場合

```typescript
// シナリオ完了判定の実装例
function isScenarioComplete(response: BetaMessage): boolean {
  const hasToolUse = response.content.some(
    block => block.type === 'tool_use'
  );
  return !hasToolUse; // tool_useが無ければ完了
}
```

#### 強制終了条件
2. **最大反復回数超過**: シナリオあたりの最大イテレーション数（デフォルト: 30回）を超えた場合、タイムアウトとして失敗判定
   - 設定で変更可能（10〜100回の範囲）
   - 超過時はユーザーに警告を表示し、次のシナリオへ進む

3. **無限ループ検出**: 直近N回のアクション履歴から同一パターンを検出した場合、スタックとして失敗判定
   - アクションの種類（click, type等）と座標/テキストのハッシュで比較
   - 検出時は現在のシナリオを失敗としてマークし、次へ進む

```typescript
// 設定可能なパラメータ
interface AgentLoopConfig {
  maxIterationsPerScenario: number; // デフォルト: 30
  loopDetectionWindow: number;       // デフォルト: 5（直近N回のアクション履歴を保持）
  loopDetectionThreshold: number;    // デフォルト: 3（loopDetectionWindow内で同一アクションがN回以上あれば検出）
}

// 無限ループ検出の判定ロジック例
function detectLoop(actionHistory: ActionRecord[], config: AgentLoopConfig): boolean {
  const recentActions = actionHistory.slice(-config.loopDetectionWindow);
  const actionHashes = recentActions.map(a => hashAction(a));
  const mostFrequent = getMostFrequentItem(actionHashes);
  return mostFrequent.count >= config.loopDetectionThreshold;
}
```

---

## 3. 影響範囲（作成・変更が必要なファイル）

### 3.1 プロジェクト構造（新規作成）

```
xenotester/
├── package.json                    # フロントエンド依存関係
├── tsconfig.json                   # TypeScript設定
├── vite.config.ts                  # Viteビルド設定
├── index.html                      # エントリーHTML
├── .env.example                    # 環境変数サンプル（APIキー）
├── src/                            # フロントエンド (TypeScript)
│   ├── main.ts                     # エントリーポイント
│   ├── App.vue                     # メインコンポーネント（またはApp.tsx）
│   ├── components/
│   │   ├── ScenarioInput.vue       # シナリオ入力UI
│   │   ├── ExecutionLog.vue        # 実行ログ表示
│   │   ├── ResultViewer.vue        # 結果表示
│   │   ├── SettingsPanel.vue       # 設定パネル
│   │   └── WindowSelector.vue      # キャプチャ対象ウィンドウ選択
│   ├── services/
│   │   ├── claudeClient.ts         # Anthropic API クライアント
│   │   ├── agentLoop.ts            # エージェントループ管理
│   │   ├── scenarioParser.ts       # シナリオ分割ロジック
│   │   └── historyManager.ts       # 会話履歴管理（トークン最適化）
│   ├── types/
│   │   ├── scenario.ts             # シナリオ型定義
│   │   ├── action.ts               # アクション型定義
│   │   ├── claudeResponse.ts       # Claude API レスポンス型
│   │   └── window.ts               # キャプチャ対象ウィンドウ情報型
│   └── utils/
│       ├── coordinateScaler.ts     # 座標スケーリング
│       └── loopDetector.ts         # 無限ループ検出
├── src-tauri/                      # バックエンド (Rust)
│   ├── Cargo.toml                  # Rust依存関係
│   ├── tauri.conf.json             # Tauri設定
│   ├── capabilities/
│   │   └── default.json            # 権限設定
│   ├── src/
│   │   ├── main.rs                 # Windowsエントリー
│   │   ├── lib.rs                  # メインライブラリ
│   │   ├── commands/
│   │   │   ├── mod.rs              # コマンドモジュール
│   │   │   ├── screenshot.rs       # スクリーンショットコマンド
│   │   │   ├── input.rs            # 入力操作コマンド
│   │   │   ├── permission.rs       # 権限管理コマンド
│   │   │   ├── control.rs          # 制御コマンド（停止/クリア）
│   │   │   └── config.rs           # 設定コマンド（APIキー取得）
│   │   ├── services/
│   │   │   ├── mod.rs
│   │   │   ├── capture.rs          # xcap画面キャプチャ
│   │   │   ├── mouse.rs            # マウス操作（enigo）
│   │   │   ├── keyboard.rs         # キーボード操作（enigo）
│   │   │   ├── image_processor.rs  # 画像リサイズ・圧縮
│   │   │   └── template_matcher.rs # テンプレートマッチング（opencv-rust、オプション機能）
│   │   ├── utils/
│   │   │   ├── mod.rs
│   │   │   ├── bezier.rs           # ベジェ曲線マウス移動
│   │   │   └── hotkey.rs           # 緊急停止ホットキー
│   │   ├── state.rs                # アプリ状態管理
│   │   └── error.rs                # カスタムエラー型
│   └── icons/                      # アプリアイコン
└── tests/
    ├── integration/                # 統合テスト
    └── unit/                       # ユニットテスト
```

### 3.2 詳細ファイルリスト

#### 3.2.1 プロジェクト設定ファイル（新規作成）

| ファイル | 説明 | 作成理由 |
|---------|------|---------|
| `package.json` | npm依存関係・スクリプト定義 | フロントエンドビルド・依存管理 |
| `tsconfig.json` | TypeScriptコンパイル設定 | 型チェック・トランスパイル |
| `vite.config.ts` | Viteビルド設定 | 開発サーバー・本番ビルド |
| `index.html` | HTMLエントリー | Viteエントリーポイント |
| `.env.example` | 環境変数サンプル | APIキー設定ガイド |
| `src-tauri/Cargo.toml` | Rust依存関係 | バックエンド依存管理 |
| `src-tauri/tauri.conf.json` | Tauri設定 | アプリ設定・権限 |
| `src-tauri/capabilities/default.json` | Tauri権限 | プラグイン権限設定 |

#### 3.2.2 フロントエンド（TypeScript）

| ファイル | 説明 | 作成理由 |
|---------|------|---------|
| `src/main.ts` | アプリエントリー | Vueマウント・初期化 |
| `src/App.vue` | ルートコンポーネント | 全体レイアウト |
| `src/components/ScenarioInput.vue` | シナリオ入力 | ユーザーがテストシナリオを入力 |
| `src/components/ExecutionLog.vue` | 実行ログ | リアルタイムログ表示 |
| `src/components/ResultViewer.vue` | 結果表示 | テスト結果・スクリーンショット表示 |
| `src/components/SettingsPanel.vue` | 設定 | APIキー・オプション設定 |
| `src/components/WindowSelector.vue` | ウィンドウ選択 | キャプチャ対象ウィンドウの選択UI |
| `src/services/claudeClient.ts` | Claude APIクライアント | Computer Use API呼び出し |
| `src/services/agentLoop.ts` | エージェントループ | メインループ制御 |
| `src/services/scenarioRunner.ts` | シナリオランナー | シナリオキュー管理・オーケストレーション |
| `src/services/scenarioParser.ts` | シナリオパーサー | 複数シナリオ分割 |
| `src/services/historyManager.ts` | 履歴管理 | トークン最適化・履歴パージ |
| `src/types/scenario.ts` | シナリオ型 | TypeScript型定義 |
| `src/types/action.ts` | アクション型 | Claudeアクション型定義 |
| `src/types/claudeResponse.ts` | レスポンス型 | API レスポンス型 |
| `src/types/window.ts` | ウィンドウ型 | キャプチャ対象ウィンドウ情報の型定義 |
| `src/utils/coordinateScaler.ts` | 座標変換 | スクリーン座標スケーリング |
| `src/utils/loopDetector.ts` | ループ検出 | 無限ループ検出アルゴリズム |

#### 3.2.3 バックエンド（Rust）

| ファイル | 説明 | 作成理由 |
|---------|------|---------|
| `src-tauri/src/main.rs` | Windowsエントリー | デスクトップエントリー |
| `src-tauri/src/lib.rs` | メインライブラリ | Tauri初期化・プラグイン登録 |
| `src-tauri/src/commands/mod.rs` | コマンドモジュール | IPCコマンドエクスポート |
| `src-tauri/src/commands/screenshot.rs` | スクリーンショット | 画面キャプチャコマンド（ウィンドウ列挙・選択対応） |
| `src-tauri/src/commands/input.rs` | 入力操作 | マウス・キーボードコマンド |
| `src-tauri/src/commands/permission.rs` | 権限管理 | macOS権限チェック・リクエスト |
| `src-tauri/src/services/capture.rs` | キャプチャサービス | xcapラッパー（全画面/モニター/ウィンドウ指定対応） |
| `src-tauri/src/services/mouse.rs` | マウスサービス | enigoマウス操作 |
| `src-tauri/src/services/keyboard.rs` | キーボードサービス | enigoキーボード操作 |
| `src-tauri/src/services/image_processor.rs` | 画像処理 | リサイズ・圧縮・Base64 |
| `src-tauri/src/services/template_matcher.rs` | テンプレートマッチング | opencv-rustによる画像認識（オプション機能） |
| `src-tauri/src/utils/bezier.rs` | ベジェ曲線 | 人間らしいマウス移動 |
| `src-tauri/src/utils/hotkey.rs` | ホットキー | 緊急停止スイッチ |
| `src-tauri/src/state.rs` | アプリ状態 | 緊急停止フラグ等のグローバル状態管理 |
| `src-tauri/src/commands/control.rs` | 制御コマンド | 停止リクエスト/クリアのIPCコマンド |
| `src-tauri/src/commands/config.rs` | 設定コマンド | APIキー取得（.envから読み込み） |
| `src-tauri/src/error.rs` | エラー型 | カスタムエラー定義 |

---

## 4. 実装ステップ

### Phase 1: プロジェクト基盤構築

#### Step 1.1: Tauri 2.0プロジェクト初期化
```bash
# プロジェクト作成
npm create tauri-app@latest xenotester
# オプション: TypeScript, Vue.js (または React), pnpm

# 依存関係インストール
cd xenotester
pnpm install
```

#### Step 1.2: フロントエンド依存関係追加
```bash
pnpm add @anthropic-ai/sdk
pnpm add -D @types/node
```

#### Step 1.3: Rust依存関係追加（Cargo.toml）
```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-macos-permissions = "2.3"
xcap = "0.8"
enigo = "0.6"
image = "0.25"
base64 = "0.22"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "1"
tokio = { version = "1", features = ["full"] }
global-hotkey = "0.6"

# 認識（補助）- テンプレートマッチング用（オプション機能）
opencv = { version = "0.93", default-features = false, features = ["imgproc", "imgcodecs"], optional = true }

[features]
default = []
template-matching = ["opencv"]  # オプション: テンプレートマッチング機能を有効化
```

**注意**: opencv-rustはOpenCV本体のインストールが必要です。
- macOS: `brew install opencv`
- Windows: vcpkgまたはpre-built binariesを使用
- 初期リリースではオプション機能として、将来的なUI要素検出拡張用に準備

### Phase 2: バックエンド実装（Rust）

#### Step 2.1: 権限管理モジュール
- macOS画面収録権限チェック・リクエスト
- アクセシビリティ権限チェック・リクエスト
- 起動時の権限フロー実装

#### Step 2.2: スクリーンショットモジュール

**【重要】キャプチャ方式の使い分け**:
- **Computer Use API送信用**: 必ず**全画面キャプチャ**を使用（固定）
  - Claudeが画面全体のコンテキストを把握するために必須
  - モニター指定は可能だが、基本はプライマリモニター全体
- **デバッグ・補助用途**: ウィンドウ指定キャプチャ（オプション機能）
  - 開発時のデバッグやログ記録用
  - ユーザーへの操作対象確認表示用
  - **Computer Use APIへの送信には使用しない**

**実装内容**:
- xcapによる全画面キャプチャ（`Monitor::all()` → `capture_image()`）
- 特定モニター指定対応（マルチモニター環境用）
- **【補助機能】ウィンドウ指定キャプチャ**:
  - `Window::all()`でシステム上の全ウィンドウを列挙
  - ウィンドウID、タイトル（`window.title()`）、位置・サイズ情報を取得
  - IPC経由でフロントエンドにウィンドウリストを提供
  - ユーザーがUI上でターゲットウィンドウを選択可能
  - 選択されたウィンドウのみをキャプチャ（`window.capture_image()`）
  - **用途**: デバッグログ、操作対象の可視化（APIへは全画面を送信）
- 画像リサイズ（長辺1560px以下。API上限1568pxに対し安全マージンを確保）
- PNG→Base64変換

#### Step 2.3: 入力操作モジュール

**マウス操作**（enigo使用）:
- マウス移動（絶対座標）
- クリック操作（左/右/中央/ダブル/トリプル）
- ドラッグ操作（`left_click_drag`）
- スクロール操作（方向・量指定）

**キーボード操作**（enigo使用）:
- 文字列入力（`type`アクション）
- キーコンビネーション押下（`key`アクション）
- **キー押しっぱなし/解除**（`hold_key`アクション対応）:
  ```rust
  // hold_key ハンドラ
  pub fn hold_key(key: &str, hold: bool) -> Result<(), InputError> {
      let mut enigo = Enigo::new(&Settings::default())?;
      let key_enum = parse_key(key)?;
      if hold {
          enigo.key(key_enum, Direction::Press)?;  // 押しっぱなし
      } else {
          enigo.key(key_enum, Direction::Release)?; // 解除
      }
      Ok(())
  }
  ```

**待機操作**:
- **`wait`アクション対応**: 指定時間の待機
  ```rust
  // wait ハンドラ
  #[tauri::command]
  pub async fn wait(duration_ms: u64) -> Result<(), String> {
      tokio::time::sleep(Duration::from_millis(duration_ms)).await;
      Ok(())
  }
  ```

**スクリーンショットのみ返却**:
- **`screenshot`アクション対応**: 操作なしでスクリーンショットのみ取得
  - Claudeが`screenshot`アクションを返した場合、入力操作は行わずキャプチャのみ実行
  - 結果画像を`tool_result`として返却

#### Step 2.4: ベジェ曲線マウス移動
- 人間らしいカーブでのマウス移動
- 移動速度の自然な変化

#### Step 2.5: 緊急停止システム（詳細設計）

**要件**: ホットキー押下時にエージェントループとAPI呼び出しを即座にキャンセルし、フロントエンドに停止を通知する。

##### 5.2.5.1 停止フラグ（Rust側）

```rust
// src-tauri/src/state.rs
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use global_hotkey::GlobalHotKeyManager;
use std::sync::Mutex;

#[derive(Clone)]
pub struct AppState {
    pub stop_requested: Arc<AtomicBool>,
    // **重要**: GlobalHotKeyManagerをAppStateで保持しないとdropされてホットキーが無効になる
    pub hotkey_manager: Arc<Mutex<Option<GlobalHotKeyManager>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            stop_requested: Arc::new(AtomicBool::new(false)),
            hotkey_manager: Arc::new(Mutex::new(None)),
        }
    }

    pub fn set_hotkey_manager(&self, manager: GlobalHotKeyManager) {
        let mut guard = self.hotkey_manager.lock().unwrap();
        *guard = Some(manager);
    }

    pub fn request_stop(&self) {
        self.stop_requested.store(true, Ordering::SeqCst);
    }

    pub fn clear_stop(&self) {
        self.stop_requested.store(false, Ordering::SeqCst);
    }

    pub fn is_stop_requested(&self) -> bool {
        self.stop_requested.load(Ordering::SeqCst)
    }
}
```

##### 5.2.5.2 ホットキー登録とIPCイベント発火

```rust
// src-tauri/src/utils/hotkey.rs
use global_hotkey::{GlobalHotKeyManager, HotKeyState, hotkey::{HotKey, Modifiers, Code}};
use tauri::{AppHandle, Manager};
use crate::state::AppState;

pub fn register_emergency_stop(app_handle: AppHandle) {
    let manager = GlobalHotKeyManager::new().expect("Failed to create hotkey manager");

    // Shift + Escape を緊急停止キーに設定
    let hotkey = HotKey::new(Some(Modifiers::SHIFT), Code::Escape);
    manager.register(hotkey).expect("Failed to register hotkey");

    // **重要**: GlobalHotKeyManagerをAppStateに保存してdropを防ぐ
    let state = app_handle.state::<AppState>();
    state.set_hotkey_manager(manager);

    // ホットキーイベントリスナー
    let app_handle_clone = app_handle.clone();
    std::thread::spawn(move || {
        loop {
            if let Ok(event) = global_hotkey::GlobalHotKeyEvent::receiver().recv() {
                if event.state == HotKeyState::Pressed {
                    // 停止フラグをセット
                    let state = app_handle_clone.state::<AppState>();
                    state.request_stop();

                    // フロントエンドにイベントを発火
                    app_handle_clone.emit("emergency-stop", ()).ok();

                    println!("[Emergency Stop] Hotkey triggered, stop requested");
                }
            }
        }
    });
}
```

##### 5.2.5.3 IPCコマンド（停止リクエスト/クリア）

```rust
// src-tauri/src/commands/control.rs
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub fn request_stop(state: State<AppState>) {
    state.request_stop();
}

#[tauri::command]
pub fn clear_stop(state: State<AppState>) {
    state.clear_stop();
}

#[tauri::command]
pub fn is_stop_requested(state: State<AppState>) -> bool {
    state.is_stop_requested()
}
```

##### 5.2.5.4 フロントエンド側：AbortController連携

**【重要】エージェントループの統一設計方針**

本システムでは、エージェントループを以下の2層構造で統一します：

1. **ScenarioRunner** (src/services/scenarioRunner.ts): シナリオキュー管理・オーケストレーション
2. **AgentLoop** (src/services/agentLoop.ts): 単一シナリオの実行、`tool_use`→`tool_result`のフロー管理

緊急停止はこの統一設計に組み込まれており、詳細は「Step 3.3 シナリオランナー＆エージェントループ」を参照してください。

```typescript
// 緊急停止イベントの受信 (ScenarioRunnerで処理)
// src/services/scenarioRunner.ts 参照
listen('emergency-stop', () => {
  scenarioRunner.stop('stopped');
});
```

**AbortSignalとPromise.raceによるAPI呼び出しキャンセル**

```typescript
// AgentLoop内でのClaude API呼び出し（キャンセル対応）
private async callClaudeAPI(): Promise<BetaMessage | null> {
  try {
    const client = await getClaudeClient();

    // 注意: Anthropic SDKのbeta.messages.createはAbortSignalを直接サポートしていない
    // そのため、Promise.race でタイムアウトとキャンセルを実装
    //
    // 【限界】Promise.raceは「論理的キャンセル」であり、SDK内部のHTTPリクエストは
    // 実際にはキャンセルされず、レスポンスが返るまでバックグラウンドで継続する。
    // 真の即時キャンセルが必要な場合は、Rust側でAPI呼び出しを行い、
    // reqwestのAbort機能を使用する方式を検討すること。

    const apiPromise = client.beta.messages.create({
      model: "claude-opus-4-5-20251101",
      max_tokens: 4096,
      tools: [this.buildComputerTool()],
      messages: this.messages,
      betas: ["computer-use-2025-11-24"]
    });

    const abortPromise = new Promise<never>((_, reject) => {
      this.options.abortSignal.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });

    // 論理的キャンセル: abortPromiseが先にrejectすればループは終了するが、
    // apiPromiseのHTTP通信自体はバックグラウンドで完了まで継続する
    return await Promise.race([apiPromise, abortPromise]);

  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.log('[Agent Loop] API call aborted');
      return null;
    }
    throw error;
  }
}
```

##### 5.2.5.5 緊急停止フロー図

```
┌─────────────────────────────────────────────────────────────────────┐
│  ユーザーが Shift+Esc を押下                                          │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Rust: global-hotkey がイベント検出                                   │
│    1. stop_requested = true (AtomicBool)                             │
│    2. app_handle.emit("emergency-stop", ())                          │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
┌─────────────────────────────────┐ ┌─────────────────────────────────┐
│  フロントエンド:                 │ │  フロントエンド:                 │
│  listen('emergency-stop')        │ │  各イテレーションで              │
│    → scenarioRunner.stop()       │ │  is_stop_requested() 確認       │
│    → abortController.abort()     │ │    → true ならループ中断        │
└─────────────────────────────────┘ └─────────────────────────────────┘
                    │                               │
                    └───────────────┬───────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  API呼び出し中断 (AbortError)                                         │
│  ループ終了                                                          │
│  UI更新（停止状態表示）                                               │
└─────────────────────────────────────────────────────────────────────┘
```

##### 5.2.5.6 グローバルホットキー登録

- Shift+Esc で全操作強制終了
- `global-hotkey` crateでグローバル登録

#### Step 2.6: テンプレートマッチングモジュール（オプション機能）
- **用途**: 将来的なUI要素検出の拡張用（初期リリースでは無効化可能）
- **依存**: opencv-rust (feature flag: `template-matching`)
- **機能**:
  - スクリーンショット内からテンプレート画像を検索
  - マッチ位置の座標を返却
  - マッチ信頼度のしきい値設定
- **実装内容**:
  ```rust
  #[cfg(feature = "template-matching")]
  pub fn find_template(
      screenshot: &DynamicImage,
      template: &DynamicImage,
      threshold: f64,
  ) -> Option<(i32, i32, f64)> {
      // opencv::imgproc::match_template を使用
      // マッチ位置 (x, y) と信頼度を返却
  }
  ```
- **注意**: OpenCV本体のインストールが必要なため、オプション機能として提供

### Phase 3: フロントエンド実装（TypeScript）

#### Step 3.1: シナリオパーサー
- Claude Opus 4.5を使用したシナリオ分割
- 複数シナリオの検出・分離

**出力スキーマ（JSON配列形式）**:
```typescript
// シナリオ分割リクエストのシステムプロンプト
const SCENARIO_SPLIT_PROMPT = `
あなたはテストシナリオを分析し、個別のシナリオに分割するアシスタントです。
ユーザーが入力したテキストを分析し、以下のJSON形式で応答してください。

出力形式:
{
  "scenarios": [
    {
      "id": 1,
      "title": "シナリオのタイトル（短い説明）",
      "description": "シナリオの詳細な指示内容"
    }
  ],
  "analysis": {
    "total_count": シナリオ数,
    "is_single": 単一シナリオかどうか（boolean）
  }
}

ルール:
1. 複数のテストケースが含まれる場合は分割する
2. 単一のシナリオの場合は1つの要素を持つ配列として返す
3. 必ず有効なJSONのみを出力する（説明文は不要）
`;

// シナリオ分割の型定義
interface ScenarioSplitResult {
  scenarios: Array<{
    id: number;
    title: string;
    description: string;
  }>;
  analysis: {
    total_count: number;
    is_single: boolean;
  };
}
```

**フォールバック処理**:
```typescript
async function parseScenarios(userInput: string): Promise<Scenario[]> {
  try {
    const response = await claudeClient.messages.create({
      model: "claude-opus-4-5-20251101",
      max_tokens: 1024,
      system: SCENARIO_SPLIT_PROMPT,
      messages: [{ role: "user", content: userInput }]
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type');
    }

    const result: ScenarioSplitResult = JSON.parse(content.text);
    return result.scenarios.map(s => ({
      id: s.id,
      title: s.title,
      description: s.description,
      status: 'pending' as const
    }));

  } catch (error) {
    // フォールバック: 分割失敗時は入力全体を単一シナリオとして扱う
    console.warn('Scenario split failed, treating as single scenario:', error);
    return [{
      id: 1,
      title: 'テストシナリオ',
      description: userInput,  // 元の入力をそのまま使用
      status: 'pending'
    }];
  }
}
```

**失敗時の挙動**:
1. JSONパースエラー → 単一シナリオとして続行
2. API呼び出しエラー → 単一シナリオとして続行
3. 空の配列が返された → 単一シナリオとして続行
4. ユーザーに警告メッセージを表示（「シナリオ分割に失敗しました。入力全体を1つのシナリオとして実行します。」）

#### Step 3.2: Claude APIクライアント
- Anthropic SDK初期化
- Computer Use Beta API呼び出し
- tool_use/tool_resultハンドリング

#### Step 3.3: シナリオランナー＆エージェントループ（詳細設計）

##### 3.3.1 シナリオの状態定義

```typescript
// src/types/scenario.ts

type ScenarioStatus =
  | 'pending'      // 実行待ち
  | 'running'      // 実行中
  | 'completed'    // 正常完了
  | 'failed'       // 失敗（無限ループ検出、エラー等）
  | 'stopped'      // ユーザーによる停止
  | 'skipped';     // スキップ（前シナリオ失敗時など）

interface Scenario {
  id: number;
  title: string;
  description: string;
  status: ScenarioStatus;
  error?: string;           // 失敗時のエラーメッセージ
  iterations?: number;      // 実行したイテレーション数
  startedAt?: Date;
  completedAt?: Date;
}

interface ScenarioRunnerState {
  scenarios: Scenario[];
  currentIndex: number;           // 現在実行中のシナリオインデックス
  isRunning: boolean;
  stopOnFailure: boolean;         // 失敗時に以降のシナリオを停止するか（設定可能）
}
```

##### 3.3.2 シナリオランナー（オーケストレーション）

```typescript
// src/services/scenarioRunner.ts

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

class ScenarioRunner {
  private state: ScenarioRunnerState = {
    scenarios: [],
    currentIndex: -1,
    isRunning: false,
    stopOnFailure: false,  // デフォルト: 失敗しても次のシナリオに進む
  };

  private abortController: AbortController | null = null;
  private onStateChange?: (state: ScenarioRunnerState) => void;

  constructor() {
    // 緊急停止イベントをリッスン
    listen('emergency-stop', () => {
      this.stop('stopped');
    });
  }

  /**
   * シナリオキューを設定して実行開始
   */
  async run(
    scenarios: Scenario[],
    options: { stopOnFailure?: boolean; onStateChange?: (state: ScenarioRunnerState) => void }
  ): Promise<ScenarioRunnerState> {
    // 初期化
    this.state = {
      scenarios: scenarios.map(s => ({ ...s, status: 'pending' })),
      currentIndex: 0,
      isRunning: true,
      stopOnFailure: options.stopOnFailure ?? false,
    };
    this.onStateChange = options.onStateChange;
    this.abortController = new AbortController();
    await invoke('clear_stop');

    this.notifyStateChange();

    // シナリオを順番に実行
    for (let i = 0; i < this.state.scenarios.length; i++) {
      if (!this.state.isRunning) break;

      this.state.currentIndex = i;
      const scenario = this.state.scenarios[i];

      // スキップ判定（前シナリオが失敗 & stopOnFailure）
      if (i > 0 && this.state.stopOnFailure) {
        const prevScenario = this.state.scenarios[i - 1];
        if (prevScenario.status === 'failed') {
          scenario.status = 'skipped';
          this.notifyStateChange();
          continue;
        }
      }

      // シナリオ実行
      await this.executeScenario(scenario);
    }

    this.state.isRunning = false;
    this.notifyStateChange();

    return this.state;
  }

  /**
   * 単一シナリオの実行
   */
  private async executeScenario(scenario: Scenario): Promise<void> {
    scenario.status = 'running';
    scenario.startedAt = new Date();
    scenario.iterations = 0;
    this.notifyStateChange();

    // **重要**: 各シナリオ開始時にmessages配列を初期化
    const agentLoop = new AgentLoop({
      scenario,
      abortSignal: this.abortController!.signal,
      onIteration: (iteration) => {
        scenario.iterations = iteration;
        this.notifyStateChange();
      },
    });

    try {
      const result = await agentLoop.run();

      scenario.status = result.success ? 'completed' : 'failed';
      scenario.error = result.error;
      scenario.completedAt = new Date();

    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        scenario.status = 'stopped';
      } else {
        scenario.status = 'failed';
        scenario.error = error instanceof Error ? error.message : String(error);
      }
      scenario.completedAt = new Date();
    }

    this.notifyStateChange();
  }

  /**
   * 実行停止
   */
  stop(finalStatus: 'stopped' | 'failed' = 'stopped'): void {
    this.state.isRunning = false;
    if (this.abortController) {
      this.abortController.abort();
    }

    // 現在実行中のシナリオのステータスを更新
    const current = this.state.scenarios[this.state.currentIndex];
    if (current && current.status === 'running') {
      current.status = finalStatus;
      current.completedAt = new Date();
    }

    // 未実行のシナリオをスキップ
    for (let i = this.state.currentIndex + 1; i < this.state.scenarios.length; i++) {
      if (this.state.scenarios[i].status === 'pending') {
        this.state.scenarios[i].status = 'skipped';
      }
    }

    this.notifyStateChange();
  }

  private notifyStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange({ ...this.state });
    }
  }
}

export const scenarioRunner = new ScenarioRunner();
```

##### 3.3.3 エージェントループ（単一シナリオ実行）

```typescript
// src/services/agentLoop.ts

interface AgentLoopOptions {
  scenario: Scenario;
  abortSignal: AbortSignal;
  onIteration?: (iteration: number) => void;
}

interface AgentLoopResult {
  success: boolean;
  error?: string;
}

/**
 * 無限ループ検出用のアクション履歴レコード
 */
interface ActionRecord {
  hash: string;           // アクションのハッシュ値（種類+座標/テキストから生成）
  toolUseId: string;      // 対応するtool_use ID
  action: ComputerAction; // アクションの詳細
  timestamp: number;      // 実行時刻（ミリ秒）
}

class AgentLoop {
  private messages: BetaMessageParam[] = [];  // ← シナリオごとに新規作成
  private actionHistory: ActionRecord[] = [];
  private captureResult: CaptureResult | null = null;
  private config: AgentLoopConfig;

  constructor(private options: AgentLoopOptions) {
    this.config = {
      maxIterationsPerScenario: 30,
      loopDetectionWindow: 5,
      loopDetectionThreshold: 3,
    };
  }

  async run(): Promise<AgentLoopResult> {
    let iteration = 0;

    // 初回スクリーンショット取得
    this.captureResult = await this.captureScreen();

    // 初回メッセージ設定（シナリオ説明 + スクリーンショット）
    this.messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: this.options.scenario.description },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: this.captureResult.imageBase64,
            },
          },
        ],
      },
    ];

    while (iteration < this.config.maxIterationsPerScenario) {
      // 停止チェック
      if (this.options.abortSignal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      const stopRequested = await invoke<boolean>('is_stop_requested');
      if (stopRequested) {
        throw new DOMException('Aborted', 'AbortError');
      }

      this.options.onIteration?.(iteration + 1);

      // Claude API呼び出し
      const response = await this.callClaudeAPI();

      // 完了判定
      if (this.isScenarioComplete(response)) {
        return { success: true };
      }

      // tool_use抽出・実行
      const toolUseBlocks = response.content.filter(
        (block): block is BetaToolUseBlock => block.type === 'tool_use'
      );

      // **重要**: assistantメッセージは1回だけ追加し、tool_resultを複数追加する
      // （ループ内で毎回追加するとassistantメッセージが重複してAPI呼び出しが失敗する）
      this.messages.push({
        role: 'assistant',
        content: response.content,
      });

      // 各tool_useに対してアクション実行 → tool_result追加
      const toolResults: BetaToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        // **【重要】各アクション実行前に停止チェック**
        // 1レスポンスに複数tool_useがある場合でも、即座に中断可能
        if (this.options.abortSignal.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        const stopRequested = await invoke<boolean>('is_stop_requested');
        if (stopRequested) {
          throw new DOMException('Aborted', 'AbortError');
        }

        // 無限ループ検出
        if (this.detectLoop(toolUse)) {
          return {
            success: false,
            error: `無限ループを検出しました: 同じアクションが${this.config.loopDetectionThreshold}回繰り返されています`,
          };
        }

        // アクション実行
        await this.executeAction(toolUse);

        // **【重要】アクション実行後に履歴へ追加（無限ループ検出用）**
        this.actionHistory.push({
          hash: this.hashAction(toolUse),
          toolUseId: toolUse.id,
          action: toolUse.input as ComputerAction,
          timestamp: Date.now(),
        });

        // 実行後スクリーンショット
        this.captureResult = await this.captureScreen();

        // tool_resultを収集
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: [
            { type: 'text', text: 'Action executed successfully' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: this.captureResult.imageBase64,
              },
            },
          ],
        });
      }

      // 全てのtool_resultをまとめてuserメッセージとして追加
      this.messages.push({
        role: 'user',
        content: toolResults,
      });

      // 履歴パージ（20ターン超過時）
      if (this.messages.length > 40) {
        this.messages = purgeOldImages(this.messages, 20);
      }

      iteration++;
    }

    return {
      success: false,
      error: `最大イテレーション数（${this.config.maxIterationsPerScenario}回）に達しました`,
    };
  }

  /**
   * アクションをハッシュ化（無限ループ検出用）
   * - アクションの種類（type/action）と主要パラメータ（座標/テキスト）からハッシュを生成
   */
  private hashAction(toolUse: BetaToolUseBlock): string {
    const input = toolUse.input as ComputerAction;
    // アクション種類 + 座標またはテキストを結合してハッシュ化
    const key = [
      input.action,
      input.coordinate?.join(',') ?? '',
      input.text ?? '',
      input.start_coordinate?.join(',') ?? '',
    ].join('|');

    // 簡易ハッシュ（本番ではcrypto.subtle.digest等を使用推奨）
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // 32bit整数に変換
    }
    return hash.toString(16);
  }

  /**
   * 無限ループ検出
   * - 直近N回のアクション履歴から同一パターンを検出
   */
  private detectLoop(toolUse: BetaToolUseBlock): boolean {
    const currentHash = this.hashAction(toolUse);
    const recentHashes = this.actionHistory
      .slice(-this.config.loopDetectionWindow)
      .map(r => r.hash);

    // 同一ハッシュの出現回数をカウント
    const sameHashCount = recentHashes.filter(h => h === currentHash).length;

    // 閾値以上なら無限ループと判定
    return sameHashCount >= this.config.loopDetectionThreshold;
  }

  // ... その他のメソッド（captureScreen, callClaudeAPI, executeAction等）
}
```

##### 3.3.4 messages配列の初期化/継続ポリシー

| ポリシー | 説明 | 採用 |
|---------|------|-----|
| **リセット（採用）** | 各シナリオ開始時に`messages = []`で初期化。シナリオは独立したテストケースとして扱う | ○ |
| 継続 | 前シナリオの`messages`を引き継ぐ。文脈を維持するが、トークン消費が増大 | - |

**理由**: テストシナリオは独立して実行されるべきであり、前シナリオの操作が次シナリオに影響を与えることを避けるため。

##### 3.3.5 シナリオ遷移フロー図

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ScenarioRunner.run(scenarios)                                           │
└─────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  for each scenario in scenarios                                          │
│    ┌──────────────────────────────────────────────────────────────────┐  │
│    │  前シナリオ失敗 && stopOnFailure ?                                │  │
│    │    → YES: status = 'skipped', continue                           │  │
│    │    → NO:  executeScenario(scenario)                              │  │
│    └──────────────────────────────────────────────────────────────────┘  │
│              │                                                           │
│              ▼                                                           │
│    ┌──────────────────────────────────────────────────────────────────┐  │
│    │  AgentLoop（messages = [] で初期化）                              │  │
│    │    while (iteration < max)                                        │  │
│    │      ├─ 停止チェック → abort                                     │  │
│    │      ├─ Claude API呼び出し                                       │  │
│    │      ├─ tool_use無し → 'completed'                               │  │
│    │      ├─ 無限ループ検出 → 'failed'                                │  │
│    │      ├─ アクション実行                                           │  │
│    │      └─ スクリーンショット → tool_result追加                     │  │
│    │    end while                                                       │  │
│    │    max到達 → 'failed'（タイムアウト）                             │  │
│    └──────────────────────────────────────────────────────────────────┘  │
│              │                                                           │
│              ▼                                                           │
│    ┌──────────────────────────────────────────────────────────────────┐  │
│    │  scenario.status 更新                                             │  │
│    │    'completed' | 'failed' | 'stopped'                             │  │
│    └──────────────────────────────────────────────────────────────────┘  │
│              │                                                           │
│              ▼                                                           │
│         次のシナリオへ                                                   │
└─────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  全シナリオ完了                                                          │
│  → ScenarioRunnerState を返却                                            │
│  → UI で結果サマリー表示                                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

#### Step 3.4: 履歴管理
- Messages配列の管理
- 20ターン超過時の画像パージ
- テキストログ保持

#### Step 3.5: 無限ループ検出
- 同一アクション繰り返し検出
- スタック判定・失敗報告

#### Step 3.6: 座標スケーリング
- スクリーン座標とAPI座標の変換
- 高解像度ディスプレイ対応

### Phase 4: UI実装

#### Step 4.1: シナリオ入力画面
- テキストエリアでのシナリオ入力
- 実行ボタン

#### Step 4.2: 実行ログ画面
- リアルタイムログストリーム
- アクション履歴表示
- スクリーンショットサムネイル

#### Step 4.3: 結果画面
- シナリオ別の結果表示
- 成功/失敗ステータス
- スクリーンショット履歴

### Phase 5: 統合・テスト

#### Step 5.1: 統合テスト
- E2Eテストシナリオ作成
- クロスプラットフォームテスト

#### Step 5.2: パフォーマンス最適化
- 画像圧縮最適化
- API呼び出し効率化

---

## 5. 技術的考慮事項

### 5.1 Claude Computer Use API仕様

#### Beta Header
- Claude Opus 4.5: `"computer-use-2025-11-24"`
- その他モデル: `"computer-use-2025-01-24"`

#### Tool Version
- Claude Opus 4.5: `computer_20251124`
- その他モデル: `computer_20250124`

#### 利用可能なアクション

| アクション | 説明 | パラメータ | 備考 |
|-----------|------|-----------|------|
| `screenshot` | スクリーンショット取得 | なし | |
| `left_click` | 左クリック | `coordinate: [x, y]` | |
| `right_click` | 右クリック | `coordinate: [x, y]` | |
| `middle_click` | 中央クリック | `coordinate: [x, y]` | |
| `double_click` | ダブルクリック | `coordinate: [x, y]` | |
| `triple_click` | トリプルクリック | `coordinate: [x, y]` | |
| `mouse_move` | マウス移動 | `coordinate: [x, y]` | |
| `left_click_drag` | ドラッグ | `start_coordinate, coordinate` | |
| `left_mouse_down` | 左ボタン押下（保持） | `coordinate: [x, y]` | |
| `left_mouse_up` | 左ボタン解放 | `coordinate: [x, y]` | |
| `type` | 文字入力 | `text: string` | |
| `key` | キー押下 | `text: string` (例: "ctrl+s") | |
| `scroll` | スクロール | `coordinate, scroll_direction, scroll_amount` | |
| `wait` | 待機 | なし | |
| `hold_key` | キー押しっぱなし/解除 | キー名 | |
| `zoom` | 画面領域の詳細表示 | `region: [x1, y1, x2, y2]` | Opus 4.5専用。`enable_zoom: true` 必要 |

**注意**: `zoom`アクションはClaude Opus 4.5専用の機能です。使用する場合はツール定義に`enable_zoom: true`を追加する必要があります。

#### APIリクエスト例

**重要**: `display_width_px`/`display_height_px`には、リサイズ後の画像サイズを設定する（実画面サイズではない）。
詳細は「5.2 画像サイズ制約と座標変換」を参照。

```typescript
// captureResult はRust側で取得・リサイズした結果
const captureResult = await invoke<CaptureResult>('capture_and_resize');

const response = await client.beta.messages.create({
  model: "claude-opus-4-5-20251101",
  max_tokens: 4096,
  tools: [
    {
      type: "computer_20251124",
      name: "computer",
      display_width_px: captureResult.resizedWidth,   // 例: 1560
      display_height_px: captureResult.resizedHeight, // 例: 878
      display_number: 1,
    }
  ],
  messages: messages,
  betas: ["computer-use-2025-11-24"]
});

// Claudeが返す座標は縮小画像上の座標。実画面座標への変換が必要:
// screenX = claudeX / captureResult.scaleFactor
```

### 5.2 画像サイズ制約と座標変換

#### API制約
- 最大長辺: 1568px
- 最大総ピクセル: 約1.15メガピクセル

#### display_width_px / display_height_px の設定ルール

**【重要】縮小後のサイズを設定する**

Computer Use APIの`display_width_px`/`display_height_px`には、**縮小後の画像サイズ**を設定する。
Claudeはこのサイズを前提に座標を返すため、実画面サイズではなく送信画像のサイズを設定する必要がある。

```typescript
// 画面キャプチャとリサイズの流れ
interface CaptureResult {
  originalWidth: number;     // 元の画面サイズ（例: 2560）
  originalHeight: number;    // 元の画面サイズ（例: 1440）
  resizedWidth: number;      // 縮小後サイズ（例: 1560）
  resizedHeight: number;     // 縮小後サイズ（例: 878）
  scaleFactor: number;       // スケール係数（例: 0.609375）
  imageBase64: string;       // 縮小後画像のBase64
}

// display_* には縮小後のサイズを設定
function buildComputerTool(captureResult: CaptureResult, enableZoom: boolean = false): BetaComputerTool {
  return {
    type: "computer_20251124",
    name: "computer",
    display_width_px: captureResult.resizedWidth,   // ← 縮小後の幅
    display_height_px: captureResult.resizedHeight, // ← 縮小後の高さ
    display_number: 1,
    enable_zoom: enableZoom,  // Opus 4.5専用: zoomアクションを有効化する場合はtrue
  };
}
```

#### スケーリング計算（Rust側実装）

```rust
// src-tauri/src/services/image_processor.rs

const MAX_LONG_EDGE: u32 = 1560;  // API上限1568pxに対し安全マージン
const MAX_TOTAL_PIXELS: u32 = 1_150_000;

// **重要**: TypeScript側はcamelCaseを期待するため、serde rename_allを設定
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeResult {
    pub original_width: u32,
    pub original_height: u32,
    pub resized_width: u32,
    pub resized_height: u32,
    pub scale_factor: f64,
    pub image_base64: String,
}
// シリアライズ後: { "originalWidth": 2560, "resizedWidth": 1560, "scaleFactor": 0.609, ... }

pub fn resize_screenshot(image: DynamicImage) -> ResizeResult {
    let original_width = image.width();
    let original_height = image.height();

    let long_edge = original_width.max(original_height);
    let total_pixels = original_width * original_height;

    let long_edge_scale = MAX_LONG_EDGE as f64 / long_edge as f64;
    let total_pixels_scale = (MAX_TOTAL_PIXELS as f64 / total_pixels as f64).sqrt();

    let scale_factor = long_edge_scale.min(total_pixels_scale).min(1.0);

    let resized_width = (original_width as f64 * scale_factor).round() as u32;
    let resized_height = (original_height as f64 * scale_factor).round() as u32;

    let resized_image = image.resize_exact(
        resized_width,
        resized_height,
        image::imageops::FilterType::Lanczos3,
    );

    let mut buffer = Vec::new();
    resized_image
        .write_to(&mut Cursor::new(&mut buffer), image::ImageFormat::Png)
        .expect("Failed to encode image");

    ResizeResult {
        original_width,
        original_height,
        resized_width,
        resized_height,
        scale_factor,
        image_base64: base64::engine::general_purpose::STANDARD.encode(&buffer),
    }
}
```

#### 座標逆変換（縮小画像座標 → 実画面座標）

Claudeが返す座標は縮小後画像上の座標。実際のクリック位置を得るには`scale_factor`で逆変換する。

```typescript
// src/utils/coordinateScaler.ts

interface Coordinate {
  x: number;
  y: number;
}

/**
 * Claude座標（縮小画像上）を実画面座標に変換
 * @param claudeCoord Claudeが返した座標（縮小画像上）
 * @param scaleFactor 縮小時に使用したスケール係数
 * @returns 実画面上の座標
 */
export function toScreenCoordinate(
  claudeCoord: Coordinate,
  scaleFactor: number
): Coordinate {
  return {
    x: Math.round(claudeCoord.x / scaleFactor),
    y: Math.round(claudeCoord.y / scaleFactor),
  };
}

// 使用例
const claudeAction = { type: 'left_click', coordinate: [780, 439] };
const screenCoord = toScreenCoordinate(
  { x: claudeAction.coordinate[0], y: claudeAction.coordinate[1] },
  captureResult.scaleFactor  // 例: 0.609375
);
// → { x: 1280, y: 720 } 実画面座標

await invoke('perform_click', { x: screenCoord.x, y: screenCoord.y });
```

#### 座標変換フロー図

```
┌───────────────────────────────────────────────────────────────────┐
│  実画面（例: 2560 x 1440）                                         │
│    ┌─────────────────────────────────┐                            │
│    │                                 │ キャプチャ                  │
│    │         実画面座標              │─────────┐                  │
│    │       (1280, 720)               │         │                  │
│    └─────────────────────────────────┘         │                  │
└────────────────────────────────────────────────│──────────────────┘
                                                 ▼
┌───────────────────────────────────────────────────────────────────┐
│  画像リサイズ（scale_factor = 0.609375）                           │
│    2560 * 0.609375 = 1560                                         │
│    1440 * 0.609375 = 878                                          │
└───────────────────────────────────────────────────────────────────┘
                                                 │
                                                 ▼
┌───────────────────────────────────────────────────────────────────┐
│  縮小画像（1560 x 878）→ Claude API送信                           │
│    display_width_px: 1560                                         │
│    display_height_px: 878                                         │
│    ┌─────────────────────────────────┐                            │
│    │       Claude座標                │                            │
│    │       (780, 439)                │ ← Claudeはこの座標を返す    │
│    └─────────────────────────────────┘                            │
└───────────────────────────────────────────────────────────────────┘
                                                 │
                                                 ▼ 逆変換
┌───────────────────────────────────────────────────────────────────┐
│  実画面座標への変換                                                │
│    780 / 0.609375 = 1280                                          │
│    439 / 0.609375 = 720                                           │
│    → enigo で (1280, 720) をクリック                               │
└───────────────────────────────────────────────────────────────────┘
```

### 5.3 パフォーマンス最適化

#### 画像圧縮戦略
1. 長辺1560pxにリサイズ（API上限1568pxに対し安全マージンを確保）
2. PNG形式で保存（スクリーンショットに適した可逆圧縮）
3. Base64エンコード

#### 履歴パージ戦略

**重要**: `tool_result`の構造は以下の通り。`content`は配列形式で、複数のブロック（text, image）を含む場合がある。
パージ時は`image`ブロック（Base64データ）のみを除外し、`tool_use_id`とテキストブロックは必ず保持する。
**注意**: 画像削除後、Claudeが文脈を維持できるよう代替テキスト（`[screenshot removed to save tokens]`）を追加する。
これはトークン節約が目的であり、画像が存在したという事実をClaudeに伝えるための最小限のプレースホルダーである。

```typescript
// tool_resultの構造例
interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;  // 必須: 対応するtool_useと紐づけるID
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  >;
}

// 20ターン超過時の履歴パージ実装
function purgeOldImages(messages: Message[], keepRecentTurns: number = 20): Message[] {
  const keepFromIndex = messages.length - (keepRecentTurns * 2); // user + assistantで2メッセージ/ターン

  return messages.map((msg, index) => {
    if (index >= keepFromIndex || msg.role !== 'user') {
      return msg; // 直近のメッセージとassistantメッセージはそのまま
    }

    // userメッセージ内のtool_resultを処理
    const purgedContent = msg.content.map(block => {
      if (block.type !== 'tool_result') {
        return block; // tool_result以外はそのまま
      }

      // tool_result.contentから画像ブロックのみ除外、テキストとtool_use_idは保持
      const filteredContent = Array.isArray(block.content)
        ? block.content.filter(item => item.type !== 'image')
        : block.content;

      // 画像が除外された場合、代替テキストを追加
      const hasImageRemoved = Array.isArray(block.content) &&
        block.content.some(item => item.type === 'image');

      return {
        type: 'tool_result' as const,
        tool_use_id: block.tool_use_id, // 必須: IDは必ず保持
        content: hasImageRemoved
          ? [...filteredContent, { type: 'text' as const, text: '[screenshot removed to save tokens]' }]
          : filteredContent,
      };
    });

    return { ...msg, content: purgedContent };
  });
}

// 使用例
if (messages.length > 40) {
  messages = purgeOldImages(messages, 20); // 直近20ターン分は画像を保持
}
```

**パージ後のtool_result構造例**:
```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_abc123",
  "content": [
    { "type": "text", "text": "Screenshot captured successfully" },
    { "type": "text", "text": "[screenshot removed to save tokens]" }
  ]
}
```

### 5.4 Tauri WebViewでのAPI呼び出し制約と対策

#### 問題点

Tauri WebView（ブラウザ環境）から`@anthropic-ai/sdk`で直接Anthropic APIを呼び出す場合、以下の制約がある：

1. **CORS制限**: ブラウザからの直接API呼び出しはCORSポリシーでブロックされる可能性
2. **APIキー露出**: フロントエンドにAPIキーを渡すとDevToolsで確認可能

#### 対策方針（採用: `dangerouslyAllowBrowser` + IPC経由キー取得）

本プロジェクトでは以下の方式を採用する：

1. **APIキーはRust側で管理**: .envからRustが読み込み、IPCで取得
2. **`dangerouslyAllowBrowser: true`を設定**: Anthropic SDKのブラウザ制限を解除

**【注意】CORS動作の検証が必要**:
- `dangerouslyAllowBrowser`はSDKのブラウザ検出警告を抑制するオプションであり、CORS制限を回避するものではない
- Anthropic APIがCORSヘッダ（`Access-Control-Allow-Origin`）を返すかは実環境での検証が必要
- **実装時の検証項目**: Tauri WebView環境で実際にAPI呼び出しを行い、CORSエラーが発生しないことを確認
- CORSエラーが発生する場合は「代替案」の方式B（Rust側API呼び出し）または方式C（plugin-http）に切り替える

```typescript
// src/services/claudeClient.ts
import { invoke } from '@tauri-apps/api/core';
import Anthropic from '@anthropic-ai/sdk';

let anthropicClient: Anthropic | null = null;

export async function getClaudeClient(): Promise<Anthropic> {
  if (anthropicClient) {
    return anthropicClient;
  }

  // Rust側からAPIキーを取得（.envの値がDevToolsに直接表示されない）
  const apiKey = await invoke<string>('get_api_key', { keyName: 'anthropic' });

  anthropicClient = new Anthropic({
    apiKey: apiKey,
    dangerouslyAllowBrowser: true,  // ← ブラウザ環境での使用を許可
  });

  return anthropicClient;
}
```

#### 代替案（将来的な検討）

より高いセキュリティが必要な場合は、以下の方式を検討：

**方式B: Rust側でAPI呼び出し**
- すべてのClaude API呼び出しをRust側で行い、結果のみをIPCで返す
- メリット: APIキーが完全にフロントエンドに渡らない
- デメリット: 実装が複雑、レスポンスストリーミングの扱いが困難

**方式C: `@tauri-apps/plugin-http`使用**
- TauriのネイティブHTTPプラグインでリクエスト
- メリット: CORS制限を回避
- デメリット: Anthropic SDKの型安全性を活用できない

**本プロジェクトでの判断**: デスクトップアプリであり、ユーザー自身のAPIキーを使用する前提のため、`dangerouslyAllowBrowser`方式で十分と判断。

### 5.5 セキュリティ考慮事項

#### 仮想環境推奨
- 本番環境では仮想マシン/コンテナでの実行を推奨
- 機密データへのアクセス制限

#### プロンプトインジェクション対策
- 画面上の指示がClaudeの動作に影響する可能性
- ユーザー確認フローの実装

#### APIキー管理
- `.env`ファイルで管理（.gitignore必須）
- 環境変数経由でのアクセス
- `dangerouslyAllowBrowser`使用時もAPIキーはIPC経由で取得し、ハードコードしない

### 5.6 macOS権限要件

| 権限 | 用途 | チェック関数 |
|-----|------|-------------|
| Screen Recording | スクリーンショット取得 | `checkScreenRecordingPermission()` |
| Accessibility | マウス・キーボード操作 | `checkAccessibilityPermission()` |
| Input Monitoring | キーボード入力監視 | `checkInputMonitoringPermission()` |

---

## 6. テスト計画

### 6.1 ユニットテスト

| 対象 | テスト内容 |
|------|-----------|
| `scenarioParser.ts` | シナリオ分割ロジック |
| `coordinateScaler.ts` | 座標変換精度 |
| `loopDetector.ts` | 無限ループ検出 |
| `historyManager.ts` | 履歴パージロジック |
| `bezier.rs` | ベジェ曲線計算 |
| `image_processor.rs` | 画像リサイズ・圧縮 |
| `template_matcher.rs` | テンプレートマッチング精度（オプション機能有効時） |

### 6.2 統合テスト

| シナリオ | 内容 |
|---------|------|
| 基本クリック | 指定座標へのクリック実行 |
| 文字入力 | テキストフィールドへの入力 |
| スクロール | ページスクロール動作 |
| マルチシナリオ | 複数シナリオの連続実行 |
| 無限ループ検出 | スタック状態の検出・報告 |
| 緊急停止 | Shift+Escでの強制終了 |

### 6.3 クロスプラットフォームテスト

| 項目 | macOS | Windows |
|------|-------|---------|
| スクリーンショット | ○ | ○ |
| マウス操作 | ○ | ○ |
| キーボード操作 | ○ | ○ |
| 権限リクエスト | ○ | N/A |

---

## 7. リスクと対策

### 7.1 技術リスク

| リスク | 影響 | 対策 |
|-------|------|------|
| Claude API レイテンシ | ユーザー体験低下 | 非同期処理・進捗表示 |
| 座標精度誤差 | クリックミス | 座標変換の厳密化・リトライ |
| OS権限拒否 | 機能不全 | 起動時チェック・ガイダンス表示 |
| 無限ループ | リソース消費 | ループ検出・最大イテレーション制限 |
| API変更 | 互換性問題 | Beta APIの変更監視 |

### 7.2 運用リスク

| リスク | 影響 | 対策 |
|-------|------|------|
| APIキー漏洩 | 不正利用 | 環境変数管理・.gitignore |
| 誤操作 | データ損失 | 緊急停止機能・確認ダイアログ |
| プロンプトインジェクション | 予期せぬ動作 | 分類器の活用・ユーザー確認 |

### 7.3 コスト管理

| 項目 | 対策 |
|------|------|
| APIトークン消費 | 画像圧縮・履歴パージ |
| 最大イテレーション | 30回/シナリオの制限設定（設定で10〜100回に変更可能） |
| 開発中のテスト | モック・スタブの活用 |

---

## 8. 調査ログ

### 8.1 実行した検索パターン

#### Glob検索
- `**/*.{ts,tsx,js,jsx}` - TypeScriptファイル（該当なし：新規プロジェクト）
- `**/*.rs` - Rustファイル（該当なし）
- `**/package.json` - パッケージ設定（該当なし）
- `**/Cargo.toml` - Cargo設定（該当なし）
- `*` - ルートファイル確認

#### 読んだファイル
- `/Users/satoshizerocolored/dev/localtester2/README.md` - プロジェクト概要確認
- `/Users/satoshizerocolored/dev/localtester2/.gitignore` - Git除外設定確認

### 8.2 Web調査

#### Anthropic Computer Use API
- 検索: "Anthropic Claude Computer Use API 2025 specification beta"
- 参照: [Computer use tool - Claude Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- 確認事項:
  - Beta Header: `computer-use-2025-11-24` (Opus 4.5), `computer-use-2025-01-24` (その他)
  - Tool Version: `computer_20251124`, `computer_20250124`
  - 利用可能アクション: screenshot, left_click, type, key, scroll, wait, etc.
  - 画像制約: 長辺1568px, 総ピクセル1.15M
  - 座標スケーリング要件

#### Tauri 2.0
- 検索: "Tauri 2.0 project structure TypeScript Rust"
- 参照: [Tauri Project Structure](https://v2.tauri.app/start/project-structure/)
- 参照: [Create a Project](https://v2.tauri.app/start/create-project/)
- 確認事項:
  - プロジェクト作成: `npm create tauri-app@latest`
  - 構造: `src/` (フロントエンド), `src-tauri/` (Rust)
  - IPC: `invoke()` + `#[tauri::command]`

#### xcap
- 検索: "xcap rust crate screen capture cross-platform"
- 参照: [GitHub - nashaofu/xcap](https://github.com/nashaofu/xcap)
- 確認事項:
  - バージョン: 0.8.0
  - 機能: Monitor::all(), Window::all(), capture_image()
  - プラットフォーム: macOS, Windows, Linux (X11, Wayland)
  - **ウィンドウ機能（追加調査）**:
    - `Window::all()`: システム上の全ウィンドウを列挙
    - `window.title()`: ウィンドウタイトル取得
    - `window.x()`, `window.y()`: ウィンドウ位置
    - `window.width()`, `window.height()`: ウィンドウサイズ
    - `window.is_minimized()`, `window.is_maximized()`: ウィンドウ状態
    - `window.capture_image()`: 個別ウィンドウのキャプチャ
    - 用途: UIで対象ウィンドウを選択し、特定アプリのみをキャプチャ

#### enigo
- 検索: "enigo rust keyboard mouse automation"
- 参照: [GitHub - enigo-rs/enigo](https://github.com/enigo-rs/enigo)
- 確認事項:
  - バージョン: 0.6.1
  - 機能: move_mouse(), button(), text()
  - プラットフォーム: Windows, macOS, Linux (X11)
  - 権限: アクセシビリティ権限必要

#### tauri-plugin-macos-permissions
- 検索: "tauri-plugin-macos-permissions screen recording accessibility"
- 参照: [GitHub - ayangweb/tauri-plugin-macos-permissions](https://github.com/ayangweb/tauri-plugin-macos-permissions)
- 確認事項:
  - バージョン: 2.3.0
  - 対応権限: Accessibility, Screen Recording, Full Disk Access, Microphone, Camera, Input Monitoring
  - 使用方法: check*Permission(), request*Permission()

#### Anthropic TypeScript SDK
- 検索: "Anthropic TypeScript SDK example code"
- 参照: [GitHub - anthropics/anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript)
- 確認事項:
  - パッケージ: `@anthropic-ai/sdk`
  - Beta API: `client.beta.messages.create()`
  - Tool Helpers: `betaZodTool()`, `toolRunner()`

#### Rust image crate
- 検索: "Rust image crate resize scale PNG base64"
- 参照: [image - Rust crate](https://docs.rs/image)
- 確認事項:
  - リサイズ: `DynamicImage::resize()`, `resize_exact()`
  - フォーマット: PNG, JPEG対応
  - Base64: `base64` crateと組み合わせ

#### opencv-rust（認識補助）
- 検索: "opencv-rust template matching Rust crate"
- 参照: [GitHub - twistedfall/opencv-rust](https://github.com/twistedfall/opencv-rust)
- 確認事項:
  - バージョン: 0.93.x
  - 主要機能: imgproc（画像処理）、imgcodecs（画像読み書き）
  - テンプレートマッチング: `opencv::imgproc::match_template()`
  - 依存: OpenCV本体のインストールが必要（macOS: `brew install opencv`、Windows: vcpkg）
  - 用途: UI要素のテンプレート検索、特定ボタン/アイコンの位置検出
  - 採用理由: 依頼文に「SpectRust / opencv-rust」と記載あり。SpectRustは確認できなかったため、実績のあるopencv-rustを採用
  - 実装方針: オプション機能（feature flag）として提供し、初期リリースでは必須としない

### 8.3 非TSファイル確認

| ファイル種別 | 確認 | 結果 |
|-------------|------|------|
| package.json | - | 新規プロジェクトのため未存在 |
| tsconfig.json | - | 新規プロジェクトのため未存在 |
| Cargo.toml | - | 新規プロジェクトのため未存在 |
| .env | - | 存在確認（値は読まず） |
| .gitignore | ○ | `.env`が除外設定済み |

### 8.4 発見した関連情報・懸念事項

1. **Computer Use API Beta制約**: ベータ版のため仕様変更の可能性あり
2. **座標精度**: 高解像度ディスプレイでの座標変換が重要
3. **macOS権限フロー**: 開発モード（`tauri dev`）では権限設定画面に表示されない場合がある
4. **enigo Linux制限**: Wayland対応は実験的（feature flag必要）
5. **プロンプトインジェクション**: Anthropicは分類器を提供しているが完全ではない
6. **opencv-rust依存**: OpenCV本体のインストールが必要なため、オプション機能として提供。ビルド環境のセットアップが複雑になる可能性あり
7. **SpectRust未確認**: 依頼文にあった「SpectRust」は調査したが該当するcrateが見つからず。opencv-rustで代替

### 8.5 レビューフィードバック対応記録

#### 第1回レビュー対応

| 重大度 | 指摘内容 | 対応 | 該当セクション |
|--------|---------|------|---------------|
| 高 | `display_width_px`/`display_height_px`を縮小後サイズに合わせる設計が不明確 | 縮小後サイズを設定する方針を明記。Rust側の`ResizeResult`構造体と座標逆変換フローを詳細化 | 5.2 画像サイズ制約と座標変換 |
| 高 | Tauri WebViewでのCORS/ブラウザ制限への対策がない | `dangerouslyAllowBrowser` + IPC経由キー取得の方針を明記。代替案も記載 | 5.4 Tauri WebViewでのAPI呼び出し制約と対策 |
| 高 | 緊急停止のエージェントループ/API呼び出しキャンセル設計が不足 | 停止フラグ（AtomicBool）、IPCイベント、AbortController、Promise.raceによるキャンセル機構を詳細設計 | Step 2.5 緊急停止システム |
| 中 | シナリオオーケストレーション（キュー管理、状態遷移、messages初期化）が未記載 | ScenarioRunner、AgentLoop、状態定義、遷移フロー図を追加。messages初期化ポリシー（リセット方式）を明記 | Step 3.3 シナリオランナー＆エージェントループ |

#### 第2回レビュー対応（Codex）

| 重大度 | 指摘内容 | 対応 | 該当セクション |
|--------|---------|------|---------------|
| 高 | tool_useループ内でassistantメッセージが重複 | assistantメッセージは1回だけ追加し、tool_resultを配列で収集してまとめて追加するよう修正 | Step 3.3.3 AgentLoop |
| 高 | Promise.raceでSDK内部HTTPはキャンセルされない | 「論理的キャンセル」の限界を注記。真の即時キャンセルにはRust側API呼び出しが必要と明記 | Step 2.5.4 AbortController |
| 高 | CORS対応済みは誤り、WebViewでは失敗リスク | 「CORS対応済み」の断定を削除。実環境での検証が必要と明記。CORSエラー発生時の代替経路を案内 | 5.4 CORS対策 |
| 高 | GlobalHotKeyManagerがdropされる | AppStateでGlobalHotKeyManagerを保持するよう修正。`set_hotkey_manager()`メソッドを追加 | Step 2.5.1, 2.5.2 |
| 中 | snake_case/camelCaseミスマッチ | `ResizeResult`に`#[serde(rename_all = "camelCase")]`を追加 | 5.2 スケーリング計算 |

#### 第3回レビュー対応（Codex）

| 重大度 | 指摘内容 | 対応 | 該当セクション |
|--------|---------|------|---------------|
| 中 | `AgentLoopController`の簡易ループと`ScenarioRunner/AgentLoop`の詳細ループが並存し方針が曖昧 | `AgentLoopController`の冗長な例を削除し、`ScenarioRunner/AgentLoop`の2層構造に統一。緊急停止セクションでは統一設計への参照のみ記載 | Step 2.5.4, Step 3.3 |
| 中 | 緊急停止チェックがイテレーション冒頭のみで、複数`tool_use`がある場合に残りが実行される | `for toolUse`ループ内で`abortSignal.aborted`と`is_stop_requested`を毎回チェックするよう修正 | Step 3.3.3 AgentLoop |
| 中 | `actionHistory`への追加手順が明示されておらず無限ループ検出が実装漏れになり得る | `executeAction`直後に`actionHistory.push()`を追加。`ActionRecord`型定義と`hashAction`メソッドも追記 | Step 3.3.3 AgentLoop |

#### 第4回レビュー対応（Codex）

| 重大度 | 指摘内容 | 対応 | 該当セクション |
|--------|---------|------|---------------|
| 低 | 図中の命名（Agent Loop Controller, agentLoopController）が統一設計（ScenarioRunner + AgentLoop）と不一致 | 全体構成図を「Scenario Runner」に、緊急停止フローを「scenarioRunner.stop()」に修正 | 2.1 全体構成図, 5.2.5.5 緊急停止フロー図 |

---

## 9. 補足：APIキー設定

### 9.1 APIキー管理方式

**【推奨】Rust側で保持 → IPC経由でフロントエンドに提供**:

ViteベースのフロントエンドからAPIキーを直接参照する方法（`VITE_`プレフィックス）はセキュリティ上推奨されません。
本プロジェクトでは、**Rust側で.envを読み込み、IPC経由でフロントエンドに提供**する方式を採用します。

```
┌─────────────────────────────────────────────────────────────┐
│  .env ファイル (プロジェクトルート)                          │
│  ANTHROPIC_API_KEY=sk-ant-xxxxx                              │
│  GEMINI_API_KEY=xxxxx                                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Rust Backend                                                │
│  - dotenv crateで.envを読み込み                              │
│  - アプリ起動時にメモリに保持                                 │
│  - IPCコマンド経由でフロントエンドに提供                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ (Tauri IPC)
┌─────────────────────────────────────────────────────────────┐
│  TypeScript Frontend                                         │
│  - invoke('get_api_key', { keyName: 'anthropic' })           │
│  - Anthropic SDKの初期化に使用                               │
└─────────────────────────────────────────────────────────────┘
```

### 9.2 Rust側の実装

```rust
// Cargo.toml に追加
// dotenv = "0.15"

// src-tauri/src/commands/config.rs
use std::env;

#[tauri::command]
pub fn get_api_key(key_name: String) -> Result<String, String> {
    let env_key = match key_name.as_str() {
        "anthropic" => "ANTHROPIC_API_KEY",
        "gemini" => "GEMINI_API_KEY",
        _ => return Err("Unknown key name".to_string()),
    };

    env::var(env_key).map_err(|_| format!("{} is not set", env_key))
}

// src-tauri/src/lib.rs
fn run() {
    // .envファイルを読み込み
    dotenv::dotenv().ok();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::config::get_api_key,
            // ... 他のコマンド
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 9.3 TypeScript側の実装

```typescript
// src/services/claudeClient.ts
import { invoke } from '@tauri-apps/api/core';
import Anthropic from '@anthropic-ai/sdk';

let anthropicClient: Anthropic | null = null;

export async function getClaudeClient(): Promise<Anthropic> {
    if (anthropicClient) {
        return anthropicClient;
    }

    const apiKey = await invoke<string>('get_api_key', { keyName: 'anthropic' });

    anthropicClient = new Anthropic({
        apiKey: apiKey,
    });

    return anthropicClient;
}
```

### 9.4 .envファイル形式

`.env`ファイル（プロジェクトルートに配置）:
```
ANTHROPIC_API_KEY=sk-ant-xxxxx
GEMINI_API_KEY=xxxxx  # オプション（将来的な拡張用）
```

`.env.example`（サンプルファイル、Gitにコミット可）:
```
ANTHROPIC_API_KEY=your_anthropic_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here
```

### 9.5 Cargo.toml への依存追加

```toml
[dependencies]
# ... 既存の依存 ...
dotenv = "0.15"
```

**重要**:
- `.env`ファイルは絶対にGitにコミットしないこと（.gitignoreで除外済み）
- `.env.example`のみをGitにコミット

---

## 10. 未解決事項・確認が必要な質問

以下の項目は依頼文から明確に判断できなかったため、実装前に確認が必要です：

[QUESTION]
シナリオ間で`messages`履歴（Claudeとの会話履歴）はリセットする想定ですか、それとも前のシナリオの文脈を引き継ぎますか？

**選択肢**:
1. **リセット推奨**: 各シナリオは独立したテストケースとして扱い、履歴をリセットしてClaudeに新鮮な状態から開始させる
2. **引き継ぎ**: 前のシナリオで学習した操作パターンや画面状態の理解を次のシナリオに活かす

**現在の計画の前提**: リセット方式を想定（シナリオごとに独立したテスト実行）
[/QUESTION]

[QUESTION]
ウィンドウ指定キャプチャは要件として必須でしょうか、それとも全画面固定で問題ありませんか？

**現在の計画での対応**:
- Computer Use APIへの送信は**全画面固定**
- ウィンドウ指定は**補助/デバッグ用途**（オプション機能）として位置づけ

これで問題なければ、ウィンドウ指定機能は初期リリースでは優先度を下げ、全画面キャプチャに集中して実装を進めます。
[/QUESTION]

---

計画書ファイルパス: /Users/satoshizerocolored/dev/localtester2/implementation-plan-xenotester.md
