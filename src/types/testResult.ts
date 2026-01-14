/**
 * Test result type definitions
 */

/** Overall test result */
export type TestResultStatus =
  | 'success'      // シナリオが意図通り完了
  | 'failure'      // シナリオの途中で失敗
  | 'timeout'      // 最大イテレーション到達
  | 'stopped'      // ユーザーによる停止
  | 'error';       // システムエラー

/**
 * Failure reason categories
 */
export type FailureReason =
  | 'element_not_found'     // 要素（アイコン、テキスト等）が見つからない
  | 'action_no_effect'      // アクション実行後も画面変化なし
  | 'action_execution_error'// アクション実行がエラーを返した
  | 'stuck_in_loop'         // 同じ状態でスタック（ループ検出閾値未満）
  | 'unexpected_state'      // 期待と異なる画面状態
  | 'action_mismatch'       // ユーザー期待アクションと不一致
  | 'incomplete_actions'    // 期待アクションが全て完了していない
  | 'verification_failed'   // 期待テキストが画面に表示されなかった
  | 'extraction_failed'     // 期待アクション抽出に失敗
  | 'invalid_result_format' // Claudeが結果スキーマに準拠しなかった（補助的理由）
  | 'max_iterations'        // 最大イテレーション到達
  | 'api_error'             // Claude API エラー
  | 'user_stopped'          // ユーザーによる停止
  | 'aborted'               // 中断された
  | 'unknown';              // 原因不明

/** Claudeが返すべき構造化結果スキーマ */
export interface ClaudeResultOutput {
  status: 'success' | 'failure' | 'in_progress';
  message: string;
  failureReason?: string;
  currentStep?: string;
  nextExpectedAction?: string;
}

/**
 * Detailed test result
 * Note: lastScreenshotは保存しない（ログ容量削減のため）
 */
export interface TestResult {
  status: TestResultStatus;
  failureReason?: FailureReason;
  failureDetails?: string;      // 詳細なエラーメッセージ
  completedSteps: number;       // 完了したステップ数
  totalExpectedSteps?: number;  // 予想されるステップ数（判明している場合）
  completedActionIndex: number; // 完了した期待アクションのインデックス
  lastAction?: string;          // 最後に実行したアクション
  claudeAnalysis?: string;      // Claudeによる分析結果
  claudeResultOutput?: ClaudeResultOutput; // Claudeが返した構造化結果
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
}

/** Progress tracking for stuck detection */
export interface ProgressTracker {
  lastScreenshotHash: string;
  unchangedCount: number;
  lastActionType: string;
  lastActionHash: string;         // 同一アクション検出用
  sameActionCount: number;        // 同一アクション連続回数
  lastCoordinate?: [number, number];
}

/** 保留中の高信頼マッチ（画面変化猶予ウィンドウ用） */
export interface PendingHighConfidenceMatch {
  actionIndex: number;           // 保留中の期待アクションインデックス
  matchedAt: number;             // マッチしたイテレーション
  remainingWindow: number;       // 残り猶予ウィンドウ（アクション数）
  screenshotHashAtMatch: string; // マッチ時のスクリーンショットハッシュ
}

/** 期待アクション（ユーザーシナリオから抽出） */
export interface ExpectedAction {
  description: string;           // アクションの説明（例: "Chromeを起動"）
  keywords: string[];            // 期待されるキーワード（例: ["chrome", "click"]）
  targetElements?: string[];     // 対象要素名（例: ["Chrome icon", "アドレスバー"]）
  expectedToolAction?: string;   // 期待されるtool_useのアクション種別
  verificationText?: string;     // アクション後に表示されるべきテキスト（検証用）
  completed: boolean;
}

/** 追加確認結果（フォールバック時の検証用） */
export interface AdditionalConfirmation {
  verified: boolean;
  reason?: string;
  confidence?: 'high' | 'medium' | 'low';
}
