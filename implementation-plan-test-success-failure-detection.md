# テスト成功/失敗判定機能 実装計画書

## 1. 概要

### 1.1 現状の問題

現在のXenotesterは、テストシナリオが「最後まで到達できるまで続ける」という動作になっており、**明確な成功/失敗の判定ロジック**が存在しない。

現在の成功/失敗判定は以下のケースのみ:
1. **成功**: `isScenarioComplete()` でClaudeが `tool_use` を返さなくなった場合（`agentLoop.ts:137-139`）
2. **失敗**:
   - ループ検出（同じアクションが3回繰り返された）
   - 最大イテレーション数到達（30回）
   - ユーザーによる停止（Shift+Esc）
   - APIエラー

### 1.2 要求される改善

ユーザーが書いたシナリオが**意図通りに実行できたか**を明確に判定し、UIに分かりやすく表示する。

失敗のケース例:
- 指示したアイコンが見つからない
- テキストが見つからない
- クリックしたが反応しない
- 次のアクションの前提条件が満たされていない（例: Chrome起動後にアドレスバーが見つからない＝Chromeが起動していない）
- 同じ場所でぐるぐる回っている（進捗なし）

---

## 2. 影響範囲

### 2.1 変更が必要なファイル

#### TypeScript（フロントエンド）

| ファイル | 変更内容 | 理由 |
|----------|----------|------|
| `src/types/scenario.ts` | 新しい失敗理由の型定義追加 | 失敗の種類を詳細に分類するため |
| `src/types/action.ts` | `AgentLoopResult` の拡張、新しい失敗判定設定の追加 | 失敗理由と詳細情報を保持するため |
| `src/services/agentLoop.ts` | 失敗判定ロジックの追加、Claudeレスポンス分析の強化 | 主要な判定ロジックの実装場所 |
| `src/services/scenarioRunner.ts` | 失敗情報のUI向け整形 | 詳細な失敗情報をUIに伝達するため |
| `src/utils/loopDetector.ts` | 進捗なし検出ロジックの追加 | アクションは異なるが進捗がない場合の検出 |
| `src/App.vue` | 成功/失敗の詳細表示UI追加 | ユーザーに分かりやすく結果を表示するため |

#### 新規ファイル

| ファイル | 内容 |
|----------|------|
| `src/services/failureDetector.ts` | 失敗判定のメインロジック |
| `src/types/failure.ts` | 失敗関連の型定義 |

#### 変更しないが影響を受けるファイル

| ファイル | 影響内容 |
|----------|----------|
| `src/services/claudeClient.ts` | 変更なし（既存のAPI呼び出しを使用） |
| `src/services/historyManager.ts` | 変更なし |
| `src-tauri/` 配下 | 変更なし（Rust側の変更は不要） |

---

## 3. 実装ステップ

### Phase 1: 型定義の追加

#### ステップ 1.1: 失敗理由の型定義

**新規ファイル**: `src/types/failure.ts`

```typescript
/**
 * テスト失敗に関する型定義
 */

/** 失敗の種類 */
export type FailureType =
  | 'element_not_found'      // 要素（アイコン、ボタン、テキスト）が見つからない
  | 'action_ineffective'     // アクションを実行したが効果がなかった
  | 'prerequisite_not_met'   // 前提条件が満たされていない（例: アプリが起動していない）
  | 'no_progress'            // 進捗がない（同じ状態が続いている）
  | 'loop_detected'          // 無限ループ検出
  | 'max_iterations'         // 最大イテレーション数到達
  | 'api_error'              // API エラー
  | 'user_stopped'           // ユーザーによる停止
  | 'unexpected_state'       // 予期しない状態
  | 'unknown';               // 不明なエラー

/** 失敗の詳細情報 */
export interface FailureDetail {
  type: FailureType;
  message: string;
  /** 失敗が発生したアクション（あれば） */
  failedAction?: string;
  /** 期待していた状態 */
  expectedState?: string;
  /** 実際の状態 */
  actualState?: string;
  /** Claudeが報告した問題（あれば） */
  claudeReport?: string;
  /** 失敗時のスクリーンショット（Base64） */
  screenshotBase64?: string;
  /** 失敗時のイテレーション番号 */
  iteration?: number;
}

/** 失敗判定の設定 */
export interface FailureDetectionConfig {
  /** 連続して同じ画面状態が続いた場合に「進捗なし」とみなす回数 */
  noProgressThreshold: number;
  /** Claudeが同じ問題を報告した場合に失敗とみなす回数 */
  sameErrorReportThreshold: number;
  /** 失敗と判定するClaudeの報告パターン */
  failurePatterns: string[];
}

/** デフォルトの失敗判定設定 */
export const DEFAULT_FAILURE_DETECTION_CONFIG: FailureDetectionConfig = {
  noProgressThreshold: 3,
  sameErrorReportThreshold: 2,
  failurePatterns: [
    'could not find',
    'unable to locate',
    'not visible',
    'does not exist',
    'cannot find',
    'no such element',
    'element not found',
    'button not found',
    'icon not found',
    'text not found',
    'window not found',
    'application not running',
    'not responding',
    'failed to click',
    'failed to type',
    '見つかりません',
    '見つからない',
    '存在しない',
    '起動していない',
    '反応しない',
  ],
};
```

#### ステップ 1.2: 既存型の拡張

**変更ファイル**: `src/types/scenario.ts`

追加:
```typescript
import type { FailureDetail } from './failure';

// 既存の Scenario インターフェースに追加
export interface Scenario {
  // ... 既存のフィールド ...
  /** 詳細な失敗情報 */
  failureDetail?: FailureDetail;
}
```

**変更ファイル**: `src/types/action.ts`

追加:
```typescript
import type { FailureDetail, FailureDetectionConfig } from './failure';

// 既存の AgentLoopConfig に追加
export interface AgentLoopConfig {
  // ... 既存のフィールド ...
  /** 失敗判定設定 */
  failureDetection?: FailureDetectionConfig;
}

// AgentLoopResult を拡張
export interface AgentLoopResult {
  success: boolean;
  error?: string;
  iterations: number;
  /** 詳細な失敗情報（失敗時のみ） */
  failureDetail?: FailureDetail;
}
```

**変更ファイル**: `src/types/index.ts`

追加:
```typescript
export * from './failure';
```

---

### Phase 2: 失敗判定ロジックの実装

#### ステップ 2.1: 失敗判定サービスの作成

**新規ファイル**: `src/services/failureDetector.ts`

```typescript
/**
 * 失敗判定サービス
 * Claudeのレスポンスと画面状態から失敗を検出する
 */

import type {
  BetaMessage,
  BetaTextBlock,
} from '@anthropic-ai/sdk/resources/beta/messages';
import type {
  FailureDetail,
  FailureType,
  FailureDetectionConfig,
} from '../types/failure';
import { DEFAULT_FAILURE_DETECTION_CONFIG } from '../types/failure';
import type { ComputerAction } from '../types';

/** 画面状態のハッシュ履歴 */
interface ScreenStateHistory {
  hash: string;
  timestamp: number;
}

/**
 * 失敗判定を行うクラス
 */
export class FailureDetector {
  private config: FailureDetectionConfig;
  private screenStateHistory: ScreenStateHistory[] = [];
  private claudeReports: string[] = [];

  constructor(config?: Partial<FailureDetectionConfig>) {
    this.config = {
      ...DEFAULT_FAILURE_DETECTION_CONFIG,
      ...config,
    };
  }

  /**
   * 履歴をリセット
   */
  reset(): void {
    this.screenStateHistory = [];
    this.claudeReports = [];
  }

  /**
   * Claudeのレスポンスから失敗を検出
   */
  analyzeClaudeResponse(
    response: BetaMessage,
    currentAction?: ComputerAction
  ): FailureDetail | null {
    // テキストブロックを抽出
    const textBlocks = response.content.filter(
      (block): block is BetaTextBlock => block.type === 'text'
    );

    if (textBlocks.length === 0) {
      return null;
    }

    const text = textBlocks.map((b) => b.text).join('\n').toLowerCase();
    this.claudeReports.push(text);

    // 失敗パターンの検出
    for (const pattern of this.config.failurePatterns) {
      if (text.includes(pattern.toLowerCase())) {
        return this.createFailureDetail(
          this.categorizeFailure(pattern, text),
          text,
          currentAction
        );
      }
    }

    // 同じエラー報告が繰り返されているか確認
    if (this.isRepeatedError()) {
      return {
        type: 'no_progress',
        message: 'Claude is reporting the same issue repeatedly',
        claudeReport: text,
        failedAction: currentAction?.action,
      };
    }

    return null;
  }

  /**
   * 画面状態の変化を追跡（進捗なし検出用）
   * @param screenshotHash スクリーンショットの簡易ハッシュ
   */
  trackScreenState(screenshotHash: string): boolean {
    const now = Date.now();
    this.screenStateHistory.push({ hash: screenshotHash, timestamp: now });

    // 古い履歴を削除（最新のN個のみ保持）
    if (this.screenStateHistory.length > this.config.noProgressThreshold + 2) {
      this.screenStateHistory.shift();
    }

    // 進捗なし検出
    return this.detectNoProgress();
  }

  /**
   * 進捗なしを検出
   */
  private detectNoProgress(): boolean {
    if (this.screenStateHistory.length < this.config.noProgressThreshold) {
      return false;
    }

    const recent = this.screenStateHistory.slice(-this.config.noProgressThreshold);
    const firstHash = recent[0].hash;
    return recent.every((state) => state.hash === firstHash);
  }

  /**
   * 繰り返しエラーを検出
   */
  private isRepeatedError(): boolean {
    if (this.claudeReports.length < this.config.sameErrorReportThreshold) {
      return false;
    }

    const recent = this.claudeReports.slice(-this.config.sameErrorReportThreshold);

    // 類似度チェック（簡易的に最初の100文字で比較）
    const firstReport = recent[0].substring(0, 100);
    return recent.every((report) => {
      const similarity = this.calculateSimilarity(firstReport, report.substring(0, 100));
      return similarity > 0.8;
    });
  }

  /**
   * 簡易的な文字列類似度計算
   */
  private calculateSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1;
    if (str1.length === 0 || str2.length === 0) return 0;

    const set1 = new Set(str1.split(' '));
    const set2 = new Set(str2.split(' '));
    const intersection = [...set1].filter((x) => set2.has(x)).length;
    const union = new Set([...set1, ...set2]).size;

    return intersection / union;
  }

  /**
   * 失敗パターンから失敗タイプを分類
   */
  private categorizeFailure(pattern: string, fullText: string): FailureType {
    const lowerPattern = pattern.toLowerCase();

    if (
      lowerPattern.includes('not found') ||
      lowerPattern.includes('見つかり') ||
      lowerPattern.includes('見つから')
    ) {
      return 'element_not_found';
    }

    if (
      lowerPattern.includes('not responding') ||
      lowerPattern.includes('反応しない') ||
      lowerPattern.includes('failed to')
    ) {
      return 'action_ineffective';
    }

    if (
      lowerPattern.includes('not running') ||
      lowerPattern.includes('起動していない')
    ) {
      return 'prerequisite_not_met';
    }

    return 'unexpected_state';
  }

  /**
   * 失敗詳細を作成
   */
  private createFailureDetail(
    type: FailureType,
    claudeText: string,
    action?: ComputerAction
  ): FailureDetail {
    return {
      type,
      message: this.generateUserFriendlyMessage(type),
      claudeReport: claudeText,
      failedAction: action?.action,
    };
  }

  /**
   * ユーザー向けの分かりやすいメッセージを生成
   */
  private generateUserFriendlyMessage(type: FailureType): string {
    switch (type) {
      case 'element_not_found':
        return '指定された要素（アイコン、ボタン、テキスト等）が画面上に見つかりませんでした';
      case 'action_ineffective':
        return 'アクションを実行しましたが、期待した反応がありませんでした';
      case 'prerequisite_not_met':
        return '前提条件が満たされていません（アプリケーションが起動していない等）';
      case 'no_progress':
        return '処理が進んでいません（同じ状態が続いています）';
      case 'loop_detected':
        return '無限ループを検出しました（同じアクションが繰り返されています）';
      case 'max_iterations':
        return '最大試行回数に達しました';
      case 'api_error':
        return 'API通信エラーが発生しました';
      case 'user_stopped':
        return 'ユーザーにより停止されました';
      case 'unexpected_state':
        return '予期しない状態が検出されました';
      default:
        return '不明なエラーが発生しました';
    }
  }

  /**
   * 進捗なし失敗詳細を作成
   */
  createNoProgressFailure(iteration: number): FailureDetail {
    return {
      type: 'no_progress',
      message: this.generateUserFriendlyMessage('no_progress'),
      iteration,
    };
  }
}

/**
 * スクリーンショットの簡易ハッシュを計算
 * 完全一致ではなく、視覚的に類似しているかを判定するため、
 * Base64の一部をサンプリングしてハッシュ化
 */
export function computeScreenshotHash(base64: string): string {
  // Base64の中央部分から一定間隔でサンプリング
  const sampleSize = 100;
  const step = Math.floor(base64.length / sampleSize);
  let sample = '';

  for (let i = 0; i < sampleSize; i++) {
    sample += base64.charAt(i * step);
  }

  // 簡易ハッシュ
  let hash = 0;
  for (let i = 0; i < sample.length; i++) {
    const char = sample.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }

  return hash.toString(16);
}
```

#### ステップ 2.2: エージェントループへの失敗判定統合

**変更ファイル**: `src/services/agentLoop.ts`

主な変更点:
1. `FailureDetector` のインポートと初期化
2. Claudeレスポンス分析後に失敗検出を実行
3. 画面状態の追跡
4. 失敗詳細を結果に含める

```typescript
// インポート追加
import { FailureDetector, computeScreenshotHash } from './failureDetector';
import type { FailureDetail } from '../types/failure';

// runAgentLoop 関数内での変更

export async function runAgentLoop(
  options: AgentLoopOptions
): Promise<AgentLoopResult> {
  // ... 既存のコード ...

  // 失敗検出器の初期化
  const failureDetector = new FailureDetector(config.failureDetection);

  try {
    // ... 既存のスクリーンショット取得コード ...

    // Main agent loop
    while (iteration < config.maxIterationsPerScenario) {
      // ... 既存のアボートチェック ...

      // Call Claude API
      const response = await callClaudeAPI(/* ... */);

      // Handle null response
      if (!response) {
        return {
          success: false,
          error: 'API call aborted',
          iterations: iteration,
          failureDetail: { type: 'api_error', message: 'API呼び出しが中断されました' },
        };
      }

      // ★ 追加: Claudeレスポンスから失敗を検出
      const failureFromClaude = failureDetector.analyzeClaudeResponse(response);
      if (failureFromClaude) {
        log(`[Agent Loop] Failure detected from Claude: ${failureFromClaude.message}`);
        return {
          success: false,
          error: failureFromClaude.message,
          iterations: iteration,
          failureDetail: failureFromClaude,
        };
      }

      // Check for completion
      if (isScenarioComplete(response)) {
        log('[Agent Loop] Scenario completed - no more actions');
        return { success: true, iterations: iteration + 1 };
      }

      // ... ツールブロック処理 ...

      for (const toolUse of toolUseBlocks) {
        // ... 既存のアクション実行コード ...

        // アクション実行後のスクリーンショット取得後に追加:
        captureResult = await invoke<CaptureResult>('capture_screen');

        // ★ 追加: 画面状態を追跡して進捗なしを検出
        const screenHash = computeScreenshotHash(captureResult.imageBase64);
        if (failureDetector.trackScreenState(screenHash)) {
          log('[Agent Loop] No progress detected - screen state unchanged');
          return {
            success: false,
            error: 'No progress detected',
            iterations: iteration,
            failureDetail: failureDetector.createNoProgressFailure(iteration),
          };
        }

        // ... 既存のtoolResults処理 ...
      }

      // ... 既存の履歴パージ等 ...

      iteration++;
    }

    // Max iterations reached
    return {
      success: false,
      error: `Max iterations (${config.maxIterationsPerScenario}) reached`,
      iterations: iteration,
      failureDetail: {
        type: 'max_iterations',
        message: `最大試行回数（${config.maxIterationsPerScenario}回）に達しました`,
        iteration,
      },
    };
  } catch (error) {
    // ... エラーハンドリング（failureDetailを追加）...
  }
}
```

---

### Phase 3: UIの改善

#### ステップ 3.1: App.vueの成功/失敗表示改善

**変更ファイル**: `src/App.vue`

追加/変更点:
1. 失敗詳細の表示コンポーネント
2. 成功/失敗のアイコンと色分け
3. 失敗理由の日本語表示

```vue
<script setup lang="ts">
// ... 既存のインポート ...
import type { FailureDetail, FailureType } from './types';

// 失敗タイプのアイコンマッピング
const failureIcons: Record<FailureType, string> = {
  element_not_found: '[要素なし]',
  action_ineffective: '[無効]',
  prerequisite_not_met: '[前提条件]',
  no_progress: '[進捗なし]',
  loop_detected: '[ループ]',
  max_iterations: '[上限]',
  api_error: '[API]',
  user_stopped: '[停止]',
  unexpected_state: '[異常]',
  unknown: '[不明]',
};

// 失敗詳細の表示用フォーマット
function formatFailureDetail(detail: FailureDetail): string {
  let text = `${failureIcons[detail.type]} ${detail.message}`;
  if (detail.failedAction) {
    text += `\n  アクション: ${detail.failedAction}`;
  }
  if (detail.claudeReport) {
    text += `\n  詳細: ${detail.claudeReport.substring(0, 200)}...`;
  }
  return text;
}
</script>

<template>
  <!-- シナリオリスト内の失敗詳細表示 -->
  <div v-if="scenarios.length > 0" class="scenario-list">
    <h2>Scenarios</h2>
    <div
      v-for="(scenario, index) in scenarios"
      :key="scenario.id"
      class="scenario-item"
      :class="{ active: index === currentScenarioIndex }"
    >
      <div class="scenario-header">
        <span class="scenario-title">{{ scenario.title }}</span>
        <span :class="['scenario-status', getStatusClass(scenario.status)]">
          {{ getStatusLabel(scenario.status) }}
        </span>
      </div>
      <div class="scenario-details">
        <span v-if="scenario.iterations">Iterations: {{ scenario.iterations }}</span>

        <!-- ★ 追加: 失敗詳細の表示 -->
        <div v-if="scenario.failureDetail" class="failure-detail">
          <div class="failure-type">
            {{ failureIcons[scenario.failureDetail.type] }} {{ scenario.failureDetail.message }}
          </div>
          <div v-if="scenario.failureDetail.failedAction" class="failure-action">
            Failed Action: {{ scenario.failureDetail.failedAction }}
          </div>
          <div v-if="scenario.failureDetail.claudeReport" class="failure-claude-report">
            <details>
              <summary>Claude's Report</summary>
              <pre>{{ scenario.failureDetail.claudeReport }}</pre>
            </details>
          </div>
        </div>

        <!-- 既存のエラー表示（failureDetailがない場合の後方互換） -->
        <span v-else-if="scenario.error" class="scenario-error">{{ scenario.error }}</span>
      </div>
    </div>
  </div>
</template>

<style>
/* 追加スタイル */
.failure-detail {
  margin-top: 8px;
  padding: 8px;
  background-color: rgba(220, 53, 69, 0.1);
  border-radius: 4px;
  border-left: 3px solid #dc3545;
}

.failure-type {
  font-weight: 500;
  color: #dc3545;
}

.failure-action {
  margin-top: 4px;
  font-size: 12px;
  color: #666;
}

.failure-claude-report {
  margin-top: 8px;
}

.failure-claude-report summary {
  cursor: pointer;
  font-size: 12px;
  color: #888;
}

.failure-claude-report pre {
  margin-top: 4px;
  padding: 8px;
  background-color: #1a1a1a;
  color: #ccc;
  font-size: 11px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
}

@media (prefers-color-scheme: dark) {
  .failure-detail {
    background-color: rgba(220, 53, 69, 0.2);
  }

  .failure-action {
    color: #aaa;
  }
}

/* 成功時のスタイル強調 */
.status-completed {
  background-color: #28a745;
  color: #fff;
  font-weight: 500;
}

.scenario-item.success {
  border-color: #28a745;
  background-color: rgba(40, 167, 69, 0.05);
}
</style>
```

---

### Phase 4: 既存機能との統合

#### ステップ 4.1: scenarioRunner.tsの更新

**変更ファイル**: `src/services/scenarioRunner.ts`

```typescript
// executeScenario メソッド内で failureDetail を伝播

private async executeScenario(
  scenario: Scenario,
  options: ScenarioRunnerOptions
): Promise<void> {
  // ... 既存のコード ...

  try {
    const result: AgentLoopResult = await runAgentLoop({
      scenario,
      abortSignal: this.abortController!.signal,
      onIteration: (iteration) => {
        scenario.iterations = iteration;
        this.notifyStateChange();
      },
      onLog: this.log.bind(this),
      config: options.agentConfig,
    });

    scenario.status = result.success ? 'completed' : 'failed';
    scenario.error = result.error;
    scenario.iterations = result.iterations;
    scenario.completedAt = new Date();

    // ★ 追加: 失敗詳細を保存
    if (result.failureDetail) {
      scenario.failureDetail = result.failureDetail;
    }

    this.log(
      `[Scenario Runner] Scenario ${result.success ? 'completed' : 'failed'}: ${scenario.title}`
    );

    // ★ 追加: 失敗時は詳細もログ出力
    if (!result.success && result.failureDetail) {
      this.log(`[Scenario Runner] Failure reason: ${result.failureDetail.message}`);
    }
  } catch (error) {
    // ... 既存のエラーハンドリング ...
  }

  this.notifyStateChange();
}
```

#### ステップ 4.2: servicesのエクスポート更新

**変更ファイル**: `src/services/index.ts`

```typescript
export * from './agentLoop';
export * from './claudeClient';
export * from './historyManager';
export * from './scenarioParser';
export * from './scenarioRunner';
export * from './failureDetector';  // 追加
```

---

## 4. 技術的考慮事項

### 4.1 パフォーマンス

#### スクリーンショットハッシュ計算
- 軽量なサンプリングベースのハッシュを使用
- 全ピクセル比較ではなく、代表点のサンプリングで高速化
- メモリ効率: ハッシュ履歴は最新数件のみ保持

#### Claude レスポンス分析
- 文字列マッチングベースで軽量
- 正規表現の複雑なパターンは避け、シンプルな部分一致検索

### 4.2 誤検出対策

#### 偽陽性（本当は成功なのに失敗と判定）の防止
- 失敗パターンは明確なエラー文言のみ
- 閾値（noProgressThreshold等）は調整可能
- Claudeが問題を明示的に報告した場合のみ検出

#### 偽陰性（本当は失敗なのに成功と判定）の対処
- 最大イテレーション数による最終的なフォールバック
- ループ検出は既存機能として維持

### 4.3 国際化対応

- 失敗パターンに日本語を含める
- UIメッセージは日本語で統一
- 将来的にはi18nライブラリの導入を検討

---

## 5. テスト計画

### 5.1 単体テスト

| テスト対象 | テストケース |
|------------|------------|
| `FailureDetector.analyzeClaudeResponse()` | 各失敗パターンの検出 |
| `FailureDetector.trackScreenState()` | 進捗なし検出 |
| `computeScreenshotHash()` | ハッシュの一貫性 |
| `calculateSimilarity()` | 類似度計算の精度 |

### 5.2 統合テスト

| テスト対象 | テストケース |
|------------|------------|
| エージェントループ | 要素が見つからない場合の失敗検出 |
| エージェントループ | 進捗なし状態の検出 |
| シナリオランナー | 失敗詳細のUI伝播 |

### 5.3 E2Eテスト

| テスト対象 | テストケース |
|------------|------------|
| 成功シナリオ | 「メモ帳を開いて文字を入力」→ 成功表示 |
| 失敗シナリオ | 「存在しないアプリを開く」→ 失敗詳細表示 |
| 進捗なしシナリオ | 「無効なボタンをクリック」→ 進捗なし検出 |

---

## 6. リスクと対策

### 6.1 誤検出リスク

| リスク | 影響度 | 対策 |
|--------|--------|------|
| 正常な処理を失敗と誤判定 | 中 | 閾値を調整可能にし、保守的なデフォルト値を設定 |
| 失敗を検出できない | 中 | 最大イテレーション数とループ検出をフォールバックとして維持 |

### 6.2 パフォーマンスリスク

| リスク | 影響度 | 対策 |
|--------|--------|------|
| ハッシュ計算のオーバーヘッド | 低 | サンプリングベースで軽量化済み |
| 履歴蓄積によるメモリ増加 | 低 | 履歴は最新数件のみ保持 |

### 6.3 ユーザビリティリスク

| リスク | 影響度 | 対策 |
|--------|--------|------|
| 失敗メッセージが分かりにくい | 中 | 日本語で具体的なメッセージを提供 |
| Claude報告の文字化け | 低 | 適切なエンコーディング処理 |

---

## 7. 調査ログ

### 7.1 実行した検索語（Grep/Globパターン）

| パターン | 目的 | 結果 |
|----------|------|------|
| `src/**/*.ts` | TypeScriptソースファイルの特定 | 15ファイル |
| `src/**/*.vue` | Vueコンポーネントの特定 | 1ファイル |
| `src-tauri/**/*.rs` (target除外) | Rustソースファイルの特定 | 主要16ファイル |
| `success\|fail\|complete\|error\|result` | 成功/失敗関連コードの検索 | 多数のマッチ |
| `loop\|detect` | ループ検出関連コードの検索 | loopDetector.ts等 |
| `isScenarioComplete\|AgentLoopResult` | 完了判定ロジックの検索 | agentLoop.ts |

### 7.2 読んだファイル一覧

#### TypeScript（src配下 15ファイル確認）
- `src/main.ts` - エントリポイント
- `src/App.vue` - メインUI（246行、成功/失敗表示あり）
- `src/services/agentLoop.ts` - エージェントループ（478行、主要な変更対象）
- `src/services/claudeClient.ts` - Claude API クライアント
- `src/services/scenarioParser.ts` - シナリオ分割
- `src/services/scenarioRunner.ts` - シナリオ実行管理（219行、変更対象）
- `src/services/historyManager.ts` - 履歴管理
- `src/services/index.ts` - サービス再エクスポート
- `src/types/index.ts` - 型定義再エクスポート
- `src/types/scenario.ts` - シナリオ型定義（46行、変更対象）
- `src/types/action.ts` - アクション型定義（91行、変更対象）
- `src/types/capture.ts` - キャプチャ型定義
- `src/utils/loopDetector.ts` - ループ検出（72行、参考）
- `src/utils/coordinateScaler.ts` - 座標スケーリング
- `src/utils/index.ts` - ユーティリティ再エクスポート

#### Rust（src-tauri/src配下、targetディレクトリ除外）
- `src-tauri/src/main.rs` - エントリポイント
- `src-tauri/src/lib.rs` - ライブラリ定義
- `src-tauri/src/state.rs` - アプリケーション状態
- `src-tauri/src/error.rs` - エラー定義
- `src-tauri/src/commands/*.rs` - 各種コマンド（5ファイル）
- `src-tauri/src/services/*.rs` - 各種サービス（4ファイル）
- `src-tauri/src/utils/*.rs` - ユーティリティ（2ファイル）

#### 設定ファイル
- `package.json` - 確認済み
- `tsconfig.json` - 確認済み

### 7.3 辿った import/依存チェーン

```
成功/失敗判定の流れ:
App.vue
└── scenarioRunner.ts
    └── agentLoop.ts
        ├── isScenarioComplete() - 現在の成功判定
        ├── detectLoop() - 現在のループ検出（失敗）
        └── AgentLoopResult - 成功/失敗の返却型

Scenario型の流れ:
types/scenario.ts (ScenarioStatus: 'completed' | 'failed' | ...)
└── scenarioRunner.ts (scenario.status = result.success ? 'completed' : 'failed')
    └── App.vue (getStatusClass, getStatusLabel でUI表示)
```

### 7.4 非TSファイル確認の有無

| ファイル種別 | 確認状況 |
|--------------|----------|
| package.json | ✓ 確認済み |
| tsconfig.json | ✓ 確認済み |
| .vue ファイル | ✓ 確認済み（App.vue） |

### 7.5 調査中に発見した関連情報・懸念事項

#### 発見事項
1. **現在の成功判定は「Claudeがtool_useを返さなくなったら成功」という暗黙のルール**
   - `agentLoop.ts:137-139` の `isScenarioComplete()` で判定
   - Claudeが「完了した」と明示的に報告するのではなく、単にアクションを要求しなくなっただけ

2. **失敗判定は限定的**
   - ループ検出: 同じアクションが3回繰り返された場合のみ
   - 最大イテレーション: 30回で強制終了
   - 「要素が見つからない」等の実質的な失敗は検出されていない

3. **UIには既に失敗表示の仕組みがある**
   - `App.vue` に `getStatusClass('failed')` と `getStatusLabel('failed')` が存在
   - `scenario.error` フィールドでエラーメッセージを表示可能
   - これを拡張して詳細な失敗情報を表示できる

4. **Claudeは問題を報告することがある**
   - Claudeのテキストレスポンスに「見つからない」等の報告が含まれる可能性
   - これを分析することで失敗を検出できる

#### 懸念事項
1. **Claudeレスポンスの言語が不定**
   - 日本語/英語混在の可能性
   - 失敗パターンを両言語で定義する必要あり

2. **誤検出のリスク**
   - Claudeが「見つからない」と報告しても、その後見つかる可能性
   - 閾値設定で調整が必要

---

## 8. 結論

現在のXenotesterは、テストの成功/失敗を明確に判定する機能が不足しています。本計画では以下のアプローチで改善を行います：

### 主要な追加機能
1. **Claudeレスポンス分析による失敗検出**: Claudeが「見つからない」「反応しない」等と報告した場合に失敗と判定
2. **進捗なし検出**: 画面状態が変化しない場合に失敗と判定
3. **詳細な失敗情報**: 失敗の種類、原因、Claudeの報告を保存・表示

### 変更ファイル一覧
- 新規: `src/types/failure.ts`, `src/services/failureDetector.ts`
- 変更: `src/types/scenario.ts`, `src/types/action.ts`, `src/types/index.ts`
- 変更: `src/services/agentLoop.ts`, `src/services/scenarioRunner.ts`, `src/services/index.ts`
- 変更: `src/App.vue`

### Rust側の変更
なし（フロントエンド側の変更のみで対応可能）

---

計画書ファイルパス: /Users/satoshizerocolored/dev/localtester2/implementation-plan-test-success-failure-detection.md
