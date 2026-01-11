# テスト結果判定機能 実装計画書

## 1. 概要

### 1.1 目的
現在のXenotesterは、シナリオが「最後まで到達したかどうか」のみを判定しており、「成功」と「失敗」を明確に区別していない。本実装では、テストシナリオの成功/失敗を適切に判定し、UIに分かりやすく表示する機能を追加する。

### 1.2 現状の問題点

**現在の動作**:
1. Claudeが`tool_use`を返さなくなったら「完了」と判定
2. ループ検出・最大イテレーション到達・エラー時は「失敗」と判定
3. しかし、シナリオ内のアクションが「意図通りに実行できたか」は判定していない

**問題となるケース**:
- Claudeが指示したアイコンが画面上に見つからない
- クリックしたが期待した画面遷移が起きない
- 同じ操作をぐるぐる繰り返している（ループ検出の閾値未満）
- ユーザーが書いた次のステップに進めない
- アクション実行がエラーを返しても、そのまま継続してしまう

### 1.3 解決方針

以下の4つのアプローチを組み合わせて判定を行う:

1. **アクション実行エラーの即時評価**: ツール実行結果（要素未検出/クリック失敗等）を直接`failureReason`にマッピングし即時終了
2. **Claude結果スキーマの強制**: Claudeに構造化された結果出力（JSON）を要求し、**未遵守時は期待アクション進捗に基づく判定にフォールバック**
3. **期待アクション照合（改善版）**: ユーザーシナリオを期待アクション列に分解し、**高信頼マッチ時のみインデックスを進行**する柔軟な判定
4. **ヒューリスティック検出**: スクリーンショット変化がない状態（スタック）および同一アクション連続繰り返しを検出し、失敗と判定

### 1.4 判定方針の明確化（フィードバック対応 v6 + v9更新 + v13更新 + v16更新 + v18更新）

#### ★★★ v18追加: 統一判定フロー決定木（最終版） ★★★

**背景**: v11とv16でフォールバック成功判定のルールが併記されており、実装者が混乱する恐れがあった。本セクションで最終的な判定フローを1つの決定木/疑似コードとして統一する。v11以前のルールは廃止とし、v16以降の最新ルールのみを適用する。

**⚠️ 重要: v11のルール「tool_use停止＋エラー/スタックなし＝成功」は廃止。v16以降の「追加根拠必須」ルールが最終版。**

**最終判定フロー決定木（疑似コード）**:
```typescript
function determineTestResult(
  isFromFallback: boolean,
  hasToolUse: boolean,
  resultJson: { status: 'success' | 'failure' } | null,
  hasError: boolean,
  hasStuckDetection: boolean,
  completedActionIndex: number,
  expectedActionsLength: number,
  validationResult: { isValid: boolean },
  additionalConfirmation: { verified: boolean } | null
): TestResult {
  // ★★★ STEP 1: エラー/スタック検出による即時失敗 ★★★
  if (hasError) {
    return { status: 'failure', failureReason: 'action_execution_error' };
  }
  if (hasStuckDetection) {
    return { status: 'failure', failureReason: 'stuck_in_loop' };
  }

  // ★★★ STEP 2: tool_use継続中 → 継続 ★★★
  if (hasToolUse) {
    return { shouldContinue: true };
  }

  // ★★★ STEP 3: tool_use停止後の判定（以下、hasToolUse === false） ★★★

  // ★★★ STEP 3.1: 正常抽出時（isFromFallback === false） ★★★
  if (!isFromFallback) {
    const allActionsCompleted = completedActionIndex >= expectedActionsLength;

    // 妥当性検証OKかつ全完了 → 即時成功
    if (validationResult.isValid && allActionsCompleted) {
      return { status: 'success' };
    }

    // Claude成功JSON + 全完了 → 成功
    if (resultJson?.status === 'success' && allActionsCompleted) {
      return { status: 'success' };
    }

    // Claude失敗JSON → 進捗確認
    if (resultJson?.status === 'failure') {
      // 期待アクション全完了なら進捗を優先して成功（v16）
      if (allActionsCompleted) {
        return { status: 'success' };
      }
      return { status: 'failure', failureReason: resultJson.reason || 'action_execution_error' };
    }

    // JSON未返却 + 妥当性OK + 全完了 → 成功（v15パターンB）
    if (!resultJson && validationResult.isValid && allActionsCompleted) {
      return { status: 'success' };
    }

    // 期待アクション未完了 → 失敗
    return { status: 'failure', failureReason: 'incomplete_actions' };
  }

  // ★★★ STEP 3.2: フォールバック時（isFromFallback === true） ★★★
  // ※v16最新ルール: 追加根拠必須（v11の「tool_use停止だけで成功」は廃止）

  // 追加根拠A: Claude成功JSON → 成功
  if (resultJson?.status === 'success') {
    return { status: 'success' };
  }

  // Claude失敗JSON → 失敗
  if (resultJson?.status === 'failure') {
    return { status: 'failure', failureReason: resultJson.reason || 'action_execution_error' };
  }

  // JSON欠如時: 追加根拠B（最終画面検証）またはC（シナリオ再確認）が必要
  if (additionalConfirmation?.verified) {
    return { status: 'success' };  // 追加根拠B or Cで成功
  }

  // ★★★ v16/v18: 追加根拠なし → 失敗（v11の「tool_use停止だけで成功」は廃止） ★★★
  return { status: 'failure', failureReason: 'incomplete_actions' };
}
```

**判定フロー図**:
```
                         ┌──────────────┐
                         │    開始      │
                         └──────┬───────┘
                                │
                         ┌──────▼───────┐
                         │ エラー検出?   │
                         └──────┬───────┘
                         Yes    │    No
                    ┌───────────┴──────────┐
              ┌─────▼─────┐          ┌─────▼─────┐
              │  失敗      │          │スタック検出?│
              │ (error)    │          └─────┬─────┘
              └───────────┘           Yes   │   No
                               ┌────────────┴──────────┐
                         ┌─────▼─────┐          ┌─────▼─────┐
                         │  失敗      │          │ tool_use?  │
                         │ (stuck)    │          └─────┬─────┘
                         └───────────┘           Yes   │   No
                                          ┌────────────┴──────────┐
                                    ┌─────▼─────┐          ┌─────▼─────┐
                                    │  継続      │          │フォールバック?│
                                    └───────────┘          └─────┬─────┘
                                                            Yes  │  No
                                                   ┌─────────────┴─────────────┐
                                             ┌─────▼─────┐               ┌─────▼─────┐
                                             │追加根拠?   │               │正常抽出判定│
                                             └─────┬─────┘               └─────┬─────┘
                                              Yes  │  No                  (下記参照)
                                         ┌────────┴────────┐
                                   ┌─────▼─────┐    ┌─────▼─────┐
                                   │  成功      │    │  失敗      │
                                   │(追加根拠)   │    │(根拠不足)  │
                                   └───────────┘    └───────────┘
```

**フォールバック時の追加根拠（v16最終版）**:
| 追加根拠 | 条件 | 説明 |
|----------|------|------|
| **A: Claude成功JSON** | `resultJson?.status === 'success'` | Claudeが明示的に成功を報告 |
| **B: 最終画面検証** | `verifyFallbackCompletion`で`verified === true` | 最終画面でシナリオ完了を確認（※v18強化: 下記参照） |
| **C: シナリオ再確認** | Claude再確認で完了判定 | Claudeにシナリオ完了状況を再確認 |

**⚠️ v11ルールとの違い（重要）**:
- **v11（廃止）**: フォールバック時、`tool_use`停止＋エラー/スタックなしで**即時成功**
- **v16/v18（最新）**: フォールバック時、上記追加根拠A/B/Cのいずれかが必須。根拠なしは**失敗**

---

#### 期待アクション全完了時の即時成功確定（新規フィードバック v6-1対応 + v8更新 + v9更新）
**方針: `completedActionIndex >= expectedActions.length`に到達し、かつ妥当性検証をパスした場合に成功を確定**

**問題点**: 現在の設計では、期待アクション全完了後もClaudeが`tool_use`を返し続ける限り`analyzeClaudeResponse`が呼ばれず、余計な操作による失敗リスクがある。

**★★★ v8追加: 妥当性検証を早期成功条件に適用（フィードバック対応） ★★★**

**追加の問題点**: `completedActionIndex >= expectedActions.length`のみで早期成功を判定すると、抽出漏れがある場合（例: 5ステップシナリオで2アクションしか抽出されなかった）、2アクション完了で早期成功になってしまう。

**★★★ v9追加: 妥当性検証NG時の成功確定条件を厳格化 ★★★**

**v8での問題点**: v8では妥当性検証NGの場合に「Claude成功JSON」または「tool_use停止」のいずれかを追加根拠として成功を許可していた。しかし、これでは抽出不足（例: 5ステップで2アクションしか抽出されない）の場合、2アクション完了＋Claude成功JSONだけで成功確定してしまい、実際には未完了のシナリオが成功扱いになる問題があった。

**v9での解決策**: 妥当性検証NGの場合、成功確定には以下の**すべての条件**が必要:
1. `tool_use`停止（Claudeがこれ以上の操作を要求していない）
2. Claude成功JSON（`status: 'success'`）
3. エラー/スタック検出なし

これにより、Claude成功JSONのみでは成功確定せず、Claudeが本当に完了と判断するまで継続する。

**★★★ v15追加: JSON未返却時でも成功とする条件を追加（フィードバック対応） ★★★**

**v9での問題点（フィードバック: 重大度高）**: v9では妥当性検証NGの場合にClaude成功JSONを必須としていた。しかし、これでは「最後まで到達できれば成功」という依頼条件に反する。ClaudeがJSONを返さずに`tool_use`を停止した場合でも、シナリオが完了しているなら成功扱いにすべき。

**v15での解決策**: 妥当性検証NGの場合、成功確定には以下の**いずれか**を満たす必要がある:

**パターンA（JSON返却時）**: すべての条件が必要
1. `tool_use`停止（Claudeがこれ以上の操作を要求していない）
2. Claude成功JSON（`status: 'success'`）
3. エラー/スタック検出なし

**パターンB（JSON未返却時）**: すべての条件が必要（★v15追加）
1. `tool_use`停止（Claudeがこれ以上の操作を要求していない）
2. `completedActionIndex >= expectedActions.length`（期待アクション全完了）
3. エラー/スタック検出なし
4. 明示的な失敗報告がない

これにより、JSON未返却でも「期待アクション全完了 + tool_use停止 + エラーなし」であれば成功と判定する。

**解決策（v15更新版）**:
- `agentLoop`のメインループ内で、各イテレーションの**先頭**で`completedActionIndex >= expectedActions.length`をチェック
- **★v8追加: `validationResult.isValid`も同時にチェック**
- **★v15更新: 妥当性が低い場合（`!validationResult.isValid`）は、追加根拠として「パターンA（JSON返却時）」または「パターンB（JSON未返却時）」のいずれかを満たすことを要求**
- 全完了 かつ 妥当性OK の場合は**即時成功として終了**（残りの`tool_use`は実行しない）
- `analyzeClaudeResponse`にも「全完了なら`tool_use`有無に関わらず完了扱い」のガードを追加

**追加チェック箇所**:
1. **agentLoopのイテレーション先頭**（`hasToolUse`チェック前）
2. **`analyzeClaudeResponse`内**（`hasToolUse`がtrueでも`allExpectedActionsCompleted`なら成功）

```typescript
// agentLoop.ts - メインループ先頭での早期終了チェック（v9更新版）
while (iteration < config.maxIterationsPerScenario) {
  // ★★★ v6追加 + v8更新: 期待アクション全完了チェック（妥当性検証付き） ★★★
  if (expectedActions.length > 0 && completedActionIndex >= expectedActions.length) {
    // ★★★ v8追加: 妥当性検証を早期成功条件に適用 ★★★
    const validationResult = validateExpectedActionsCount(expectedActions, options.scenario.description);

    // ★★★ v11更新: isFromFallbackを早期成功条件から削除 ★★★
    // フォールバック時は抽出精度が低いため、早期成功判定ではなくanalyzeClaudeResponseに委ねる
    if (validationResult.isValid) {
      // 妥当性OKの場合のみ即時成功（フォールバック時は除外）
      log('[Agent Loop] All expected actions completed (validation passed) - terminating with success');
      return {
        success: true,
        iterations: iteration,
        testResult: createTestResult({
          status: 'success',
          completedSteps: iteration,
          completedActionIndex,
          totalExpectedSteps: expectedActions.length,
          claudeAnalysis: 'All expected actions completed successfully',
          startedAt,
        }),
      };
    } else if (isFromFallback) {
      // ★★★ v11追加: フォールバック時は早期成功せず、analyzeClaudeResponseで判定 ★★★
      // フォールバック時はtool_use停止＋Claude成功JSON＋エラー/スタックなしが必要
      log(`[Agent Loop] All expected actions completed (fallback mode) - deferring to analyzeClaudeResponse`);
      log('[Agent Loop] Waiting for tool_use termination AND Claude success JSON as confirmation');
      // 即時終了せず、analyzeClaudeResponseでの判定に委ねる
    } else {
      // ★★★ v9更新: 妥当性が低い場合はtool_use停止＋Claude成功JSON＋エラー/スタックなしを要求 ★★★
      // Claude成功JSONのみでは成功確定しない（v8から変更）
      log(`[Agent Loop] All expected actions completed but validation warning: ${validationResult.warning}`);
      log('[Agent Loop] Waiting for tool_use termination AND Claude success JSON as additional confirmation');
      // 即時終了せず、analyzeClaudeResponseでの判定に委ねる
      // analyzeClaudeResponse内で tool_use停止 + Claude成功JSON + エラー/スタックなし の全条件を確認
    }
  }

  // ...以降の処理...
}
```

#### Claude結果JSON採用前の期待アクション完了検証（新規フィードバック1対応）
**方針: JSON採用前に`completedActionIndex`と`expectedActions.length`を照合**

- Claudeが結果JSON（`status: success`）を返しても、**期待アクションが全て完了していない場合は成功と判定しない**
- 検証フロー:
  1. Claudeが`status: success`のJSONを返す
  2. `completedActionIndex >= expectedActions.length`をチェック
  3. 不一致の場合: `in_progress`として継続、または`failure`（`incomplete_actions`）として終了
  4. 一致の場合: 成功として判定
- これにより「Claudeが早期に成功を報告しても、期待アクション未完了なら失敗」を保証

#### 結果JSON未返却時の方針（フィードバック3対応 + v6-2追加）
**方針: 期待アクション完了/進捗判定に基づくフォールバックを追加**

- Claudeが結果スキーマ（JSON）を返さない場合でも、**期待アクションが全て完了していれば成功**と判定
- **★★★ v11更新: フォールバック時の判定ルールを統一 ★★★**
  - 期待アクション抽出が**正常に成功**した場合（`isFromFallback: false`）: 期待アクション未完了は「判定不能」として**失敗**（`incomplete_actions`）
  - 期待アクション抽出が**フォールバック**した場合（`isFromFallback: true`）: 下記「フォールバック時のJSON欠如対応」ルールを適用
- これにより「最後まで到達したのにJSON未返却で失敗」を防ぐ
- JSON欠如は警告としてログに記録するが、主要な失敗理由としては使用しない

**★★★ v6-2追加 + v11更新: フォールバック時のJSON欠如対応（統一ルール） ★★★**

**問題点**: フォールバック時（`isFromFallback: true`）にClaudeがJSONを返さず、`tool_use`も止まった場合、`analyzeClaudeResponse`の`isComplete`分岐で`incomplete_actions`失敗になってしまう。

**解決策（v11統一）**: フォールバック時は以下の**すべての条件**を満たす場合に**成功**と判定:
1. `isFromFallback === true`（フォールバック使用）
2. `tool_use`がない（`hasToolUse === false`）= Claudeが完了と判断
3. 明示的なエラー報告がない
4. スタック検出が発生していない

**注意**: JSON有無は成功/失敗の決定要因ではない。上記条件を満たせばJSONがなくても成功とする。

**★★★ v16追加: フォールバック時の成功確定に追加根拠を必須化（フィードバック: 重大度高） ★★★**

**v11での問題点**: v11のフォールバックルールは「tool_use停止＋エラー/スタックなし」だけで成功と判定しており、期待アクション抽出に漏れがあった場合（例: 5ステップシナリオで1アクションしか抽出されなかった）、実際には未完了でも成功扱いになり得る。フォールバック時は期待アクションが1件（シナリオ全体）しかないため、`completedActionIndex`の検証が実質的に機能しない。

**v16での解決策**: フォールバック時（`isFromFallback: true`）の成功確定には、以下の**いずれか**の追加根拠を必須化:

**追加根拠A: Claude成功JSON**
- Claudeが`status: 'success'`のJSONを返した場合、Claudeの判断を信頼して成功

**追加根拠B: 最終targetElements検証**
- `tool_use`停止後の画面で、シナリオから抽出した主要キーワード（`extractBasicKeywords`の結果）の存在をClaudeに確認
- 主要キーワードが画面上に見つかれば成功、見つからなければ`incomplete_actions`で失敗

**追加根拠C: シナリオ再抽出による妥当性確認**
- `tool_use`停止後、現在の画面スクリーンショットを含めてシナリオ完了状況をClaudeに再確認
- 「シナリオが完了した」とClaudeが判断すれば成功、そうでなければ失敗

**追加根拠がない場合**: `incomplete_actions`として**失敗**扱い

**フォールバック時の判定ルール表（v16更新）**:

| 条件 | 判定結果 | 理由 |
|------|----------|------|
| `isFromFallback=true` + Claude成功JSON（`status: success`）+ `tool_use`停止 + エラー/スタックなし | **成功** | 追加根拠A: Claudeが明示的に成功を報告 |
| `isFromFallback=true` + JSON欠如 + `tool_use`停止 + targetElements検証パス + エラー/スタックなし | **成功** | ★v16追加: 追加根拠B: 最終画面検証 |
| `isFromFallback=true` + JSON欠如 + `tool_use`停止 + シナリオ再確認で完了判定 + エラー/スタックなし | **成功** | ★v16追加: 追加根拠C: Claude再確認 |
| `isFromFallback=true` + JSON欠如 + `tool_use`停止 + 追加根拠なし | **失敗** | ★v16変更: 根拠不足のため`incomplete_actions` |
| `isFromFallback=true` + Claude失敗JSON（`status: failure`）| **失敗** | Claudeが明示的に失敗を報告 |
| `isFromFallback=true` + エラー/スタック検出あり | **失敗** | 問題が検出された |

**実装（v16追加）**:
```typescript
// analyzeClaudeResponse内のフォールバック時判定（v16更新）
if (isComplete) {
  // ★★★ v16更新: フォールバック時は追加根拠を必須化 ★★★
  if (isFromFallback && !resultOutput) {
    // JSON欠如時は追加根拠が必要
    // 追加根拠B: 最終targetElements検証（外部から渡される）
    // 追加根拠C: シナリオ再確認（外部から渡される）
    if (additionalConfirmation?.verified) {
      console.log('[Result Judge] Fallback mode: no JSON, but additional verification passed - treating as success');
      return {
        isComplete: true,
        isSuccess: true,
        analysis: additionalConfirmation.reason || 'Scenario completed (fallback mode with verification)',
        successByProgress: true,
        shouldContinue: false,
      };
    }

    // ★v16: 追加根拠なしの場合は失敗
    console.warn('[Result Judge] Fallback mode: no JSON, no additional verification - treating as failure');
    return {
      isComplete: true,
      isSuccess: false,
      analysis: 'Fallback mode completed but no confirmation of success',
      failureReason: 'incomplete_actions',
      successByProgress: false,
      shouldContinue: false,
    };
  }

  // JSONがある場合、またはフォールバックでない場合は従来のロジック
  // ...
}
```

**追加根拠Bの実装（targetElements検証）（★v18強化: 誤判定対策）**:

**★★★ v18追加: 追加根拠Bの誤判定対策（フィードバック: 重大度中） ★★★**

**v16での問題点**: v16の追加根拠Bは「最終画面でのキーワード存在確認」に依存していたが、以下のケースで誤判定が発生し得る:
1. **開始画面から同じ要素が存在するケース**: 例えば「Chromeを起動」のシナリオで、デスクトップにChromeアイコンが最初から見えている場合、起動前でも「Chrome」キーワードが検出される
2. **完了条件が画面に現れないケース**: 例えば「メールを送信」のシナリオで、送信完了後に確認画面が出ずにメール一覧に戻る場合、「送信完了」等のキーワードが画面上に見つからない

**v18での解決策**: 追加根拠Bの検証に以下の強化策を適用:

**強化1: 直前画面との差分検証**
- 最終アクション実行前の画面（`previousScreenshot`）と最終画面（`finalScreenshot`）を比較
- 画面に意味のある変化がない場合は`verified: false`を返す
- 「シナリオ完了に伴う画面変化」が確認できた場合のみ成功候補とする

**強化2: 完了状態の明示的確認（シナリオ解析ベース）**
- シナリオから「完了を示す期待状態」を抽出（例: 「起動している」→ウィンドウが開いている状態）
- 最終画面がその期待状態を満たすかをClaudeに確認
- 単なるキーワード存在ではなく「シナリオの意図した結果が達成されたか」を判定

**強化3: 最終アクションの期待結果確認**
- 最終実行アクション（`lastExecutedAction`）と最終画面の整合性を確認
- 例: 最終アクションが「クリック」なら、クリック対象が反応した形跡（選択状態、画面遷移等）があるか確認

```typescript
/**
 * フォールバック成功判定用: 最終画面でシナリオ完了を確認
 * ★v16追加 + v18強化: 誤判定対策
 */
async function verifyFallbackCompletion(
  scenarioDescription: string,
  finalScreenshotBase64: string,
  basicKeywords: string[],
  // ★v18追加: 誤判定対策用の追加パラメータ
  options?: {
    previousScreenshotBase64?: string;  // 直前画面（差分検証用）
    lastExecutedAction?: string;        // 最終実行アクションの説明
    initialScreenshotBase64?: string;   // 開始時の画面（変化検証用）
  }
): Promise<{ verified: boolean; reason?: string; confidence?: 'high' | 'medium' | 'low' }> {
  if (basicKeywords.length === 0) {
    // キーワードがない場合は検証不能、失敗扱い
    return { verified: false, reason: 'No keywords to verify', confidence: 'low' };
  }

  const client = await getClaudeClient();
  const VISION_MODEL = 'claude-sonnet-4-20250514';

  // ★★★ v18強化: 差分検証と完了状態確認を追加したプロンプト ★★★
  const prompt = `
シナリオ: ${scenarioDescription}

あなたはテストシナリオの完了判定を行うアシスタントです。
以下の情報を基に、シナリオが**実際に完了した**かを判定してください。

**重要な判定基準**:
1. **単なるキーワードの存在ではなく、シナリオの「結果」が達成されているか**を確認
2. 開始時点から存在していた要素は、完了の根拠として不十分
3. シナリオで指示されたアクションの「効果」が画面に反映されているか

**シナリオから抽出したキーワード**:
${basicKeywords.map((kw, i) => `${i + 1}. ${kw}`).join('\n')}

${options?.lastExecutedAction ? `**最終実行アクション**: ${options.lastExecutedAction}` : ''}

**判定してください**:
- シナリオで意図した結果が、現在の画面に反映されているか
- 最終アクションの効果が確認できるか
- 「完了した」と自信を持って言えるか（不明な場合はfalse）

JSON形式で回答してください:
\`\`\`json
{
  "verified": true/false,
  "reason": "判断理由（具体的に）",
  "confidence": "high/medium/low",
  "observedCompletionIndicators": ["確認できた完了の兆候（あれば）"]
}
\`\`\`
`;

  try {
    // ★v18: 複数画像を送信して差分検証を支援
    const imageContents: Array<{ type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } }> = [];

    // 開始時の画面がある場合は追加（差分検証用）
    if (options?.initialScreenshotBase64) {
      imageContents.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: options.initialScreenshotBase64 }
      });
    }

    // 直前画面がある場合は追加
    if (options?.previousScreenshotBase64) {
      imageContents.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: options.previousScreenshotBase64 }
      });
    }

    // 最終画面は必須
    imageContents.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: finalScreenshotBase64 }
    });

    // 画像の説明を追加
    let imageDescription = '';
    if (options?.initialScreenshotBase64 && options?.previousScreenshotBase64) {
      imageDescription = '\\n\\n**画像順序**: 1枚目=開始時の画面, 2枚目=最終アクション直前の画面, 3枚目=現在の画面（最終）';
    } else if (options?.initialScreenshotBase64) {
      imageDescription = '\\n\\n**画像順序**: 1枚目=開始時の画面, 2枚目=現在の画面（最終）';
    } else if (options?.previousScreenshotBase64) {
      imageDescription = '\\n\\n**画像順序**: 1枚目=最終アクション直前の画面, 2枚目=現在の画面（最終）';
    } else {
      imageDescription = '\\n\\n**画像**: 現在の画面（最終）';
    }

    const response = await client.messages.create({
      model: VISION_MODEL,
      max_tokens: 512,  // v18: 詳細な判断理由のため増加
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt + imageDescription },
          ...imageContents
        ]
      }]
    });

    const content = response.content[0];
    if (content.type === 'text') {
      const jsonMatch = content.text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[1]);

        // ★v18: confidence が low の場合は verified を false に強制
        if (result.confidence === 'low' && result.verified) {
          console.warn('[verifyFallbackCompletion] Low confidence verification - treating as unverified');
          return {
            verified: false,
            reason: result.reason + ' (low confidence, treating as unverified)',
            confidence: 'low'
          };
        }

        return result;
      }
    }
  } catch (error) {
    console.warn('Fallback completion verification failed:', error);
  }

  return { verified: false, reason: 'Verification failed', confidence: 'low' };
}
```

**★★★ v17追加: agentLoopでの最終スクリーンショット取得・受け渡しデータフロー（フィードバック: 重大度中） ★★★**

**背景**: `verifyFallbackCompletion`関数は`finalScreenshotBase64`を必要とするが、`TestResult`型から`lastScreenshot`を削除する方針と矛盾している。この問題を解決するため、以下のデータフローを明確化する。

**方針**: 最終スクリーンショットは`TestResult`に保存せず、`agentLoop`内で一時的に保持し、フォールバック検証にのみ使用して破棄する。

**データフロー**:
1. **スクリーンショット取得タイミング**: `agentLoop`のツール実行ループ内で、各イテレーション終了時に`captureResult.imageBase64`を保持（既存の変数`captureResult`を流用）
2. **フォールバック検証タイミング**: `analyzeClaudeResponse`を呼び出す前に、フォールバック条件を満たす場合のみ`verifyFallbackCompletion`を呼び出す
3. **スクリーンショットの寿命**: `agentLoop`関数スコープ内でのみ保持し、`TestResult`には保存しない（ログ容量削減方針と整合）

**実装手順（agentLoop.ts）（v17 + v18更新）**:
```typescript
// agentLoop.ts - フォールバック時の追加検証フロー（v17追加 + v18更新）

// ★★★ v18追加: 開始時/直前スクリーンショットの保持 ★★★
// agentLoopの先頭でシナリオ開始時の画面を保存（誤判定対策用）
let initialScreenshotBase64: string | undefined;
let previousScreenshotBase64: string | undefined;
let lastExecutedActionDescription: string | undefined;

// 初回スクリーンショット取得後に保存
if (iteration === 0 && captureResult.imageBase64) {
  initialScreenshotBase64 = captureResult.imageBase64;
}

// ツール実行ループ内で、各アクション実行前に直前画面を保存
// beforeActionScreenshot = captureResult.imageBase64;
// ... アクション実行 ...
// previousScreenshotBase64 = beforeActionScreenshot;  // 最終アクション直前の画面として保持

// ★★★ v17追加 + v18更新: フォールバック時のadditionalConfirmation生成 ★★★
let additionalConfirmation: { verified: boolean; reason?: string; confidence?: string } | undefined;

// フォールバック + JSON欠如 + tool_use停止 の場合のみ検証を実行
const hasToolUse = response.content.some(block => block.type === 'tool_use');
if (isFromFallback && !hasToolUse) {
  // JSONの有無を事前チェック
  const textBlocks = response.content.filter(block => block.type === 'text');
  const responseText = textBlocks.map(b => (b as BetaTextBlock).text).join('\n');
  const hasJson = /```json[\s\S]*?```/.test(responseText) || /"status"\s*:\s*"(success|failure)"/.test(responseText);

  if (!hasJson) {
    // JSON欠如時: 追加検証を実行
    const basicKeywords = extractBasicKeywords(options.scenario.description);
    log(`[Agent Loop] Fallback mode with no JSON - verifying completion with ${basicKeywords.length} keywords`);

    // ★★★ v18更新: 誤判定対策用の追加パラメータを渡す ★★★
    additionalConfirmation = await verifyFallbackCompletion(
      options.scenario.description,
      captureResult.imageBase64,  // 最終画面
      basicKeywords,
      {
        initialScreenshotBase64,        // ★v18: 開始時の画面（変化検証用）
        previousScreenshotBase64,       // ★v18: 直前画面（差分検証用）
        lastExecutedAction: lastExecutedActionDescription  // ★v18: 最終アクション説明
      }
    );

    log(`[Agent Loop] Fallback verification result: verified=${additionalConfirmation.verified}, reason=${additionalConfirmation.reason}, confidence=${additionalConfirmation.confidence}`);

    // ★v18: confidenceがlowの場合は警告ログを出力
    if (additionalConfirmation.confidence === 'low') {
      log(`[Agent Loop] Warning: Low confidence verification - may be false positive`);
    }
  }
}

// analyzeClaudeResponseにadditionalConfirmationを渡す
const analyzeResult = analyzeClaudeResponse(
  response,
  expectedActions,
  completedActionIndex,
  isFromFallback,
  additionalConfirmation  // ★v17追加: 追加検証結果を渡す
);
```

**analyzeClaudeResponse関数シグネチャの更新**:
```typescript
// resultJudge.ts

export interface AdditionalConfirmation {
  verified: boolean;
  reason?: string;
}

export function analyzeClaudeResponse(
  response: BetaMessage,
  expectedActions: ExpectedAction[],
  completedActionIndex: number,
  isFromFallback: boolean,
  additionalConfirmation?: AdditionalConfirmation  // ★v17追加
): AnalyzeResult {
  // ... 既存ロジック ...
}
```

**重要な設計判断**:
- **なぜTestResultに保存しないか**: セクション4.1で明記した「ログ容量削減」方針を維持するため
- **なぜagentLoop内で完結させるか**: スクリーンショットは検証目的でのみ必要であり、検証完了後は不要
- **メモリ効率**: `captureResult`は各イテレーションで上書きされるため、追加のメモリ消費は最小限

#### 期待アクション照合の粒度（フィードバック1対応）
**方針: 高信頼マッチ時のみインデックスを進行**

- 期待アクションは「Chromeを起動」のような**高レベルの記述**
- 1つの期待アクションは**複数のtool_use（クリック→待機→入力等）で達成**される可能性がある
- `completedActionIndex`は**tool_useごとに増加させない**
- 代わりに、**高信頼度のマッチ（keywords/targetElements一致）時のみインデックスを進行**
- Claude APIによる検証で「期待アクションが達成された」と判断された場合にも進行

#### クリック系アクションの照合改善（新規フィードバック2対応 + v5対応）
**方針: `text`に依存しない多要素照合を追加 + 画面変化を必須条件に**

**問題点**: `ComputerAction`の`text`フィールドは`type`/`key`アクション専用であり、クリック系アクションでは空。現在の照合ロジックはキーワードマッチに`toolAction.text`を使用しているため、クリック系では高信頼マッチに到達しない。

**解決策**: 以下の多要素照合を追加
1. **アクション種別マッチ**: クリック系なら`expectedToolAction`との種別一致で中信頼度
2. **★★★スクリーンショット変化検出（必須条件化 - v5対応）★★★**: アクション実行後の画面変化を`shouldAdvanceIndex`の必須条件として組み込む
3. **Claude視覚検証**: 中信頼度アクションが一定回数続いた場合、現在の画面スクリーンショットをClaudeに送信し「期待アクションが達成されたか」を確認
4. **座標/コンテキスト活用**: 期待アクションの`targetElements`と画面コンテキスト（直前のClaude応答テキスト）を照合

**★★★照合優先度（v6改訂: 画面変化猶予ウィンドウを追加）★★★**:
1. **高信頼マッチ** → インデックス進行（**画面変化が必須 or 猶予ウィンドウ内で変化**）
   - `type`/`key`アクションでキーワード2つ以上一致 **かつ 画面変化あり**
   - Claude視覚検証で「達成」と判定 **かつ 画面変化あり**
   - **画面変化なし**の場合は高信頼マッチでも**インデックス進行しない**（即時）
   - **★★★ v6追加: 猶予ウィンドウ内で画面変化が検出された場合、遡って高信頼マッチを完了扱いに**
2. **中信頼マッチ** → インデックス進行しない、カウンター増加
   - アクション種別一致（クリック系含む）
   - キーワード1つ一致
3. **低信頼マッチ** → インデックス進行しない
   - 一致なし（補助操作の可能性）

**中信頼マッチが続いた場合のフロー**:
- 中信頼マッチが3回連続 → Claude視覚検証を実行
- Claude視覚検証で「達成」**かつ画面変化あり** → 高信頼マッチとして扱い、インデックス進行
- Claude視覚検証で「達成」**だが画面変化なし** → インデックス進行しない
- Claude視覚検証で「未達成」→ 継続（更に3回後に再検証）

**★★★ v6-3追加: 画面変化の猶予ウィンドウ ★★★**

**問題点**: UIの変化が`wait`の後に出るケース（非同期レンダリング、アニメーション完了後等）で、高/中信頼マッチ直後に画面変化がないと認識されず、期待アクション完了が認識されない。

**解決策**: `pendingHighConfidenceMatch`構造を導入し、短い猶予ウィンドウ内の画面変化も完了判定に使用可能にする。

```typescript
// 新規型定義: 保留中の高信頼マッチ
interface PendingHighConfidenceMatch {
  actionIndex: number;           // 保留中の期待アクションインデックス
  matchedAt: number;             // マッチしたイテレーション
  remainingWindow: number;       // 残り猶予ウィンドウ（アクション数）
  screenshotHashAtMatch: string; // マッチ時のスクリーンショットハッシュ
}

// agentLoop.tsでの使用
let pendingHighConfidenceMatch: PendingHighConfidenceMatch | null = null;
const SCREEN_CHANGE_GRACE_WINDOW = 2;  // wait/数アクション以内の画面変化を許容

// 各イテレーションで:
// 1. 保留中のマッチがある場合、画面変化をチェック
if (pendingHighConfidenceMatch && pendingHighConfidenceMatch.remainingWindow > 0) {
  const currentHash = hashScreenshot(captureResult.imageBase64);
  if (currentHash !== pendingHighConfidenceMatch.screenshotHashAtMatch) {
    // 画面変化あり → 遡って完了扱い
    log(`[Agent Loop] Screen changed within grace window - completing deferred action ${pendingHighConfidenceMatch.actionIndex}`);
    if (expectedActions.length > pendingHighConfidenceMatch.actionIndex) {
      expectedActions[pendingHighConfidenceMatch.actionIndex].completed = true;
      completedActionIndex = pendingHighConfidenceMatch.actionIndex + 1;
    }
    pendingHighConfidenceMatch = null;
  } else {
    pendingHighConfidenceMatch.remainingWindow--;
    if (pendingHighConfidenceMatch.remainingWindow <= 0) {
      // 猶予期間終了、画面変化なし → 保留を破棄
      log(`[Agent Loop] Grace window expired without screen change - discarding pending match`);
      pendingHighConfidenceMatch = null;
    }
  }
}

// 2. 新たな高信頼マッチが画面変化なしの場合、保留に追加
if (validation.confidence === 'high' && !screenChanged) {
  pendingHighConfidenceMatch = {
    actionIndex: completedActionIndex,
    matchedAt: iteration,
    remainingWindow: SCREEN_CHANGE_GRACE_WINDOW,
    screenshotHashAtMatch: hashScreenshot(previousScreenshotBase64),
  };
  log(`[Agent Loop] High confidence match without screen change - deferring completion (grace window: ${SCREEN_CHANGE_GRACE_WINDOW})`);
}
```

**★★★画面変化なしでインデックス進行しない例外（非プログレッシブアクション）★★★**:
- `wait`、`screenshot`、`mouse_move`などの非プログレッシブアクションは画面変化を期待しないため、例外として扱う
- これらのアクションは`isNonProgressiveAction`でスキップされ、進捗判定の対象外となる

#### 同一アクション連続検出の設計（フィードバック2対応 + v5修正）
**方針: checkProgress内で同一アクション連続検出を実装**

- `checkProgress`内で同一アクション連続検出を行う（`sameActionCount`の更新を一箇所に集約）
- **★★★v5修正: 現状コードに`checkSameActionRepeat`関数は存在しないため、「削除」ではなく「統合的に新規実装」が正確な表現★★★**
- これにより同一アクション検出のロジックが一箇所に集約され、保守性が向上

#### 低/中信頼マッチ連続時の`action_mismatch`失敗判定（v7対応 + v15更新）
**方針: 低/中信頼マッチが一定回数続いた場合、`action_mismatch`で失敗終了**

**問題点**: `action_mismatch`を`FailureReason`として定義しているが、実際にこの理由で失敗終了する判定ロジックが存在しない。現在の設計では、低/中信頼マッチが続いてもタイムアウト（max_iterations）またはスタック検出（stuck_in_loop）でしか終了しない。

**★★★ v15追加: 補助操作による誤失敗を防止（フィードバック: 重大度中） ★★★**

**v7での問題点**: 低/中信頼マッチが10回続くと即座に`action_mismatch`失敗になる設計は、以下のような補助操作が多いシナリオで誤失敗を誘発し得る:
- スクロールして要素を探す
- ポップアップやダイアログを閉じる
- 複数回クリックを試みる
- 画面の読み込みを待つ

**v15での解決策**: カウンタ増加を以下の条件に限定する:
1. **画面変化なし**（`!screenChanged`）かつ
2. **completedActionIndexが進んでいない**（`completedActionIndex === previousCompletedActionIndex`）

これにより、補助操作（画面変化はあるがcompletedActionIndexは進まない）や、アクション完了（completedActionIndexが進む）ではカウントが増加しない。

**解決策（v15更新版）**:
- `lowConfidenceActionCount`カウンターを追加（低/中信頼マッチの連続回数を追跡）
- 低/中信頼マッチが**一定回数**（デフォルト: 10回）続き、かつ**画面変化なし＋completedActionIndex進行なし**の場合、`action_mismatch`で失敗終了
- 高信頼マッチが発生したらカウンターをリセット
- **★v15追加: 画面変化があった場合、またはcompletedActionIndexが進行した場合もカウンターをリセット**

**判定ロジック（v15更新版）**:
```typescript
// agentLoop.ts内での実装
const MAX_LOW_CONFIDENCE_ACTIONS = 10;  // 低/中信頼マッチの最大連続回数
let lowConfidenceActionCount = 0;
let previousCompletedActionIndex = 0;  // ★v15追加: 前回のcompletedActionIndex

// ツール実行ループ内で
if (validation.confidence === 'high' && validation.shouldAdvanceIndex) {
  // 高信頼マッチ成功 → カウンターリセット
  lowConfidenceActionCount = 0;
} else if (validation.confidence === 'medium' || validation.confidence === 'low') {
  // ★★★ v15更新: カウンター増加条件を厳格化 ★★★
  // 補助操作（画面変化あり or completedActionIndex進行）では増加しない
  const actionIndexProgressed = completedActionIndex > previousCompletedActionIndex;

  if (!screenChanged && !actionIndexProgressed) {
    // 画面変化なし かつ completedActionIndex進行なし → カウンター増加
    lowConfidenceActionCount++;

    if (lowConfidenceActionCount >= MAX_LOW_CONFIDENCE_ACTIONS) {
      log(`[Agent Loop] Low/medium confidence actions exceeded threshold (${lowConfidenceActionCount}) without progress`);
      return {
        success: false,
        error: 'Action mismatch: unable to match expected actions',
        iterations: iteration,
        testResult: createTestResult({
          status: 'failure',
          failureReason: 'action_mismatch',
          failureDetails: `Low/medium confidence actions continued for ${lowConfidenceActionCount} iterations without screen change or action progress`,
          completedSteps: iteration,
          completedActionIndex,
          lastAction: formatActionDetails(action, captureResult.scaleFactor, captureResult.displayScaleFactor),
          startedAt,
        }),
      };
    }
  } else {
    // ★v15追加: 画面変化あり または completedActionIndex進行 → カウンターリセット
    lowConfidenceActionCount = 0;
  }
}
```

**設定可能なパラメータ**:
- `AgentLoopConfig`に`maxLowConfidenceActions`を追加（デフォルト: 10）

#### extractExpectedActions失敗時の代替ルール（フィードバック4対応 + 新規フィードバック3対応）
**方針: scenarioParser等で最低限の期待アクション列を生成し、フォールバック使用フラグを追加**

- `extractExpectedActions`が失敗した場合、以下のフォールバックを適用:
  1. シナリオ全体を1つの期待アクションとして扱う（`{ description: シナリオ全文, keywords: [], completed: false }`）
  2. **★新規フィードバック3対応: `isFromFallback: true`フラグを返却し、フォールバック使用を明示**
  3. **フォールバック時（`isFromFallback: true`）はClaude結果スキーマが`success`を返した場合は成功と判定**（`analyzeClaudeResponse`で特別扱い）
  4. それ以外の場合、`tool_use`がなくなった時点で「判定不能」として失敗（`incomplete_actions`）
- これによりClaude自己申告への完全依存を避けつつ、フォールバック時には妥当な成功判定を行う

**重要な変更点（新規フィードバック3 + v8更新）**:
- `extractExpectedActions`の戻り値を`{ expectedActions: ExpectedAction[], isFromFallback: boolean }`に変更
- `analyzeClaudeResponse`の引数に`isFromFallback`フラグを追加
- フォールバック時（`isFromFallback: true`）は`expectedActions.length === 1`でも`completedActionIndex`チェックを緩和し、Claude成功報告を採用可能に

**★★★ v8追加: フォールバック時のJSON欠如ルール統一（フィードバック対応） ★★★**

フォールバック時（`isFromFallback: true`）のJSON欠如時の扱いを以下のルールに統一:

| 条件 | 判定結果 | 理由 |
|------|----------|------|
| `isFromFallback=true` + JSON成功報告あり | **成功** | Claudeが明示的に成功を報告 |
| `isFromFallback=true` + JSON欠如 + `tool_use`停止 + エラー/スタックなし | **成功** | 完了シナリオとして扱う |
| `isFromFallback=true` + JSON欠如 + `tool_use`停止 + エラー/スタック検出 | **失敗** | 問題が検出された |
| `isFromFallback=true` + JSON失敗報告あり | **失敗** | Claudeが明示的に失敗を報告 |

このルールは「tool_use停止＋エラー/スタックなし＝成功」を採用し、完了シナリオを誤って失敗扱いにすることを防ぐ。

#### 期待アクション列の妥当性検証（v7対応）
**方針: 抽出した期待アクション列が妥当かを検証し、早期成功を防止**

**問題点**: 成功判定が`completedActionIndex >= expectedActions.length`に依存しているが、`extractExpectedActions`は「非空なら成功」扱いで抽出精度の妥当性チェックがない。シナリオに「5ステップ」と書いてあっても、抽出で「3アクション」しか取れなかった場合、3アクション完了で早期成功になり得る。

**解決策**: 以下の3段階で期待アクション列の妥当性を検証

**1. シナリオ文からのステップ数ヒント抽出**:
```typescript
/**
 * シナリオ文からステップ数のヒントを抽出
 * 「3ステップ」「5つの操作」などの表現を検出
 */
function extractStepCountHint(scenario: string): number | null {
  const patterns = [
    /(\d+)\s*(?:ステップ|steps?|操作|アクション)/i,
    /(?:以下の|次の)\s*(\d+)\s*(?:つ|個)/,
  ];

  for (const pattern of patterns) {
    const match = scenario.match(pattern);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  // 番号付きリスト（「1. ○○ 2. ○○」）を検出
  const numberedListMatches = scenario.match(/^\s*\d+[\.\)]/gm);
  if (numberedListMatches && numberedListMatches.length >= 2) {
    return numberedListMatches.length;
  }

  return null;
}
```

**2. 最低件数の検証**:
```typescript
/**
 * 期待アクション列の妥当性を検証
 * @returns { isValid: boolean, warning?: string }
 */
function validateExpectedActionsCount(
  expectedActions: ExpectedAction[],
  scenario: string
): { isValid: boolean; warning?: string; suggestedMinimum?: number } {
  const stepCountHint = extractStepCountHint(scenario);

  // シナリオが複数行（改行が2つ以上）なら最低2件を期待
  const lineCount = scenario.split('\n').filter(line => line.trim().length > 0).length;
  const suggestedMinimum = Math.max(lineCount > 1 ? 2 : 1, stepCountHint || 1);

  if (expectedActions.length < suggestedMinimum) {
    return {
      isValid: false,
      warning: `Expected at least ${suggestedMinimum} actions based on scenario, but got ${expectedActions.length}`,
      suggestedMinimum,
    };
  }

  // ステップ数ヒントとの乖離チェック（50%以上の乖離は警告）
  if (stepCountHint && expectedActions.length < stepCountHint * 0.5) {
    return {
      isValid: false,
      warning: `Scenario hints at ${stepCountHint} steps, but only ${expectedActions.length} actions extracted`,
      suggestedMinimum: stepCountHint,
    };
  }

  return { isValid: true };
}
```

**3. Claude成功JSONとの併用（早期成功防止 + v9更新）**:
```typescript
// analyzeClaudeResponse内での追加チェック（v9更新版）
// 期待アクション列の妥当性が低い場合、Claude成功JSONだけでは成功確定しない
if (resultOutput?.status === 'success' && allExpectedActionsCompleted) {
  // ★★★ v7追加: 期待アクション列の妥当性チェック ★★★
  const validation = validateExpectedActionsCount(expectedActions, scenarioDescription);

  if (!validation.isValid && !isFromFallback) {
    // ★★★ v9更新: 妥当性が低い場合、成功確定には以下の全条件が必要 ★★★
    // 1. tool_use停止（hasToolUse === false）
    // 2. Claude成功JSON（resultOutput.status === 'success'）
    // 3. エラー/スタック検出なし
    console.warn(`[Result Judge] Expected actions validation warning: ${validation.warning}`);

    if (resultOutput && !hasToolUse) {
      // ★v9: tool_use停止 + Claude成功JSON → 成功を許可
      console.log('[Result Judge] Claude JSON confirms success AND tool_use stopped - accepting despite validation warning');
      return { isComplete: true, isSuccess: true, ... };
    } else if (hasToolUse) {
      // ★v9: tool_useがまだある場合は継続（Claude成功JSONのみでは成功確定しない）
      console.log('[Result Judge] Claude JSON confirms success but tool_use continues - waiting for tool_use to stop');
      return { isComplete: false, shouldContinue: true, ... };
    }

    // Claude成功JSONがない場合は継続を促す
    return { isComplete: false, shouldContinue: true, ... };
  }
}
```

**★★★ v15更新: 妥当性検証NG時の成功確定ルール表（JSON未返却対応） ★★★**

| 条件 | 判定結果 | 理由 |
|------|----------|------|
| `!validation.isValid` + Claude成功JSON + `tool_use`停止 + エラー/スタックなし | **成功** | パターンA: 全条件を満たす |
| `!validation.isValid` + Claude成功JSON + `tool_use`継続中 | **継続** | tool_use停止を待つ |
| `!validation.isValid` + Claude成功JSONなし + `tool_use`停止 + `completedActionIndex >= expectedActions.length` + エラー/スタックなし | **成功** | ★v15追加: パターンB（期待アクション全完了）|
| `!validation.isValid` + Claude成功JSONなし + `tool_use`停止 + `completedActionIndex < expectedActions.length` | **失敗** | 期待アクション未完了 |
| `!validation.isValid` + エラー/スタック検出あり | **失敗** | 問題検出 |

**v15変更点**: 「Claude成功JSONなし + tool_use停止」でも、`completedActionIndex >= expectedActions.length`（期待アクション全完了）かつエラー/スタックなしであれば成功と判定する。これにより「最後まで到達できれば成功」という要件を満たす。

**実装箇所**:
- `actionValidator.ts`に`extractStepCountHint`と`validateExpectedActionsCount`を追加
- `extractExpectedActions`の戻り値に`validationResult`を追加
- `analyzeClaudeResponse`で妥当性検証結果を考慮
- **★v9追加: `analyzeClaudeResponse`で`hasToolUse`も条件に含める**
- **★v15追加: `analyzeClaudeResponse`でJSON未返却時のパターンBを追加**

**設定可能なパラメータ**:
- `AgentLoopConfig`に`strictExpectedActionsValidation`を追加（デフォルト: true）
- falseの場合は妥当性検証をスキップ

#### UI上の成功/失敗の定義（v15更新: Stopped別枠表示）
**方針: success以外は全て失敗として統一表示、ただしStoppedは別枠表示**

**★★★ v15追加: UIサマリーでStopped/Errorを別枠表示（フィードバック: 重大度低） ★★★**

**問題点（フィードバック）**: UIサマリーで`stopped`/`error`を「Failed」に合算すると、ユーザー停止が「アクション不能の失敗」と同列に見える。ユーザーが意図的に停止した場合と、シナリオが失敗した場合は区別すべき。

**v15での解決策**: UIサマリーを3カテゴリ（または4カテゴリ）に分割:
1. **Passed** (緑): `status === 'success'`
2. **Failed** (赤): `status === 'failure'` または `status === 'timeout'`
3. **Stopped** (黄): `status === 'stopped'` または `status === 'error'`（ユーザー操作や外部要因）
4. **Pending** (グレー): `!result && status === 'pending'`

これにより:
- 「ユーザーによる停止」は黄色で表示され、失敗とは区別される
- 「シナリオの失敗」は赤で表示され、問題があることが明確になる
- 詳細表示では各ステータスを区別（失敗理由を表示）

**表示例**:
```
[ 3 Passed ] [ 1 Failed ] [ 2 Stopped ] [ 0 Pending ]
```

#### ★★★ v12追加: element_not_found検出の強化 ★★★

**問題点**: 現在の`executeAction`は座標ベースの操作を行うため、技術的には常に成功する。「アイコンが見つからない」「テキストが見つからない」はClaudeの視覚認識の問題であり、`executeAction`のエラー文字列からは検出できない。

**解決策**: 以下の複合的なアプローチで`element_not_found`を検出:

**1. targetElementsを使った事後検証**:
```typescript
/**
 * 期待アクションのtargetElementsが画面上に存在するかをClaudeに確認
 * クリック系アクション実行後に呼び出し、要素が見つからない場合はelement_not_foundを判定
 */
async function verifyTargetElementsPresence(
  expectedAction: ExpectedAction,
  screenshotBase64: string
): Promise<{ found: boolean; missingElements?: string[] }> {
  if (!expectedAction.targetElements || expectedAction.targetElements.length === 0) {
    return { found: true };  // targetElementsが指定されていない場合はスキップ
  }

  const client = await getClaudeClient();
  const VISION_MODEL = 'claude-sonnet-4-20250514';

  const prompt = `
現在の画面を確認し、以下の要素が存在するか判定してください:
${expectedAction.targetElements.map((el, i) => `${i + 1}. ${el}`).join('\n')}

JSON形式で回答してください:
\`\`\`json
{"found": true/false, "missingElements": ["見つからない要素名1", "見つからない要素名2"]}
\`\`\`
`;

  try {
    const response = await client.messages.create({
      model: VISION_MODEL,
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotBase64 } }
        ]
      }]
    });

    const content = response.content[0];
    if (content.type === 'text') {
      const jsonMatch = content.text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
      }
    }
  } catch (error) {
    console.warn('Target elements verification failed:', error);
  }

  return { found: true };  // 検証失敗時は要素存在を仮定
}
```

**2. 「画面変化なし＋低信頼連続」からelement_not_foundへの昇格**:
```typescript
// agentLoop.ts内での実装
const ELEMENT_NOT_FOUND_THRESHOLD = 5;  // 画面変化なし＋低信頼連続の閾値
let noProgressLowConfidenceCount = 0;

// 各イテレーションで
if (!screenChanged && (validation.confidence === 'low' || validation.confidence === 'medium')) {
  noProgressLowConfidenceCount++;

  if (noProgressLowConfidenceCount >= ELEMENT_NOT_FOUND_THRESHOLD) {
    // 画面変化なし＋低信頼が続いている → element_not_foundの可能性が高い
    log(`[Agent Loop] No screen change + low confidence for ${noProgressLowConfidenceCount} iterations - treating as element_not_found`);

    // targetElements検証を実行（オプション）
    const verificationResult = await verifyTargetElementsPresence(
      expectedActions[completedActionIndex],
      captureResult.imageBase64
    );

    if (!verificationResult.found) {
      return {
        success: false,
        error: `Element not found: ${verificationResult.missingElements?.join(', ') || 'unknown'}`,
        iterations: iteration,
        testResult: createTestResult({
          status: 'failure',
          failureReason: 'element_not_found',
          failureDetails: `Expected elements not found: ${verificationResult.missingElements?.join(', ')}`,
          completedSteps: iteration,
          completedActionIndex,
          lastAction: formatActionDetails(action, captureResult.scaleFactor, captureResult.displayScaleFactor),
          startedAt,
        }),
      };
    }
  }
} else if (screenChanged || validation.confidence === 'high') {
  noProgressLowConfidenceCount = 0;  // リセット
}
```

**3. Claude応答テキストからの失敗検出**:
- Claudeの応答テキストに「見つからない」「not found」「存在しない」等のキーワードが含まれる場合、`element_not_found`の可能性を警告
- ただし、Claude応答のみに依存せず、上記の複合判定と組み合わせる

#### ★★★ v12追加: 画面変化判定のノイズ耐性 ★★★

**問題点**: 現在の`hashScreenshot`は単純なサンプリングベースのハッシュで、以下のノイズに対して脆弱:
- 時計表示の更新
- カーソルの点滅
- アニメーション（ローディングスピナー等）
- 動的な広告やバナー

これにより、実際には意味のある画面変化がないにもかかわらず「変化あり」と誤判定される恐れがある。

**解決策**: 以下の多層的なノイズ耐性戦略を採用:

**1. 差分しきい値の導入**:
```typescript
/**
 * 画面変化を判定（ノイズ耐性版）
 * 単純なハッシュ一致ではなく、差分率に基づく判定
 */
export interface ScreenChangeDetectionConfig {
  minChangeRatioForProgress: number;  // 進捗とみなす最小変化率（デフォルト: 0.05 = 5%）
  noiseToleranceRatio: number;        // ノイズとして許容する変化率（デフォルト: 0.02 = 2%）
}

export const DEFAULT_SCREEN_CHANGE_CONFIG: ScreenChangeDetectionConfig = {
  minChangeRatioForProgress: 0.05,  // 5%以上の変化で進捗あり
  noiseToleranceRatio: 0.02,        // 2%以下の変化はノイズ
};

/**
 * 2つのスクリーンショットの差分率を計算
 * Base64データの長さ比較による簡易実装（将来的にはピクセルレベル比較に拡張可能）
 */
export function calculateScreenDiffRatio(
  base64A: string,
  base64B: string
): number {
  // サンプリングポイントでの差分を計算
  const sampleSize = 5000;  // サンプル数
  const step = Math.floor(Math.max(base64A.length, base64B.length) / sampleSize);

  let diffCount = 0;
  const minLen = Math.min(base64A.length, base64B.length);

  for (let i = 0; i < minLen; i += step) {
    if (base64A[i] !== base64B[i]) {
      diffCount++;
    }
  }

  // 長さの差も考慮
  const lenDiff = Math.abs(base64A.length - base64B.length);
  const totalSamples = sampleSize + (lenDiff > 0 ? sampleSize * 0.1 : 0);

  return diffCount / totalSamples;
}

/**
 * 意味のある画面変化があったかを判定
 */
export function hasSignificantScreenChange(
  previousBase64: string,
  currentBase64: string,
  config: ScreenChangeDetectionConfig = DEFAULT_SCREEN_CHANGE_CONFIG
): { changed: boolean; diffRatio: number; isNoise: boolean } {
  const diffRatio = calculateScreenDiffRatio(previousBase64, currentBase64);

  const isNoise = diffRatio <= config.noiseToleranceRatio;
  const changed = diffRatio >= config.minChangeRatioForProgress;

  return {
    changed,
    diffRatio,
    isNoise,
  };
}
```

**2. 動的領域マスクの概念**（将来的な拡張）:
- 時計表示、ステータスバー等の動的領域を除外
- 実装コストが高いため、初期実装では差分しきい値で対応
- 必要に応じて段階的に導入

**3. 連続変化パターンの検出**:
```typescript
// ノイズ（常に変化）vs 意味のある変化を区別
interface ScreenChangeHistory {
  diffRatios: number[];  // 直近N回の差分率
  timestamps: number[];
}

/**
 * 連続した微小変化をノイズとして判定
 * 例: 5回連続で0.01-0.02の差分 → ノイズ（時計/カーソル）
 */
function isConsistentNoise(history: ScreenChangeHistory): boolean {
  if (history.diffRatios.length < 3) return false;

  const recentDiffs = history.diffRatios.slice(-5);
  const avgDiff = recentDiffs.reduce((a, b) => a + b, 0) / recentDiffs.length;
  const variance = recentDiffs.reduce((sum, d) => sum + Math.pow(d - avgDiff, 2), 0) / recentDiffs.length;

  // 平均差分が小さく、分散も小さい → 一貫したノイズ
  return avgDiff < 0.03 && variance < 0.0001;
}
```

**4. agentLoop.tsでの適用**:
```typescript
// 従来のハッシュ比較を差分率判定に置き換え
const screenChangeResult = hasSignificantScreenChange(
  previousScreenshotBase64,
  captureResult.imageBase64
);

const screenChanged = screenChangeResult.changed && !screenChangeResult.isNoise;

if (screenChangeResult.isNoise) {
  log(`[Agent Loop] Screen change detected but classified as noise (diff ratio: ${screenChangeResult.diffRatio.toFixed(4)})`);
}

// validateActionAndCheckProgressには意味のある変化のみを渡す
const validation = validateActionAndCheckProgress(
  action,
  expectedActions,
  completedActionIndex,
  lastClaudeResponseText,
  screenChanged  // ノイズを除外した変化フラグ
);
```

#### ★★★ v12追加: stopped/aborted保持の分岐方針 ★★★

**問題点**: 現在の計画書Phase 6ステップ6.3では、`result.testResult.status === 'success'`のみで判定しており、既存の`stopped`ステータスが失われる。

**解決策**: `TestResultStatus`に基づく適切なステータスマッピングを追加:

```typescript
// scenarioRunner.ts - executeScenario内でTestResultをScenarioに保存（v12更新）
private async executeScenario(
  scenario: Scenario,
  options: ScenarioRunnerOptions
): Promise<void> {
  // ...既存のコード...

  try {
    const result: AgentLoopResult = await runAgentLoop({
      // ...
    });

    // TestResultをScenarioに保存
    scenario.result = result.testResult;

    // ★★★ v12更新: TestResultStatusに基づく適切なScenarioStatusマッピング ★★★
    // success → completed, stopped → stopped, その他 → failed
    scenario.status = mapTestResultStatusToScenarioStatus(result.testResult.status);

    scenario.error = result.testResult.failureDetails;
    scenario.iterations = result.iterations;
    scenario.completedAt = new Date();

    this.log(
      `[Scenario Runner] Scenario ${scenario.result.status}: ${scenario.title} - ${scenario.result.claudeAnalysis || scenario.result.failureDetails || ''}`
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      // ★★★ v12追加: AbortErrorの場合はstoppedステータスを維持 ★★★
      scenario.status = 'stopped';
      scenario.result = createTestResult({
        status: 'stopped',
        failureReason: 'aborted',
        failureDetails: 'Scenario aborted by user',
        completedSteps: scenario.iterations || 0,
        completedActionIndex: 0,  // 不明な場合は0
        startedAt: scenario.startedAt || new Date(),
      });
    } else {
      scenario.status = 'failed';
      scenario.error = error instanceof Error ? error.message : String(error);
    }
    scenario.completedAt = new Date();
  }

  this.notifyStateChange();
}

/**
 * TestResultStatusをScenarioStatusにマッピング
 * ★v12追加: stopped/error等の細かいステータスを適切に保持
 */
function mapTestResultStatusToScenarioStatus(
  testStatus: TestResultStatus
): ScenarioStatus {
  switch (testStatus) {
    case 'success':
      return 'completed';
    case 'stopped':
      return 'stopped';  // ★v12: stoppedを保持
    case 'failure':
    case 'timeout':
    case 'error':
    default:
      return 'failed';
  }
}
```

**UIでの表示対応**:
- `stopped`ステータスのシナリオは「Stopped」として表示（既存のApp.vue:121-122行で対応済み）
- サマリーでは`stopped`も「Failed」カウントに含める（意図通りに完了していないため）
- ただし詳細表示では`stopped`アイコン（⏹）と「ユーザーによる停止」の理由を区別表示

#### ★★★ v13追加: 非プログレッシブアクションのキーワード抽出必須化 ★★★

**問題点（フィードバック対応）**: `EXTRACT_ACTIONS_PROMPT`では`expectedToolAction`に「click, type, scroll など」と記載しているが、`wait/screenshot/mouse_move/scroll`など非プログレッシブアクションについてはキーワード抽出の指示が不足している。そのため、これらのアクションでは`keywords`が空になりやすく、`actionType`一致だけでは`shouldAdvanceIndex=false`のまま進捗が進まない可能性がある。

**解決策（二段階）**:

**1. 非プログレッシブアクションは`actionType`厳密一致のみで高信頼扱いに変更**:
```typescript
// validateActionAndCheckProgress内での変更（v13追加）
const isNonProgressiveAction = nonProgressiveActions.includes(toolAction.action);

// ★★★ v13追加: 非プログレッシブアクションの特別処理 ★★★
// wait/screenshot/mouse_move/scrollはキーワードマッチなしでも、
// actionType厳密一致があれば高信頼扱いとする
if (isNonProgressiveAction && actionTypeStrictMatch) {
  // 非プログレッシブアクションはactionType厳密一致のみで高信頼
  // 画面変化は期待しないためrequiresScreenChange = false
  return {
    isValid: true,
    shouldAdvanceIndex: true,  // ★v13: 非プログレッシブは画面変化なしでも進行可能
    confidence: 'high',
    needsClaudeVerification: false,
    requiresScreenChange: false,  // 画面変化を要求しない
    expectsSubtleChange: false,
  };
}
```

**2. `EXTRACT_ACTIONS_PROMPT`を更新し、非プログレッシブアクション用のキーワードを必須化**:
```typescript
const EXTRACT_ACTIONS_PROMPT = `
ユーザーのテストシナリオを分析し、期待されるアクション列をJSON形式で抽出してください。

出力形式:
{
  "expectedActions": [
    {
      "description": "アクションの説明（例: Chromeアイコンをクリック）",
      "keywords": ["関連キーワード1", "関連キーワード2"],
      "targetElements": ["対象要素名1", "対象要素名2"],
      "expectedToolAction": "期待されるアクション種別（click, type, scroll, wait など）"
    }
  ]
}

注意:
- 各アクションは実行順に並べてください
- keywordsには画面上で探すべき要素名やアプリ名を含めてください
- targetElementsには具体的なUI要素名を含めてください
- expectedToolActionは: left_click, double_click, type, key, scroll, wait, screenshot, mouse_move のいずれか
- ★★★ v13追加: 待機/スクロール/スクリーンショット等のアクションでもkeywordsを必須で抽出してください
  - wait: ["待機", "wait", "数秒"] など操作の目的を示すキーワード
  - scroll: ["スクロール", "下", "上", 対象の画面要素名] など
  - screenshot: ["スクリーンショット", "キャプチャ", "画面"] など
`;
```

#### ★★★ v13追加: element_not_found昇格ロジックの非プログレッシブ対応 ★★★

**問題点（フィードバック対応）**: 現在の`element_not_found`昇格ロジック（`!screenChanged && low/medium`）は、非プログレッシブ/微小変化アクションでもカウントが進むため、正常な待機・スクロールで誤って失敗判定になり得る。

**解決策**: `requiresScreenChange`がtrueのアクションのときのみカウントする。非プログレッシブアクションや`expectsSubtleChange`がtrueの場合はスキップまたはリセットする。

```typescript
// agentLoop.ts内での実装（v13更新）
const ELEMENT_NOT_FOUND_THRESHOLD = 5;  // 画面変化なし＋低信頼連続の閾値
let noProgressLowConfidenceCount = 0;

// 各イテレーションで
// ★★★ v13更新: 非プログレッシブアクションや微小変化アクションはカウント対象外 ★★★
const isNonProgressiveAction = ['wait', 'screenshot', 'mouse_move', 'scroll'].includes(action.action);
const expectsSubtleChange = ['left_click', 'triple_click'].includes(action.action);

if (!screenChanged &&
    (validation.confidence === 'low' || validation.confidence === 'medium') &&
    validation.requiresScreenChange &&  // ★v13追加: 画面変化を要求するアクションのみ
    !isNonProgressiveAction &&           // ★v13追加: 非プログレッシブはスキップ
    !expectsSubtleChange) {              // ★v13追加: 微小変化もスキップ
  noProgressLowConfidenceCount++;

  if (noProgressLowConfidenceCount >= ELEMENT_NOT_FOUND_THRESHOLD) {
    // 画面変化なし＋低信頼が続いている → element_not_foundの可能性が高い
    log(`[Agent Loop] No screen change + low confidence for ${noProgressLowConfidenceCount} iterations - treating as element_not_found`);

    // targetElements検証を実行
    const verificationResult = await verifyTargetElementsPresence(
      expectedActions[completedActionIndex],
      captureResult.imageBase64
    );

    if (!verificationResult.found) {
      return {
        success: false,
        error: `Element not found: ${verificationResult.missingElements?.join(', ') || 'unknown'}`,
        iterations: iteration,
        testResult: createTestResult({
          status: 'failure',
          failureReason: 'element_not_found',
          failureDetails: `Expected elements not found: ${verificationResult.missingElements?.join(', ')}`,
          // ...
        }),
      };
    }
  }
} else if (screenChanged || validation.confidence === 'high' || isNonProgressiveAction || expectsSubtleChange) {
  // ★v13更新: 非プログレッシブ/微小変化アクションでもリセット
  noProgressLowConfidenceCount = 0;  // リセット
}
```

#### ★★★ v13追加: 連接語ベースのステップ数ヒューリスティック ★★★

**問題点（フィードバック対応）**: 現在の`validateExpectedActionsCount`は行数・明示的なステップ数ヒント（「3ステップ」等）に依存するため、1行で複数手順を書いたシナリオ（例:「Chromeを開いて、アドレスバーにURLを入力して、Enterを押す」）の抽出漏れを検知できず、早期成功で未完了が成功扱いになり得る。

**解決策（二段階）**:

**1. 連接語ベースの簡易ヒューリスティックを追加**:
```typescript
/**
 * シナリオ文からステップ数のヒントを抽出（v13更新版）
 * ★v13追加: 連接語ベースのヒューリスティックを追加
 */
function extractStepCountHint(scenario: string): number | null {
  // 既存: 明示的なステップ数表現
  const explicitPatterns = [
    /(\d+)\s*(?:ステップ|steps?|操作|アクション)/i,
    /(?:以下の|次の)\s*(\d+)\s*(?:つ|個)/,
  ];

  for (const pattern of explicitPatterns) {
    const match = scenario.match(pattern);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  // 既存: 番号付きリスト
  const numberedListMatches = scenario.match(/^\s*\d+[\.\)]/gm);
  if (numberedListMatches && numberedListMatches.length >= 2) {
    return numberedListMatches.length;
  }

  // ★★★ v13追加: 連接語ベースのヒューリスティック ★★★
  // 「次に/そして/後に/and/then/、」などの連接語で複数手順を検出
  const conjunctionPatterns = [
    // 日本語連接語
    /(?:次に|そして|その後|後に|続けて|さらに|また)/g,
    // 英語連接語
    /\b(?:then|and then|after that|next|finally)\b/gi,
    // 句読点による区切り（日本語の「、」で区切られた動詞句）
    /[、,](?=.*(クリック|入力|開く|閉じる|押す|選択|待|スクロール|click|type|open|close|press|select|wait|scroll))/gi,
  ];

  let conjunctionCount = 0;
  for (const pattern of conjunctionPatterns) {
    const matches = scenario.match(pattern);
    if (matches) {
      conjunctionCount += matches.length;
    }
  }

  // 連接語が見つかった場合、最低でも連接語数+1のステップを期待
  if (conjunctionCount > 0) {
    return conjunctionCount + 1;
  }

  return null;
}
```

**2. 妥当性が弱い場合は`tool_use`停止＋Claude成功JSONの両方を必須条件に**:
現在のv9ルール（`!validation.isValid`の場合は`tool_use`停止＋Claude成功JSON＋エラー/スタックなしを要求）は維持し、連接語ベースのヒューリスティックで検出精度を向上させる。

```typescript
/**
 * 期待アクション列の妥当性を検証（v13更新版）
 */
function validateExpectedActionsCount(
  expectedActions: ExpectedAction[],
  scenario: string
): { isValid: boolean; warning?: string; suggestedMinimum?: number } {
  const stepCountHint = extractStepCountHint(scenario);  // ★v13: 連接語ベースも含む

  // シナリオが複数行なら最低2件を期待
  const lineCount = scenario.split('\n').filter(line => line.trim().length > 0).length;
  const suggestedMinimum = Math.max(lineCount > 1 ? 2 : 1, stepCountHint || 1);

  if (expectedActions.length < suggestedMinimum) {
    return {
      isValid: false,
      warning: `Expected at least ${suggestedMinimum} actions based on scenario analysis, but got ${expectedActions.length}`,
      suggestedMinimum,
    };
  }

  // ステップ数ヒントとの乖離チェック（50%以上の乖離は警告）
  if (stepCountHint && expectedActions.length < stepCountHint * 0.5) {
    return {
      isValid: false,
      warning: `Scenario hints at ${stepCountHint} steps, but only ${expectedActions.length} actions extracted`,
      suggestedMinimum: stepCountHint,
    };
  }

  return { isValid: true };
}
```

#### ★★★ v14追加: フィードバック対応による改善 ★★★

**対応フィードバック（2件: 中1/低1）**:

1. **[重大度: 中]** `RESULT_SCHEMA_INSTRUCTION`の挿入箇所の明確化
   - **問題**: `beta.messages.create`に反映される具体的な手順が曖昧
   - **解決**: ステップ3.1.1を追加し、`system`パラメータを使用する方法（推奨）と初回メッセージ埋め込み（フォールバック）の2つの方法を明記
   - **変更箇所**: Phase 3にステップ3.1.1を新規追加

2. **[重大度: 低]** `scenario.status`更新パターンの混在解消
   - **問題**: ステップ6.3で`result.testResult.status === 'success' ? 'completed' : 'failed'`という直接比較が使われており、v12で定義した`mapTestResultStatusToScenarioStatus`関数と不整合
   - **解決**: ステップ6.3のサンプルコードを`mapTestResultStatusToScenarioStatus`使用に統一
   - **変更箇所**: ステップ6.3を更新

---

## 2. 影響範囲

### 2.1 変更が必要なファイル

| ファイル | 変更内容 | 理由 |
|----------|----------|------|
| `src/types/scenario.ts` | `TestResult`型の追加、`Scenario`型の拡張 | 成功/失敗の判定結果を保持するため |
| `src/types/action.ts` | `ActionExecutionStatus`型の追加、`AgentLoopConfig`の拡張 | 各アクションの実行結果を追跡するため |
| `src/services/agentLoop.ts` | **アクション実行エラーの即時評価、判定ロジックの実装、スタック検出の追加、全終了パスでのTestResult生成、checkProgress呼び出し、★v14: `callClaudeAPI`で`system`パラメータに`RESULT_SCHEMA_INSTRUCTION`を追加、★v17: フォールバック時のadditionalConfirmation生成・受け渡しフロー** | 成功/失敗判定の中核ロジック |
| `src/services/claudeClient.ts` | **結果スキーマを強制するシステムプロンプト(`RESULT_SCHEMA_INSTRUCTION`)の定義・エクスポート** | Claudeに構造化された結果出力を要求 |
| `src/services/scenarioParser.ts` | **変更なし**（期待アクション抽出は`actionValidator.ts`で実装） | シナリオ分割のみを担当 |
| `src/services/scenarioRunner.ts` | 結果の集約・保存 | シナリオ全体の結果をまとめる |
| `src/utils/loopDetector.ts` | スタック検出ロジックの追加 | 進捗がない状態を検出 |
| `src/App.vue` | 結果表示UIの改善 | 成功/失敗を視覚的に表示 |

### 2.2 新規作成が必要なファイル

| ファイル | 内容 |
|----------|------|
| `src/types/testResult.ts` | テスト結果に関する型定義 |
| `src/services/resultJudge.ts` | 結果判定ロジックのモジュール（★v17: `AdditionalConfirmation`インターフェース、`verifyFallbackCompletion`関数を含む） |
| `src/services/actionValidator.ts` | 期待アクション照合ロジック |

### 2.3 変更しないが影響を受ける可能性があるファイル

| ファイル | 影響内容 |
|----------|----------|
| `src/services/historyManager.ts` | 変更なし |
| `src/services/scenarioParser.ts` | **変更なし** - 期待アクション抽出は`actionValidator.ts`で実装。シナリオ分割のみを担当 |
| `src/types/index.ts` | 新しい型のre-export追加のみ |

---

## 3. 実装ステップ

### Phase 1: 型定義の追加

#### ステップ 1.1: テスト結果型の定義
**新規ファイル**: `src/types/testResult.ts`

```typescript
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
 * ★★★ v11更新: 重複していた理由コードを統合 ★★★
 * - `execution_error`を削除し、`action_execution_error`に統一
 *   （両者は意味が同一: アクション実行時のエラー）
 */
export type FailureReason =
  | 'element_not_found'     // 要素（アイコン、テキスト等）が見つからない
  | 'action_no_effect'      // アクション実行後も画面変化なし
  | 'action_execution_error'// アクション実行がエラーを返した（execution_errorを統合）
  | 'stuck_in_loop'         // 同じ状態でスタック（ループ検出閾値未満）
  | 'unexpected_state'      // 期待と異なる画面状態
  | 'action_mismatch'       // ユーザー期待アクションと不一致
  | 'incomplete_actions'    // 期待アクションが全て完了していない
  | 'invalid_result_format' // Claudeが結果スキーマに準拠しなかった（補助的理由）
  | 'max_iterations'        // 最大イテレーション到達
  | 'api_error'             // Claude API エラー
  | 'user_stopped'          // ユーザーによる停止
  | 'aborted'               // 中断された
  | 'unknown';              // 原因不明

/**
 * Detailed test result
 * ★★★ v11更新: lastScreenshotを削除 ★★★
 * 理由: セクション4.1で「最後のスクリーンショットはTestResultに保存しない（ログ容量削減）」
 *       と明記されており、型定義もこの方針に合わせる
 */
export interface TestResult {
  status: TestResultStatus;
  failureReason?: FailureReason;
  failureDetails?: string;      // 詳細なエラーメッセージ
  completedSteps: number;       // 完了したステップ数
  totalExpectedSteps?: number;  // 予想されるステップ数（判明している場合）
  completedActionIndex: number; // 完了した期待アクションのインデックス
  lastAction?: string;          // 最後に実行したアクション
  // lastScreenshot: 削除（ログ容量削減のため保存しない - セクション4.1参照）
  claudeAnalysis?: string;      // Claudeによる分析結果
  claudeResultOutput?: ClaudeResultOutput; // Claudeが返した構造化結果
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
}

/** Claudeが返すべき構造化結果スキーマ */
export interface ClaudeResultOutput {
  status: 'success' | 'failure' | 'in_progress';
  message: string;
  failureReason?: string;
  currentStep?: string;
  nextExpectedAction?: string;
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

/** ★v6追加: 保留中の高信頼マッチ（画面変化猶予ウィンドウ用） */
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
  completed: boolean;
}
```

#### ステップ 1.2: Scenario型の拡張
**対象ファイル**: `src/types/scenario.ts`

```typescript
// 既存の型に追加
export interface Scenario {
  id: number;
  title: string;
  description: string;
  status: ScenarioStatus;
  error?: string;
  iterations?: number;
  startedAt?: Date;
  completedAt?: Date;
  // 追加フィールド
  result?: TestResult;              // 詳細なテスト結果
  expectedActions?: ExpectedAction[]; // 期待アクション列
}
```

#### ステップ 1.3: index.tsへのエクスポート追加
**対象ファイル**: `src/types/index.ts`

```typescript
export * from './action';
export * from './capture';
export * from './scenario';
export * from './testResult';  // 追加
```

### Phase 2: アクション実行エラーの即時評価（重大度: 高 対応）

#### ステップ 2.1: agentLoop.tsの修正 - ツール実行エラーの即時失敗

**対象ファイル**: `src/services/agentLoop.ts`

現在のコードでは、`executeAction`が`{ success: false, error: "..." }`を返しても、単にtool_resultに文字列として報告するだけで処理が継続してしまう。これを修正し、アクション実行エラー時に即時終了する。

```typescript
// 追加するimport
import {
  analyzeClaudeResponse,
  checkProgress,
  createTestResult,
  hashScreenshot,
  createProgressTracker,
  DEFAULT_STUCK_DETECTION_CONFIG,
  type ProgressTracker,
} from './resultJudge';
import type { TestResult, FailureReason } from '../types';

// AgentLoopResultの拡張
export interface AgentLoopResult {
  success: boolean;
  error?: string;
  iterations: number;
  testResult: TestResult;  // 追加
}

// アクション実行エラーをFailureReasonにマッピング
function mapExecutionErrorToFailureReason(error: string): FailureReason {
  const errorLower = error.toLowerCase();

  // 要素未検出パターン
  if (errorLower.includes('not found') ||
      errorLower.includes('見つから') ||
      errorLower.includes('element') ||
      errorLower.includes('要素')) {
    return 'element_not_found';
  }

  // クリック失敗パターン
  if (errorLower.includes('click') ||
      errorLower.includes('クリック')) {
    return 'action_execution_error';
  }

  // 一般的な実行エラー（★v11: execution_errorをaction_execution_errorに統合）
  return 'action_execution_error';
}

// runAgentLoop関数内での変更（ツール実行後）
for (const toolUse of toolUseBlocks) {
  // ...アクション実行...
  const actionResult = await executeAction(action, captureResult.scaleFactor, captureResult.displayScaleFactor);

  // ★★★ 新規追加: アクション実行エラーの即時評価 ★★★
  if (!actionResult.success) {
    const failureReason = mapExecutionErrorToFailureReason(actionResult.error || 'Unknown error');

    log(`[Agent Loop] Action execution failed: ${actionResult.error}`);

    return {
      success: false,
      error: `Action execution failed: ${actionResult.error}`,
      iterations: iteration,
      testResult: createTestResult({
        status: 'failure',
        failureReason,
        failureDetails: actionResult.error,
        completedSteps: iteration,
        completedActionIndex,
        lastAction: formatActionDetails(action, captureResult.scaleFactor, captureResult.displayScaleFactor),
        startedAt,
      }),
    };
  }

  // ...以降の処理...
}
```

### Phase 3: Claude結果スキーマの強制（改善版: フィードバック3対応）

#### ステップ 3.1: claudeClient.tsの修正 - 結果スキーマを要求するプロンプト

**対象ファイル**: `src/services/claudeClient.ts`

Claudeに構造化された結果出力を要求するシステムプロンプトを追加する。

```typescript
/**
 * シナリオ完了判定用のシステムプロンプト
 * Claudeに結果をJSON形式で出力することを要求
 */
export const RESULT_SCHEMA_INSTRUCTION = `
重要: シナリオの実行が完了（成功または失敗）した場合、必ず以下のJSON形式で結果を報告してください。
このJSONは必ずテキスト応答の最後に含めてください。

シナリオが正常に完了した場合:
\`\`\`json
{"status": "success", "message": "シナリオが正常に完了しました"}
\`\`\`

シナリオが失敗した場合（要素が見つからない、操作できないなど）:
\`\`\`json
{"status": "failure", "message": "失敗の詳細説明", "failureReason": "要素が見つからない|操作が効果なし|予期しない画面|その他"}
\`\`\`

まだ進行中の場合は、このJSONを含めずに次のアクションを実行してください。
`;

// buildComputerTool関数を拡張、またはagentLoop内で使用するシステムプロンプトを追加
```

#### ★★★ ステップ 3.1.1: RESULT_SCHEMA_INSTRUCTIONの適用箇所（v14追加: フィードバック対応） ★★★

**【重要】** `RESULT_SCHEMA_INSTRUCTION`をClaude APIに確実に反映させるため、以下の2つの方法のいずれかを選択する。

**方法A: `system`パラメータを使用（推奨）**

`beta.messages.create`呼び出し時に`system`パラメータとして追加する。これにより、全ての会話ターンで一貫してシステムプロンプトが適用される。

**対象ファイル**: `src/services/agentLoop.ts` - `callClaudeAPI`関数

```typescript
// callClaudeAPI関数の修正
import { RESULT_SCHEMA_INSTRUCTION } from './claudeClient';  // インポート追加

async function callClaudeAPI(
  messages: BetaMessageParam[],
  captureResult: CaptureResult,
  abortSignal: AbortSignal,
  modelConfig: ClaudeModelConfig
): Promise<BetaMessage | null> {
  // ...既存のセットアップ...

  const apiPromise = client.beta.messages.create({
    model: modelConfig.model,
    max_tokens: 4096,
    system: RESULT_SCHEMA_INSTRUCTION,  // ★★★ システムプロンプトとして追加 ★★★
    tools: [buildComputerTool(captureResult, modelConfig)] as unknown as Parameters<typeof client.beta.messages.create>[0]['tools'],
    messages,
    betas: [modelConfig.betaHeader],
  });

  // ...以降は既存コード...
}
```

**方法B: 初回ユーザーメッセージへの埋め込み（フォールバック）**

`beta.messages.create`で`system`パラメータがサポートされていない場合、または動作しない場合は、初回ユーザーメッセージにシナリオ説明と一緒に埋め込む（ステップ3.3参照）。

**推奨**: まず方法Aを実装し、`system`パラメータが正しく機能することを確認する。機能しない場合は方法Bにフォールバックする。

**注意**: Computer Use API (`beta.messages.create` with `betas: ['computer-use-2024-10-22']`等) では`system`パラメータの挙動がドキュメントと異なる場合がある。実装時に動作確認を行い、JSONが返却されない場合は方法Bに切り替える。

#### ステップ 3.2: agentLoop.tsの修正 - 結果スキーマの解析（フォールバック対応版）

**対象ファイル**: `src/services/agentLoop.ts`

**重要**: JSON未返却時は期待アクション進捗に基づくフォールバック判定を行う

```typescript
/** Claudeの応答から結果JSONを抽出 */
function extractResultJson(responseText: string): ClaudeResultOutput | null {
  // ```json ... ``` パターンを検索
  const jsonMatch = responseText.match(/```json\s*(\{[\s\S]*?"status"\s*:\s*"(?:success|failure)"[\s\S]*?\})\s*```/);

  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    if (parsed.status === 'success' || parsed.status === 'failure') {
      return parsed as ClaudeResultOutput;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * 結果判定を強化したanalyzeClaudeResponse（フォールバック対応版 v3）
 * 【重要】
 * - 新規フィードバック1対応: JSON採用前に期待アクション完了を検証
 * - フィードバック3対応: JSON未返却時は期待アクション進捗に基づく判定にフォールバック
 * - ★★★ 新規フィードバック3対応: isFromFallbackフラグでフォールバック時のClaude成功採用を許可 ★★★
 */
export function analyzeClaudeResponse(
  response: BetaMessage,
  expectedActions: ExpectedAction[],
  completedActionIndex: number,
  isFromFallback: boolean = false  // ★★★ 新規フィードバック3対応: フォールバック使用フラグ ★★★
): {
  isComplete: boolean;
  isSuccess: boolean;
  analysis: string;
  resultOutput?: ClaudeResultOutput;
  failureReason?: FailureReason;
  successByProgress: boolean;  // 進捗ベースの成功判定かどうか
  shouldContinue: boolean;     // 継続すべきか（JSONがsuccessでも期待アクション未完了の場合）
} {
  const textBlocks = response.content.filter(
    (block): block is BetaTextBlock => block.type === 'text'
  );

  const fullText = textBlocks.map(b => b.text).join('\n');
  const hasToolUse = response.content.some(block => block.type === 'tool_use');

  // 結果JSONの抽出を試みる
  const resultOutput = extractResultJson(fullText);

  // 期待アクション完了状態の判定
  const allExpectedActionsCompleted = expectedActions.length > 0 &&
                                      completedActionIndex >= expectedActions.length;

  if (resultOutput) {
    // ★★★ 新規フィードバック1対応: JSON採用前に期待アクション完了を検証 ★★★
    if (resultOutput.status === 'success') {
      // Claudeが成功を報告した場合でも、期待アクション完了をチェック
      if (allExpectedActionsCompleted) {
        // 期待アクションも全て完了 → 真の成功
        return {
          isComplete: true,
          isSuccess: true,
          analysis: resultOutput.message,
          resultOutput,
          successByProgress: false,
          shouldContinue: false,
        };
      } else if (expectedActions.length === 0) {
        // 期待アクションが抽出できなかった場合 → Claudeの判定を信頼
        console.warn('[Result Judge] No expected actions extracted - trusting Claude success report');
        return {
          isComplete: true,
          isSuccess: true,
          analysis: resultOutput.message,
          resultOutput,
          successByProgress: false,
          shouldContinue: false,
        };
      } else if (isFromFallback) {
        // ★★★ 新規フィードバック3対応: フォールバック使用時はClaude成功報告を採用 ★★★
        // フォールバック時は期待アクションが1つ（シナリオ全体）しかないため、
        // completedActionIndexのチェックが厳密に機能しない
        // Claude成功報告を信頼する
        console.warn('[Result Judge] Fallback mode - trusting Claude success report');
        return {
          isComplete: true,
          isSuccess: true,
          analysis: resultOutput.message,
          resultOutput,
          successByProgress: false,
          shouldContinue: false,
        };
      } else {
        // ★★★ 期待アクション未完了 → 成功として受け入れず継続/失敗 ★★★
        console.warn(`[Result Judge] Claude reported success but only ${completedActionIndex}/${expectedActions.length} expected actions completed`);

        // tool_useがまだある場合は継続を許可
        if (hasToolUse) {
          return {
            isComplete: false,
            isSuccess: false,
            analysis: `Claude reported success but expected actions incomplete (${completedActionIndex}/${expectedActions.length})`,
            resultOutput,
            successByProgress: false,
            shouldContinue: true,  // ★継続を指示
          };
        }

        // tool_useがない場合は失敗として終了
        return {
          isComplete: true,
          isSuccess: false,
          analysis: `Claude reported success but expected actions incomplete (${completedActionIndex}/${expectedActions.length})`,
          resultOutput,
          failureReason: 'incomplete_actions',
          successByProgress: false,
          shouldContinue: false,
        };
      }
    } else {
      // ★★★ v16更新: Claudeが失敗を報告した場合でも進捗と突合（フィードバック: 重大度中） ★★★
      // Claude失敗報告を即採用せず、期待アクション完了状況と突合する

      // 期待アクションが全て完了している場合は、Claudeの失敗報告より進捗を優先
      if (allExpectedActionsCompleted) {
        console.warn(`[Result Judge] Claude reported failure but all expected actions completed (${completedActionIndex}/${expectedActions.length})`);
        console.log('[Result Judge] Overriding Claude failure with progress-based success');
        return {
          isComplete: true,
          isSuccess: true,
          analysis: `All expected actions completed despite Claude failure report: ${resultOutput.message}`,
          resultOutput,
          successByProgress: true,
          shouldContinue: false,
        };
      }

      // 期待アクションが未完了の場合は、Claudeの失敗報告を採用
      return {
        isComplete: true,
        isSuccess: false,
        analysis: resultOutput.message,
        resultOutput,
        failureReason: mapClaudeFailureReason(resultOutput.failureReason),
        successByProgress: false,
        shouldContinue: false,
      };
    }
  }

  // tool_useがない = 完了判定が必要
  const isComplete = !hasToolUse;

  if (isComplete) {
    // ★★★ v7追加: フォールバック時のJSON欠如特別対応（v6-2の明示実装） ★★★
    // フィードバック対応: この分岐がPhase 3本体に明示されていなかった問題を修正
    if (isFromFallback && !resultOutput) {
      // フォールバック時はJSONが無くても、tool_useが止まり
      // エラー/スタックが検出されていなければ成功とみなす
      console.log('[Result Judge] Fallback mode: no JSON, no tool_use, treating as success');
      return {
        isComplete: true,
        isSuccess: true,
        analysis: textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text : 'Scenario completed (fallback mode)',
        successByProgress: true,
        shouldContinue: false,
      };
    }

    // ★★★ フィードバック3対応: 期待アクション進捗に基づくフォールバック ★★★
    console.warn('[Result Judge] Claude did not provide structured result output - using progress-based fallback');

    // 期待アクションが全て完了している場合は成功
    if (allExpectedActionsCompleted) {
      console.log('[Result Judge] All expected actions completed - treating as success');
      return {
        isComplete: true,
        isSuccess: true,
        analysis: textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text : 'All expected actions completed',
        successByProgress: true,
        shouldContinue: false,
      };
    }

    // 期待アクションが抽出されていない場合、または未完了の場合
    // JSON欠如は補助的な失敗理由として記録
    return {
      isComplete: true,
      isSuccess: false,
      analysis: textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text : 'No analysis provided',
      failureReason: expectedActions.length === 0 ? 'invalid_result_format' : 'incomplete_actions',
      successByProgress: false,
      shouldContinue: false,
    };
  }

  return {
    isComplete: false,
    isSuccess: false,
    analysis: '',
    successByProgress: false,
    shouldContinue: false,
  };
}

/**
 * Claudeの失敗理由をFailureReasonにマッピング
 */
function mapClaudeFailureReason(claudeReason?: string): FailureReason {
  if (!claudeReason) return 'unknown';

  const reasonLower = claudeReason.toLowerCase();

  if (reasonLower.includes('見つから') || reasonLower.includes('not found')) {
    return 'element_not_found';
  }
  if (reasonLower.includes('効果なし') || reasonLower.includes('no effect')) {
    return 'action_no_effect';
  }
  if (reasonLower.includes('予期しない') || reasonLower.includes('unexpected')) {
    return 'unexpected_state';
  }

  return 'unknown';
}
```

#### ステップ 3.3: 初回メッセージにシステムプロンプトを追加

**対象ファイル**: `src/services/agentLoop.ts`

```typescript
// Initial message with scenario description, screenshot, and result schema instruction
messages = [
  {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `${options.scenario.description}\n\n${RESULT_SCHEMA_INSTRUCTION}`
      },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: captureResult.imageBase64,
        },
      },
    ],
  },
];
```

### Phase 4: 期待アクション照合（改善版: フィードバック1対応）

#### ステップ 4.1: 期待アクション抽出モジュールの作成（フォールバック対応）

**新規ファイル**: `src/services/actionValidator.ts`

**重要**: フィードバック4対応 - 抽出失敗時の代替ルールを追加

```typescript
/**
 * Action Validator - 期待アクションとClaudeのtool_useを照合
 */

import { getClaudeClient } from './claudeClient';
import type { ExpectedAction, ComputerAction, ProgressTracker } from '../types';
import { DEFAULT_CLAUDE_MODEL_CONFIG } from '../types';
import { hashAction } from '../utils/loopDetector';

/** シナリオから期待アクション列を抽出するためのプロンプト */
const EXTRACT_ACTIONS_PROMPT = `
ユーザーのテストシナリオを分析し、期待されるアクション列をJSON形式で抽出してください。

出力形式:
{
  "expectedActions": [
    {
      "description": "アクションの説明（例: Chromeアイコンをクリック）",
      "keywords": ["関連キーワード1", "関連キーワード2"],
      "targetElements": ["対象要素名1", "対象要素名2"],
      "expectedToolAction": "期待されるアクション種別（click, type, scroll など）"
    }
  ]
}

注意:
- 各アクションは実行順に並べてください
- keywordsには画面上で探すべき要素名やアプリ名を含めてください
- targetElementsには具体的なUI要素名を含めてください（例: "Chromeアイコン", "アドレスバー", "検索ボックス"）
- expectedToolActionは: left_click, double_click, type, key, scroll, wait のいずれか
`;

/** extractExpectedActionsの戻り値型 */
export interface ExtractExpectedActionsResult {
  expectedActions: ExpectedAction[];
  isFromFallback: boolean;  // ★★★ 新規フィードバック3対応: フォールバック使用フラグ ★★★
}

/**
 * シナリオから期待アクション列を抽出
 * ★★★ フィードバック4対応: 失敗時はシナリオ全体を1つの期待アクションとして返す ★★★
 * ★★★ 新規フィードバック3対応: 戻り値にisFromFallbackフラグを追加 ★★★
 */
export async function extractExpectedActions(scenarioDescription: string): Promise<ExtractExpectedActionsResult> {
  try {
    const client = await getClaudeClient();

    // ★★★ 新規フィードバック5対応: visionモデル（Sonnet）を使用 ★★★
    // この関数も画像を使用しないテキスト処理のみなので、通常APIで十分
    const EXTRACTION_MODEL = 'claude-sonnet-4-20250514';

    const response = await client.messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 1024,
      system: EXTRACT_ACTIONS_PROMPT,
      messages: [{ role: 'user', content: scenarioDescription }],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type');
    }

    // JSONを抽出
    let jsonText = content.text.trim();
    const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonText = jsonMatch[1].trim();
    }

    const result = JSON.parse(jsonText);

    if (!result.expectedActions || result.expectedActions.length === 0) {
      throw new Error('No expected actions extracted');
    }

    return {
      expectedActions: (result.expectedActions || []).map((a: ExpectedAction) => ({
        ...a,
        completed: false,
      })),
      isFromFallback: false,  // 正常抽出
    };
  } catch (error) {
    console.warn('Failed to extract expected actions, using fallback:', error);

    // ★★★ フィードバック4対応 + 新規フィードバック3対応: フォールバック ★★★
    return {
      expectedActions: [{
        description: scenarioDescription,
        keywords: extractBasicKeywords(scenarioDescription),
        targetElements: [],
        expectedToolAction: undefined,
        completed: false,
      }],
      isFromFallback: true,  // フォールバック使用
    };
  }
}

/**
 * シナリオからキーワードを簡易抽出（フォールバック用）
 */
function extractBasicKeywords(scenario: string): string[] {
  // アプリ名や操作名を抽出する簡易実装
  const keywords: string[] = [];

  // 一般的なアプリ名
  const appNames = ['chrome', 'safari', 'firefox', 'vscode', 'terminal', 'finder', 'メモ帳', 'notepad'];
  for (const app of appNames) {
    if (scenario.toLowerCase().includes(app.toLowerCase())) {
      keywords.push(app);
    }
  }

  // 操作キーワード
  const actionKeywords = ['クリック', 'click', '入力', 'type', '開く', 'open', '起動', '検索', 'search'];
  for (const kw of actionKeywords) {
    if (scenario.toLowerCase().includes(kw.toLowerCase())) {
      keywords.push(kw);
    }
  }

  return keywords;
}

/**
 * Claudeのtool_useが期待アクションと一致するかをチェック（改善版 v3）
 * ★★★ フィードバック1対応: 高信頼マッチ時のみtrue、それ以外はアクションを消費しない ★★★
 * ★★★ 新規フィードバック2対応: クリック系アクションの照合を改善 ★★★
 * ★★★ v5対応: 画面変化を必須条件として組み込み（screenChangedパラメータ追加） ★★★
 */
export function validateActionAndCheckProgress(
  toolAction: ComputerAction,
  expectedActions: ExpectedAction[],
  currentIndex: number,
  claudeResponseContext?: string,  // 直前のClaude応答テキスト（コンテキスト照合用）
  screenChanged?: boolean  // ★★★ v5追加: アクション実行後に画面変化があったか ★★★
): {
  isValid: boolean;
  shouldAdvanceIndex: boolean;  // インデックスを進めるべきか（★v5: 画面変化が必須条件）
  reason?: string;
  confidence: 'high' | 'medium' | 'low';
  needsClaudeVerification: boolean;  // Claude視覚検証が必要か
  requiresScreenChange: boolean;  // ★★★ v5追加: 画面変化が必要とされる判定だったか ★★★
  expectsSubtleChange?: boolean;  // ★★★ v10追加（重大度:中対応）: 微小変化フラグ ★★★
} {
  if (expectedActions.length === 0) {
    // 期待アクションが抽出されていない場合は検証をスキップ
    return { isValid: true, shouldAdvanceIndex: false, confidence: 'low', needsClaudeVerification: false, requiresScreenChange: false };
  }

  if (currentIndex >= expectedActions.length) {
    // 期待以上のアクションが実行された（追加アクションは許容）
    return { isValid: true, shouldAdvanceIndex: false, confidence: 'medium', needsClaudeVerification: false, requiresScreenChange: false };
  }

  const expected = expectedActions[currentIndex];
  const actionType = toolAction.action;

  // ★★★ 新規フィードバック2対応: クリック系かどうかを判定 ★★★
  const isClickAction = actionType.includes('click') ||
                        actionType === 'mouse_move' ||
                        actionType === 'left_mouse_down' ||
                        actionType === 'left_mouse_up' ||
                        actionType === 'left_click_drag';

  // 1. キーワード/テキストのチェック（高信頼度判定の主要要素）
  // ★★★ 新規フィードバック2対応: クリック系はtextが空なので別の照合方法を使用 ★★★
  let keywordMatchCount = 0;

  if (expected.keywords && expected.keywords.length > 0) {
    if (toolAction.text) {
      // type/keyアクション: テキスト内のキーワードマッチ
      const textLower = toolAction.text.toLowerCase();
      keywordMatchCount = expected.keywords.filter(
        kw => textLower.includes(kw.toLowerCase())
      ).length;
    } else if (claudeResponseContext) {
      // ★★★ クリック系: 直前のClaude応答テキストからコンテキストを取得 ★★★
      // Claudeは通常「○○をクリックします」のようなテキストを返すため、それを照合
      const contextLower = claudeResponseContext.toLowerCase();
      keywordMatchCount = expected.keywords.filter(
        kw => contextLower.includes(kw.toLowerCase())
      ).length;
    }
  }

  // 2. targetElementsとの照合（クリック系で有効）
  let targetElementMatchCount = 0;
  if (expected.targetElements && expected.targetElements.length > 0 && claudeResponseContext) {
    const contextLower = claudeResponseContext.toLowerCase();
    targetElementMatchCount = expected.targetElements.filter(
      el => contextLower.includes(el.toLowerCase())
    ).length;
  }

  // 3. アクション種別のチェック（★★★ v5改善: 厳密一致対応 ★★★）
  let actionTypeMatches = false;
  let actionTypeStrictMatch = false;  // ★★★ v5追加: 厳密一致フラグ ★★★
  if (expected.expectedToolAction) {
    const expectedType = expected.expectedToolAction.toLowerCase();
    const actualType = actionType.toLowerCase();

    // ★★★ v5改善: 具体的なアクション種別が指定されている場合は厳密一致 ★★★
    // 「汎用click」（expectedToolAction === 'click'）の場合のみ緩和マッチを許可
    const isGenericClick = expectedType === 'click';  // 汎用クリック指定
    const isClickExpected = expectedType.includes('click');
    const isClickActual = actualType.includes('click');

    if (isGenericClick && isClickActual) {
      // 汎用click指定の場合: 任意のclick系アクション（left_click, right_click, double_click等）を許可
      actionTypeMatches = true;
      actionTypeStrictMatch = false;  // 緩和マッチ
    } else if (expectedType === actualType) {
      // 厳密一致: expectedToolActionが具体的（left_click, right_click, double_click等）な場合
      actionTypeMatches = true;
      actionTypeStrictMatch = true;  // ★厳密一致成功
    } else if (isClickExpected && isClickActual) {
      // 緩和マッチ: 両方クリック系だが種別が異なる（例: expected=right_click, actual=left_click）
      // ★★★ v5改善: この場合は中信頼度として扱う（高信頼マッチには使用しない） ★★★
      actionTypeMatches = true;
      actionTypeStrictMatch = false;
    } else {
      actionTypeMatches = false;
      actionTypeStrictMatch = false;
    }
  } else {
    // 期待アクション種別が指定されていない場合は種別チェックをスキップ
    actionTypeMatches = true;
    actionTypeStrictMatch = false;  // 指定なしの場合は厳密一致とはみなさない
  }

  // 4. 信頼度判定と進行判断
  // ★★★ フィードバック1対応 + 新規フィードバック2対応 + v5対応 + v8更新 ★★★

  // ★★★ v5追加 + v8拡張: 非プログレッシブアクションの判定 ★★★
  // v8拡張: フォーカス移動や軽微なUI変化のクリックも考慮
  const nonProgressiveActions = [
    'wait',           // 待機は画面変化を期待しない
    'screenshot',     // スクリーンショット取得のみ
    'mouse_move',     // カーソル移動のみで画面変化は微小
    'scroll',         // スクロールは画面内の位置変化のみ（コンテンツ変化は検出困難）
  ];
  const isNonProgressiveAction = nonProgressiveActions.includes(toolAction.action);

  // ★★★ v8追加 + v9更新: 軽微な画面変化を期待するアクションの判定 ★★★
  // これらのアクションは画面変化が微小でもハッシュで検出されない可能性がある
  // ★v9追加: 適用手順を明示化
  const subtleChangeActions = [
    'left_click',     // フォーカス移動、チェックボックス等の微小変化
    'triple_click',   // テキスト選択（ハイライト変化）
  ];
  const expectsSubtleChange = subtleChangeActions.includes(toolAction.action);

  // 高信頼度パターン（★v5: actionTypeStrictMatchを考慮）
  const highConfidenceByKeyword = keywordMatchCount >= 2 || (keywordMatchCount >= 1 && actionTypeStrictMatch);
  const highConfidenceByTarget = targetElementMatchCount >= 1 && actionTypeStrictMatch;

  if (highConfidenceByKeyword || highConfidenceByTarget) {
    // ★★★ v5改善 + v9更新: 画面変化を必須条件として組み込む（微小変化対応追加） ★★★
    // 非プログレッシブアクションは画面変化を期待しないためスキップ
    const requiresScreenChangeForProgress = !isNonProgressiveAction;

    // ★★★ v9追加: 微小変化アクションの場合は画面変化必須を緩和 ★★★
    // expectsSubtleChangeがtrueの場合:
    //   - 画面変化あり → shouldAdvanceIndex = true（即時完了）
    //   - 画面変化なし → shouldAdvanceIndex = false だが confidence = 'high'を維持
    //     → 猶予ウィンドウ（v6-3）に委ねる or 中信頼として継続
    // これにより、フォーカス移動のような微小変化が「変化なし」で失敗扱いになることを防ぐ

    const canAdvanceIndex = !requiresScreenChangeForProgress || screenChanged === true;

    // ★★★ v9追加: 微小変化アクションで画面変化なしの場合の特別処理 ★★★
    if (expectsSubtleChange && !screenChanged && requiresScreenChangeForProgress) {
      // 微小変化を期待するアクション（left_click等）で画面変化が検出されない場合:
      // - 即時インデックス進行はしない
      // - ただし高信頼マッチなので、猶予ウィンドウで画面変化を待つ
      // - pendingHighConfidenceMatchとして保留される（agentLoop側で処理）
      return {
        isValid: true,
        shouldAdvanceIndex: false,  // ★v9: 微小変化で変化なしの場合は進行しない
        confidence: 'high',         // ★v9: 信頼度は高のまま（猶予ウィンドウに委ねる）
        needsClaudeVerification: false,
        requiresScreenChange: true,
        expectsSubtleChange: true,  // ★v9追加: 微小変化フラグを返却値に追加
      };
    }

    return {
      isValid: true,
      shouldAdvanceIndex: canAdvanceIndex,  // ★v5: 画面変化がある場合のみインデックスを進める
      confidence: 'high',
      needsClaudeVerification: false,
      requiresScreenChange: requiresScreenChangeForProgress,
      expectsSubtleChange: expectsSubtleChange,  // ★v9追加: 微小変化フラグを返却値に追加
    };
  }

  // 中信頼度パターン（緩和マッチを許容）
  const mediumConfidence = keywordMatchCount >= 1 ||
                           targetElementMatchCount >= 1 ||
                           actionTypeMatches;

  if (mediumConfidence) {
    // ★★★ 新規フィードバック2対応: クリック系は中信頼度が続いた場合にClaude検証 ★★★
    return {
      isValid: true,
      shouldAdvanceIndex: false,  // インデックスは進めない
      confidence: 'medium',
      needsClaudeVerification: isClickAction,  // クリック系の場合は検証が必要かもしれない
      requiresScreenChange: !isNonProgressiveAction
    };
  }

  // 低信頼度: 一致なし（ただし無効とはしない - 期待アクションと無関係な補助操作の可能性）
  return {
    isValid: true,
    shouldAdvanceIndex: false,
    confidence: 'low',
    needsClaudeVerification: false,
    requiresScreenChange: false
  };
}

/**
 * Claudeに現在の期待アクションが達成されたかを確認させる
 * 高信頼度の進行判定が得られない場合に使用
 *
 * ★★★ 新規フィードバック5対応: API経路をvisionモデル（Sonnet）に統一 ★★★
 *
 * 重要:
 * - Computer Use API（Opus 4.5）は`beta.messages.create`+`betas`ヘッダが必須
 * - この関数は画像解析のみでtool_useを使用しないため、通常のvisionモデルを使用
 * - claude-sonnet-4-20250514を使用（画像解析対応、beta不要）
 */
export async function askClaudeForActionCompletion(
  scenarioDescription: string,
  expectedAction: ExpectedAction,
  completedToolUses: string[],
  currentScreenshotBase64: string
): Promise<{ isCompleted: boolean; reason?: string }> {
  try {
    const client = await getClaudeClient();

    const prompt = `
ユーザーのシナリオ:
${scenarioDescription}

現在確認したい期待アクション:
- 説明: ${expectedAction.description}
- キーワード: ${expectedAction.keywords.join(', ')}
- 対象要素: ${expectedAction.targetElements?.join(', ') || '指定なし'}

これまでに実行したtool_use:
${completedToolUses.length > 0 ? completedToolUses.join('\n') : '(なし)'}

質問: 現在の画面を見て、上記の期待アクション「${expectedAction.description}」は達成されましたか？

以下のJSON形式で回答してください:
\`\`\`json
{"isCompleted": true/false, "reason": "判断理由"}
\`\`\`
`;

    // ★★★ 新規フィードバック5対応: visionモデル（Sonnet）を使用 ★★★
    // Opus 4.5のComputer Use APIはbeta経路が必須だが、この関数は画像解析のみのため通常APIを使用
    // claude-sonnet-4-20250514はビジョン対応かつbetaヘッダ不要
    const VISION_MODEL = 'claude-sonnet-4-20250514';

    const response = await client.messages.create({
      model: VISION_MODEL,
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: currentScreenshotBase64,
              },
            },
          ],
        },
      ],
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      return { isCompleted: false };
    }

    const jsonMatch = content.text.match(/```json\s*(\{[\s\S]*?\})\s*```/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[1]);
    }

    return { isCompleted: false };
  } catch (error) {
    console.warn('Action completion check failed, assuming not completed:', error);
    return { isCompleted: false };
  }
}
```

#### ステップ 4.2: agentLoop.tsへの期待アクション照合とcheckProgress呼び出しの組み込み（改善版）

**対象ファイル**: `src/services/agentLoop.ts`

**重要**:
- フィードバック1対応: 高信頼マッチ時のみインデックスを進める
- フィードバック2対応: checkSameActionRepeatを削除し、checkProgressに統合

```typescript
// 追加するimport
import { validateActionAndCheckProgress, extractExpectedActions, askClaudeForActionCompletion } from './actionValidator';
import type { ExtractExpectedActionsResult } from './actionValidator';

// runAgentLoop関数の冒頭で期待アクションを抽出
// ★★★ 新規フィードバック3対応: isFromFallbackフラグを保持 ★★★
const extractResult: ExtractExpectedActionsResult = await extractExpectedActions(options.scenario.description);
const expectedActions = extractResult.expectedActions;
const isFromFallback = extractResult.isFromFallback;  // フォールバック使用フラグ

let completedActionIndex = 0;
const completedToolUseDescriptions: string[] = [];

// ProgressTrackerの初期化（同一アクション検出用フィールドを含む）
const progressTracker: ProgressTracker = createProgressTracker();

// ★★★ フィードバック2対応: スクリーンショット変化追跡用の変数 ★★★
let previousScreenshotBase64: string = captureResult.imageBase64;

// 期待アクション達成チェック用のカウンター
let mediumConfidenceActionCount = 0;  // ★★★ 新規フィードバック2対応: 中信頼度のカウント ★★★
const MEDIUM_CONFIDENCE_CHECK_THRESHOLD = 3;  // 中信頼度アクションが3回続いたらClaude検証

// ★★★ 新規フィードバック2対応: Claude応答テキストを保持 ★★★
let lastClaudeResponseText = '';

// 各イテレーションでClaude応答からテキストを抽出
const textBlocks = response.content.filter(
  (block): block is BetaTextBlock => block.type === 'text'
);
lastClaudeResponseText = textBlocks.map(b => b.text).join('\n');

// ツール実行ループ内で照合
for (const toolUse of toolUseBlocks) {
  const action = toolUse.input as ComputerAction;

  // ...アクション実行...（★v5: 照合より先にアクション実行して画面変化を検出）
  const actionResult = await executeAction(action, captureResult.scaleFactor, captureResult.displayScaleFactor);

  // アクション実行エラーの即時評価（Phase 2で追加）
  if (!actionResult.success) {
    // ... エラー処理 ...
  }

  // スクリーンショットを取得
  const previousScreenshotHash = hashScreenshot(captureResult.imageBase64);  // ★v5追加
  captureResult = await invoke<CaptureResult>('capture_screen');
  const currentScreenshotHash = hashScreenshot(captureResult.imageBase64);  // ★v5追加

  // ★★★ v5追加: 画面変化を検出 ★★★
  const screenChanged = previousScreenshotHash !== currentScreenshotHash;

  // ★★★ v5改善: 画面変化フラグをvalidateActionAndCheckProgressに渡す ★★★
  const validation = validateActionAndCheckProgress(
    action,
    expectedActions,
    completedActionIndex,
    lastClaudeResponseText,  // 直前のClaude応答テキストを渡す
    screenChanged  // ★v5追加: 画面変化フラグを渡す
  );

  if (validation.shouldAdvanceIndex) {
    // 高信頼度マッチ かつ 画面変化あり: インデックスを進める
    if (expectedActions.length > completedActionIndex) {
      expectedActions[completedActionIndex].completed = true;
      log(`[Agent Loop] Expected action completed (high confidence, screen changed): ${expectedActions[completedActionIndex].description}`);
      completedActionIndex++;
      mediumConfidenceActionCount = 0;  // リセット
    }
  } else if (validation.confidence === 'high' && validation.requiresScreenChange && !screenChanged) {
    // ★★★ v5追加: 高信頼度だが画面変化なし → ログを出力し、インデックスは進めない ★★★
    log(`[Agent Loop] High confidence match but no screen change - not advancing index`);
    mediumConfidenceActionCount++;  // 中信頼度として扱う
  } else if (validation.confidence === 'medium') {
    // ★★★ 新規フィードバック2対応: 中信頼度のカウントと検証 ★★★
    mediumConfidenceActionCount++;

    // 中信頼度が続いた場合、Claudeに期待アクション達成を確認
    if (mediumConfidenceActionCount >= MEDIUM_CONFIDENCE_CHECK_THRESHOLD &&
        completedActionIndex < expectedActions.length &&
        validation.needsClaudeVerification) {
      log(`[Agent Loop] Medium confidence actions accumulated (${mediumConfidenceActionCount}) - requesting Claude verification`);

      const completionCheck = await askClaudeForActionCompletion(
        options.scenario.description,
        expectedActions[completedActionIndex],
        completedToolUseDescriptions,
        captureResult.imageBase64
      );

      // ★★★ v5改善: Claude検証でも画面変化を確認 ★★★
      if (completionCheck.isCompleted && screenChanged) {
        expectedActions[completedActionIndex].completed = true;
        log(`[Agent Loop] Expected action completed (Claude verified, screen changed): ${expectedActions[completedActionIndex].description}`);
        completedActionIndex++;
        mediumConfidenceActionCount = 0;
      } else if (completionCheck.isCompleted && !screenChanged) {
        log(`[Agent Loop] Claude verified completion but no screen change - not advancing index`);
        // インデックスは進めない
      }
    }
  } else {
    // 低信頼度: カウンターはリセットしない（補助操作の可能性）
  }

  // 実行したtool_useを記録
  completedToolUseDescriptions.push(formatActionDetails(action, captureResult.scaleFactor, captureResult.displayScaleFactor));

  // ★★★ フィードバック2対応: アクション実行後にcheckProgressを呼び出し（統合版） ★★★
  // checkSameActionRepeatは使用せず、checkProgressに同一アクション検出を統合
  const progressCheck = checkProgress(
    progressTracker,
    captureResult.imageBase64,
    action,
    {
      maxUnchangedScreenshots: config.maxUnchangedScreenshots ?? DEFAULT_STUCK_DETECTION_CONFIG.maxUnchangedScreenshots,
      maxSameActionRepeats: config.maxSameActionRepeats ?? DEFAULT_STUCK_DETECTION_CONFIG.maxSameActionRepeats,
    }
  );

  if (progressCheck.isStuck) {
    log(`[Agent Loop] Stuck detected: ${progressCheck.details}`);

    return {
      success: false,
      error: `Stuck: ${progressCheck.details}`,
      iterations: iteration,
      testResult: createTestResult({
        status: 'failure',
        failureReason: progressCheck.reason || 'action_no_effect',
        failureDetails: progressCheck.details,
        completedSteps: iteration,
        completedActionIndex,
        lastAction: formatActionDetails(action, captureResult.scaleFactor, captureResult.displayScaleFactor),
        startedAt,
      }),
    };
  }
}
```

#### ステップ 4.3: 成功判定時のanalyzeClaudeResponse呼び出しと期待アクション完了チェック（改善版）

**対象ファイル**: `src/services/agentLoop.ts`

**重要**: `isScenarioComplete`ではなく`analyzeClaudeResponse`を使用し、期待アクション進捗に基づくフォールバックを含める

```typescript
// ★★★ フィードバック1対応: isScenarioCompleteをanalyzeClaudeResponseに置き換え ★★★
// ★★★ フィードバック3対応: JSON未返却時は期待アクション進捗に基づく判定 ★★★
// ★★★ 新規フィードバック3対応: isFromFallbackフラグを渡す ★★★

const analyzeResult = analyzeClaudeResponse(response, expectedActions, completedActionIndex, isFromFallback);

if (analyzeResult.isComplete) {
  log('[Agent Loop] Scenario completed - analyzing result');

  // Claudeが失敗を報告した場合
  if (!analyzeResult.isSuccess && !analyzeResult.successByProgress) {
    log(`[Agent Loop] Failure: ${analyzeResult.analysis}`);

    return {
      success: false,
      error: `Scenario failed: ${analyzeResult.analysis}`,
      iterations: iteration + 1,
      testResult: createTestResult({
        status: 'failure',
        failureReason: analyzeResult.failureReason || 'unexpected_state',
        failureDetails: analyzeResult.analysis,
        completedSteps: iteration + 1,
        completedActionIndex,
        claudeAnalysis: analyzeResult.analysis,
        claudeResultOutput: analyzeResult.resultOutput,
        startedAt,
      }),
    };
  }

  // 成功（Claude JSONまたは進捗ベース）
  // ログに進捗ベース成功の場合は警告を追加
  if (analyzeResult.successByProgress) {
    log('[Agent Loop] Success determined by expected action progress (Claude did not provide JSON result)');
  }

  return {
    success: true,
    iterations: iteration + 1,
    testResult: createTestResult({
      status: 'success',
      completedSteps: iteration + 1,
      completedActionIndex,
      totalExpectedSteps: expectedActions.length || undefined,
      claudeAnalysis: analyzeResult.analysis,
      claudeResultOutput: analyzeResult.resultOutput,
      startedAt,
    }),
  };
}
```

### Phase 5: 全終了パスでのTestResult生成（重大度: 中 対応）

#### ステップ 5.1: agentLoop.tsの全return文を修正

**対象ファイル**: `src/services/agentLoop.ts`

全ての終了パスで`TestResult`を生成するように修正:

```typescript
export async function runAgentLoop(
  options: AgentLoopOptions
): Promise<AgentLoopResult> {
  // ... 初期化 ...
  const startedAt = new Date();
  let completedActionIndex = 0;

  try {
    // 1. 中断チェック (L115-117)
    if (options.abortSignal.aborted) {
      return {
        success: false,
        error: 'Aborted',
        iterations: iteration,
        testResult: createTestResult({
          status: 'stopped',
          failureReason: 'aborted',
          failureDetails: 'Aborted by signal',
          completedSteps: iteration,
          completedActionIndex,
          startedAt,
        }),
      };
    }

    // 2. ユーザー停止チェック (L119-122)
    const stopRequested = await invoke<boolean>('is_stop_requested');
    if (stopRequested) {
      return {
        success: false,
        error: 'Stopped by user',
        iterations: iteration,
        testResult: createTestResult({
          status: 'stopped',
          failureReason: 'user_stopped',
          failureDetails: 'Stopped by user request',
          completedSteps: iteration,
          completedActionIndex,
          startedAt,
        }),
      };
    }

    // 3. API呼び出し中断 (L132-134)
    if (!response) {
      return {
        success: false,
        error: 'API call aborted',
        iterations: iteration,
        testResult: createTestResult({
          status: 'error',
          failureReason: 'api_error',
          failureDetails: 'API call was aborted',
          completedSteps: iteration,
          completedActionIndex,
          startedAt,
        }),
      };
    }

    // 4. シナリオ完了 (L137-140) - ステップ4.3参照
    // analyzeClaudeResponseを使用した判定フロー

    // 5. ループ検出 (L170-176)
    if (detectLoop(actionHistory, action, config)) {
      return {
        success: false,
        error: `Infinite loop detected: same action repeated ${config.loopDetectionThreshold} times`,
        iterations: iteration,
        testResult: createTestResult({
          status: 'failure',
          failureReason: 'stuck_in_loop',
          failureDetails: `Same action repeated ${config.loopDetectionThreshold} times (loop detection)`,
          completedSteps: iteration,
          completedActionIndex,
          lastAction: formatActionDetails(action, captureResult.scaleFactor, captureResult.displayScaleFactor),
          startedAt,
        }),
      };
    }

    // 6. 最大イテレーション到達 (L228-232)
    return {
      success: false,
      error: `Max iterations (${config.maxIterationsPerScenario}) reached`,
      iterations: iteration,
      testResult: createTestResult({
        status: 'timeout',
        failureReason: 'max_iterations',
        failureDetails: `Maximum iterations (${config.maxIterationsPerScenario}) reached without completion`,
        completedSteps: iteration,
        completedActionIndex,
        startedAt,
      }),
    };
  } catch (error) {
    // 7. 例外キャッチ (L234-237)
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`[Agent Loop] Error: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
      iterations: iteration,
      testResult: createTestResult({
        status: 'error',
        failureReason: 'action_execution_error',  // ★v11: execution_errorをaction_execution_errorに統合
        failureDetails: errorMessage,
        completedSteps: iteration,
        completedActionIndex,
        startedAt,
      }),
    };
  }
}
```

### Phase 6: 結果判定ロジックの実装（改善版: フィードバック2対応）

#### ステップ 6.1: 結果判定モジュールの作成
**新規ファイル**: `src/services/resultJudge.ts`

**重要**: フィードバック2対応 - checkProgressに同一アクション検出を統合

```typescript
/**
 * Test result judgment module
 * Analyzes Claude's response and execution state to determine test outcome
 */

import type { BetaMessage, BetaTextBlock } from '@anthropic-ai/sdk/resources/beta/messages';
import type {
  TestResult,
  TestResultStatus,
  FailureReason,
  ProgressTracker,
  ClaudeResultOutput,
} from '../types';
import type { ComputerAction, ComputerActionType } from '../types';  // ★★★ v10追加（重大度:中対応）: ComputerActionType追加 ★★★
import { hashAction } from '../utils/loopDetector';

/** Configuration for stuck detection */
export interface StuckDetectionConfig {
  maxUnchangedScreenshots: number;  // 連続して変化なしの最大回数
  maxSameActionRepeats: number;     // 同じアクションの最大繰り返し回数
}

export const DEFAULT_STUCK_DETECTION_CONFIG: StuckDetectionConfig = {
  maxUnchangedScreenshots: 3,
  maxSameActionRepeats: 5,
};

/**
 * Simple hash for screenshot comparison
 * Uses sampling to reduce computation
 */
export function hashScreenshot(base64Data: string): string {
  // サンプリングによる簡易ハッシュ（完全一致ではなく類似度チェック用）
  const sample = base64Data.slice(0, 1000) +
                 base64Data.slice(Math.floor(base64Data.length / 2), Math.floor(base64Data.length / 2) + 1000) +
                 base64Data.slice(-1000);

  let hash = 0;
  for (let i = 0; i < sample.length; i++) {
    const char = sample.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

/**
 * 画面変化が起きにくいアクションかどうかを判定
 * ★★★ 新規フィードバック4対応 + v8拡張: これらのアクションは進捗判定をスキップ ★★★
 *
 * v8拡張: scrollを追加、また軽微なUI変化（フォーカス移動等）への対応として
 * 画面変化猶予ウィンドウ（v6-3）との併用を前提とした設計に更新
 */
function isNonProgressiveAction(action: ComputerAction): boolean {
  const nonProgressiveActions: ComputerActionType[] = [
    'wait',        // 待機は画面変化を期待しない
    'screenshot',  // スクリーンショット取得のみ
    'mouse_move',  // カーソル移動のみで画面変化は微小
    'scroll',      // ★v8追加: スクロールは画面内の位置変化のみ
  ];
  return nonProgressiveActions.includes(action.action);
}

/**
 * ★★★ v8追加: 軽微な画面変化が期待されるアクションかどうかを判定 ★★★
 *
 * これらのアクションは画面変化が微小でハッシュ比較で検出されない可能性がある:
 * - テキストフィールドへのクリック → カーソル点滅のみ
 * - チェックボックス/ラジオボタン → 小さな状態変化
 * - フォーカス移動 → 枠線の色変化のみ
 *
 * 対策:
 * 1. 画面変化猶予ウィンドウ（v6-3）で遅延変化をカバー
 * 2. Claude視覚検証で状態変化を確認
 * 3. 「変化なし」でも即時失敗とせず、中信頼度として継続
 */
function expectsSubtleScreenChange(action: ComputerAction): boolean {
  const subtleChangeActions: ComputerActionType[] = [
    'left_click',     // フォーカス移動、チェックボックス等
    'triple_click',   // テキスト選択（ハイライト変化）
  ];
  return subtleChangeActions.includes(action.action);
}

/**
 * Check if progress is being made based on screenshot changes and action repetition
 * ★★★ フィードバック2対応: 同一アクション連続検出を統合（二重カウント防止） ★★★
 * ★★★ 新規フィードバック4対応: 画面変化が起きにくいアクションは進捗判定をスキップ ★★★
 * ★★★ v9追加: 微小変化アクション（expectsSubtleScreenChange）への適用手順を明示 ★★★
 *
 * このメソッドをagentLoopのアクション実行後に呼び出す
 * checkSameActionRepeatは別途呼び出さない（このメソッドに統合済み）
 */
export function checkProgress(
  tracker: ProgressTracker,
  currentScreenshotBase64: string,
  currentAction: ComputerAction,
  config: StuckDetectionConfig = DEFAULT_STUCK_DETECTION_CONFIG
): { isStuck: boolean; reason?: FailureReason; details?: string } {
  const currentScreenshotHash = hashScreenshot(currentScreenshotBase64);
  const currentActionHash = hashAction(currentAction);

  // ★★★ 新規フィードバック4対応: 画面変化が起きにくいアクションは進捗判定をスキップ ★★★
  const isNonProgressive = isNonProgressiveAction(currentAction);

  // ★★★ v9追加: 微小な画面変化を期待するアクションの判定 ★★★
  const expectsSubtle = expectsSubtleScreenChange(currentAction);

  // Check screenshot change
  // - 非プログレッシブアクションは変化なしカウントを増加させない
  // - ★v9追加: 微小変化アクションは閾値を緩和（通常の2倍まで許容）
  if (!isNonProgressive) {
    if (currentScreenshotHash === tracker.lastScreenshotHash) {
      tracker.unchangedCount++;

      // ★★★ v9追加: 微小変化アクションは閾値を緩和 ★★★
      const effectiveMaxUnchanged = expectsSubtle
        ? config.maxUnchangedScreenshots * 2  // 微小変化は閾値を2倍に
        : config.maxUnchangedScreenshots;

      if (tracker.unchangedCount >= effectiveMaxUnchanged) {
        return {
          isStuck: true,
          reason: 'action_no_effect',
          details: `Screen unchanged for ${tracker.unchangedCount} consecutive actions`,
        };
      }
    } else {
      tracker.unchangedCount = 0;
    }
  }
  // スクリーンショットハッシュは常に更新（比較ベースとして保持）
  tracker.lastScreenshotHash = currentScreenshotHash;

  // ★★★ フィードバック2対応: 同一アクション連続検出（ここでのみsameActionCountを更新） ★★★
  // ★★★ 新規フィードバック4対応: 非プログレッシブアクションは閾値を緩和（waitは連続10回まで許容） ★★★
  const maxRepeats = isNonProgressive
    ? Math.max(config.maxSameActionRepeats * 2, 10)  // 非プログレッシブは閾値を倍に（最低10回）
    : config.maxSameActionRepeats;

  if (currentActionHash === tracker.lastActionHash) {
    tracker.sameActionCount++;
    if (tracker.sameActionCount >= maxRepeats) {
      return {
        isStuck: true,
        reason: 'stuck_in_loop',
        details: `Same action repeated ${tracker.sameActionCount} times`,
      };
    }
  } else {
    tracker.sameActionCount = 1;
    tracker.lastActionHash = currentActionHash;
  }

  return { isStuck: false };
}

/**
 * Create a test result object
 */
export function createTestResult(params: {
  status: TestResultStatus;
  failureReason?: FailureReason;
  failureDetails?: string;
  completedSteps: number;
  completedActionIndex: number;
  totalExpectedSteps?: number;
  lastAction?: string;
  claudeAnalysis?: string;
  claudeResultOutput?: ClaudeResultOutput;
  startedAt: Date;
}): TestResult {
  const completedAt = new Date();
  return {
    status: params.status,
    failureReason: params.failureReason,
    failureDetails: params.failureDetails,
    completedSteps: params.completedSteps,
    completedActionIndex: params.completedActionIndex,
    totalExpectedSteps: params.totalExpectedSteps,
    lastAction: params.lastAction,
    claudeAnalysis: params.claudeAnalysis,
    claudeResultOutput: params.claudeResultOutput,
    startedAt: params.startedAt,
    completedAt,
    durationMs: completedAt.getTime() - params.startedAt.getTime(),
  };
}

/**
 * Initialize a progress tracker
 */
export function createProgressTracker(): ProgressTracker {
  return {
    lastScreenshotHash: '',
    unchangedCount: 0,
    lastActionType: '',
    lastActionHash: '',
    sameActionCount: 0,
  };
}
```

#### ステップ 6.2: AgentLoopConfigの拡張

**対象ファイル**: `src/types/action.ts`

```typescript
/** Configuration for agent loop */
export interface AgentLoopConfig {
  maxIterationsPerScenario: number;
  loopDetectionWindow: number;
  loopDetectionThreshold: number;
  /** Claude model configuration */
  modelConfig?: ClaudeModelConfig;
  /** Maximum same action repeats before stuck detection */
  maxSameActionRepeats?: number;
  /** Maximum unchanged screenshots before stuck detection */
  maxUnchangedScreenshots?: number;
}

/** Default agent loop configuration */
export const DEFAULT_AGENT_LOOP_CONFIG: AgentLoopConfig = {
  maxIterationsPerScenario: 30,
  loopDetectionWindow: 5,
  loopDetectionThreshold: 3,
  modelConfig: DEFAULT_CLAUDE_MODEL_CONFIG,
  maxSameActionRepeats: 5,
  maxUnchangedScreenshots: 3,
};
```

#### ステップ 6.3: scenarioRunner.tsの修正（v14更新: パターン統一）
**対象ファイル**: `src/services/scenarioRunner.ts`

**★★★ v14更新: `mapTestResultStatusToScenarioStatus`を使用してパターンを統一 ★★★**

以前のサンプルでは`result.testResult.status === 'success' ? 'completed' : 'failed'`という直接比較を使用していたが、これはv12で定義した`mapTestResultStatusToScenarioStatus`関数と不整合がある。`stopped`ステータスを適切に保持するため、統一的に`mapTestResultStatusToScenarioStatus`を使用する。

```typescript
// executeScenario内でTestResultをScenarioに保存
private async executeScenario(
  scenario: Scenario,
  options: ScenarioRunnerOptions
): Promise<void> {
  // ...既存のコード...

  try {
    const result: AgentLoopResult = await runAgentLoop({
      // ...
    });

    // TestResultをScenarioに保存
    scenario.result = result.testResult;
    // ★★★ v14更新: mapTestResultStatusToScenarioStatusを使用（v12定義と統一） ★★★
    scenario.status = mapTestResultStatusToScenarioStatus(result.testResult.status);
    scenario.error = result.testResult.failureDetails;
    scenario.iterations = result.iterations;
    scenario.completedAt = new Date();

    this.log(
      `[Scenario Runner] Scenario ${scenario.result.status}: ${scenario.title} - ${scenario.result.claudeAnalysis || scenario.result.failureDetails || ''}`
    );
  } catch (error) {
    // ...
  }
}
```

**注意**: `mapTestResultStatusToScenarioStatus`関数は本計画書のステップ1.4（v12追加）で定義済み。以下を参照:
- `success` → `completed`
- `stopped` → `stopped`（ユーザー停止を保持）
- `failure`/`timeout`/`error`/その他 → `failed`

### Phase 7: UI改善（フィードバック4対応）

#### ステップ 7.1: App.vueの結果表示改善（v15更新: Stopped別枠表示）
**対象ファイル**: `src/App.vue`

**★★★ v15更新: Stopped/Errorを別枠表示（フィードバック: 重大度低） ★★★**

```vue
<!-- Scenario Listセクションの拡張 -->
<div v-if="scenarios.length > 0" class="scenario-list">
  <h2>Scenarios</h2>

  <!-- 全体サマリー（v15更新: Passed/Failed/Stopped/Pendingの4カテゴリ） -->
  <div class="test-summary">
    <span class="summary-item success">
      {{ scenarios.filter(s => s.result?.status === 'success').length }} Passed
    </span>
    <span class="summary-item failure">
      <!-- ★v15更新: stopped/errorを除外し、failure/timeoutのみをFailedとしてカウント -->
      {{ scenarios.filter(s => s.result && (s.result.status === 'failure' || s.result.status === 'timeout')).length }} Failed
    </span>
    <!-- ★v15追加: Stopped/Errorを別枠で表示 -->
    <span class="summary-item stopped">
      {{ scenarios.filter(s => s.result && (s.result.status === 'stopped' || s.result.status === 'error')).length }} Stopped
    </span>
    <span class="summary-item pending">
      {{ scenarios.filter(s => !s.result && s.status === 'pending').length }} Pending
    </span>
  </div>

  <!-- ★v16更新: result-stoppedクラスを追加してStopped/Errorを視覚的に分離（フィードバック: 重大度低） -->
  <div
    v-for="(scenario, index) in scenarios"
    :key="scenario.id"
    class="scenario-item"
    :class="{
      active: index === currentScenarioIndex,
      'result-success': scenario.result?.status === 'success',
      'result-stopped': scenario.result && (scenario.result.status === 'stopped' || scenario.result.status === 'error'),
      'result-failure': scenario.result && (scenario.result.status === 'failure' || scenario.result.status === 'timeout')
    }"
  >
    <div class="scenario-header">
      <span class="scenario-title">
        <span class="result-icon">
          {{ getResultIcon(scenario.result?.status) }}
        </span>
        {{ scenario.title }}
      </span>
      <span :class="['scenario-status', getStatusClass(scenario.status)]">
        {{ getStatusLabel(scenario.status) }}
      </span>
    </div>

    <div class="scenario-details">
      <span v-if="scenario.iterations">Iterations: {{ scenario.iterations }}</span>
      <span v-if="scenario.result?.durationMs">
        Duration: {{ (scenario.result.durationMs / 1000).toFixed(1) }}s
      </span>
      <!-- 期待アクション進捗表示 -->
      <span v-if="scenario.result?.totalExpectedSteps">
        Progress: {{ scenario.result.completedActionIndex }}/{{ scenario.result.totalExpectedSteps }}
      </span>
    </div>

    <!-- 失敗時の詳細表示（success以外を全て表示） -->
    <div v-if="scenario.result && scenario.result.status !== 'success'" class="failure-details">
      <div class="failure-reason">
        <strong>Failure Reason:</strong> {{ getFailureReasonLabel(scenario.result.failureReason) }}
      </div>
      <div v-if="scenario.result.failureDetails" class="failure-message">
        {{ scenario.result.failureDetails }}
      </div>
      <div v-if="scenario.result.claudeAnalysis" class="claude-analysis">
        <strong>AI Analysis:</strong> {{ scenario.result.claudeAnalysis }}
      </div>
      <!-- Claudeの構造化結果を表示 -->
      <div v-if="scenario.result.claudeResultOutput" class="claude-result-output">
        <strong>Claude Result:</strong>
        <code>{{ JSON.stringify(scenario.result.claudeResultOutput) }}</code>
      </div>
    </div>
  </div>
</div>

<script setup lang="ts">
// 追加するヘルパー関数
function getResultIcon(status?: string): string {
  switch (status) {
    case 'success': return '✓';
    case 'failure': return '✗';
    case 'timeout': return '⏱';
    case 'stopped': return '⏹';
    case 'error': return '⚠';
    default: return '○';
  }
}

// ★v11: execution_errorをaction_execution_errorに統合したため、ラベルからも削除
function getFailureReasonLabel(reason?: string): string {
  const labels: Record<string, string> = {
    'element_not_found': '要素が見つかりません',
    'action_no_effect': '操作が効果なし',
    'action_execution_error': 'アクション実行エラー',
    'stuck_in_loop': '処理がスタック',
    'unexpected_state': '予期しない状態',
    'action_mismatch': '期待アクションと不一致',
    'incomplete_actions': '期待アクションが未完了',
    'invalid_result_format': 'Claudeの結果フォーマット不正',
    'max_iterations': '最大試行回数到達',
    'api_error': 'API エラー',
    'user_stopped': 'ユーザーによる停止',
    'aborted': '中断',
    'unknown': '原因不明',
  };
  return labels[reason || ''] || reason || '不明';
}
</script>

<style>
/* 追加するスタイル */
.test-summary {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
  padding: 12px;
  background-color: #f0f0f0;
  border-radius: 8px;
}

@media (prefers-color-scheme: dark) {
  .test-summary {
    background-color: #2a2a2a;
  }
}

.summary-item {
  font-weight: 500;
  padding: 4px 12px;
  border-radius: 4px;
}

.summary-item.success {
  background-color: #28a745;
  color: white;
}

.summary-item.failure {
  background-color: #dc3545;
  color: white;
}

.summary-item.pending {
  background-color: #6c757d;
  color: white;
}

/* ★v15追加: Stoppedカテゴリのスタイル */
.summary-item.stopped {
  background-color: #ffc107;
  color: #000;
}

.result-icon {
  margin-right: 8px;
  font-weight: bold;
}

.result-success {
  border-left: 4px solid #28a745;
}

.result-failure {
  border-left: 4px solid #dc3545;
}

/* ★v16追加: Stopped/Errorの視覚表示クラス（フィードバック: 重大度低） */
.result-stopped {
  border-left: 4px solid #ffc107;
}

.failure-details {
  margin-top: 12px;
  padding: 12px;
  background-color: #fff5f5;
  border-radius: 4px;
  font-size: 13px;
}

@media (prefers-color-scheme: dark) {
  .failure-details {
    background-color: #2c1a1a;
  }
}

.failure-reason {
  color: #dc3545;
  margin-bottom: 8px;
}

.failure-message {
  margin-bottom: 8px;
  color: #666;
}

@media (prefers-color-scheme: dark) {
  .failure-message {
    color: #aaa;
  }
}

.claude-analysis {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #eee;
}

@media (prefers-color-scheme: dark) {
  .claude-analysis {
    border-top-color: #444;
  }
}

.claude-result-output {
  margin-top: 8px;
  padding: 8px;
  background-color: #f5f5f5;
  border-radius: 4px;
  font-size: 12px;
}

.claude-result-output code {
  word-break: break-all;
}

@media (prefers-color-scheme: dark) {
  .claude-result-output {
    background-color: #2a2a2a;
  }
}
</style>
```

---

## 4. 技術的考慮事項

### 4.1 パフォーマンス

#### スクリーンショットハッシュ
- 完全な画像比較は重いため、サンプリングベースの簡易ハッシュを使用
- 先頭1000文字 + 中央1000文字 + 末尾1000文字をサンプル
- 完全一致ではなく、大きな変化の検出に特化

#### 期待アクション抽出
- シナリオ開始時に1回だけAPI呼び出し
- 抽出に失敗した場合はシナリオ全体を1つの期待アクションとして扱う（フォールバック）

#### Claude検証呼び出し（改善版）
- 高信頼度マッチが得られない場合のみ追加API呼び出し
- 低信頼度アクションが3回続いた場合にのみClaude検証を実行
- 高頻度の呼び出しを避けつつ、必要な場合には正確な判定を提供

#### メモリ使用量
- `ProgressTracker`は軽量（ハッシュ値と数値のみ保持）
- 最後のスクリーンショットは`TestResult`に保存しない（ログ容量削減）

### 4.2 セキュリティ
- 既存のセキュリティ機構（緊急停止等）は変更なし
- 新たなセキュリティリスクは発生しない

### 4.3 既存機能への影響

#### 後方互換性
- `AgentLoopResult.success`は従来通り動作
- `ScenarioStatus`は既存の値を維持
- UI表示は従来の情報に加えて詳細情報を追加表示

#### ループ検出との関係（★v18更新: 優先順位の明文化）

**★★★ v18追加: loopDetectorとcheckProgressの優先順位・重複時のfailureReason確定ルール ★★★**

**背景**: 既存の`loopDetector`を維持しつつ`checkProgress`でもスタック検出を行う方針だが、優先順位や重複時の`failureReason`確定ルールが明記されていなかった。

**役割分担**:
| 検出機構 | 検出対象 | 閾値 | failureReason |
|----------|----------|------|---------------|
| **loopDetector（既存）** | 完全同一アクションの繰り返し（ハッシュ一致） | 3回連続 | `stuck_in_loop` |
| **checkProgress（新規）** | 画面変化なし＋同一アクション連続 | 5回連続（非プログレッシブは10回） | `stuck_in_loop` |

**優先順位（主判定の決定）**:
1. **loopDetectorが主判定**: loopDetectorは完全一致検出であり、誤検出リスクが低いため主判定として扱う
2. **checkProgressは補完**: loopDetectorの閾値（3回）未満でも、画面変化がない状態が続く場合にスタックを検出する補完機構

**重複検出時の統合ルール**:
```typescript
// agentLoop.ts 内での検出統合

// 1. loopDetector の検出（既存コード）
const loopDetected = loopDetector.detectLoop(currentAction);

// 2. checkProgress の検出
const progressCheck = checkProgress(
  currentScreenshotHash,
  previousScreenshotHash,
  currentAction,
  sameActionCount,
  config
);

// 3. 統合判定: いずれかが検出したら失敗
// ★v18: loopDetectorを優先し、checkProgressは補完
if (loopDetected.isLoop) {
  // loopDetectorが主判定 → 即時終了
  return {
    success: false,
    testResult: createTestResult({
      status: 'failure',
      failureReason: 'stuck_in_loop',
      analysis: `Loop detected: same action repeated ${loopDetected.count} times (by loopDetector)`,
    }),
  };
}

if (progressCheck.isStuck) {
  // checkProgressが補完検出 → 即時終了
  return {
    success: false,
    testResult: createTestResult({
      status: 'failure',
      failureReason: 'stuck_in_loop',  // ★同一のfailureReasonを使用
      analysis: `Stuck detected: no screen change for ${progressCheck.noChangeCount} actions (by checkProgress)`,
    }),
  };
}
```

**重要な設計判断**:
- **failureReasonは統一**: 両検出機構とも`stuck_in_loop`を使用。検出機構の違いは`analysis`フィールドに記載
- **二重カウント防止**: `sameActionCount`は`checkProgress`内でのみ更新（一元管理）
- **既存loopDetectorとの整合性**: `hashAction`関数を`checkProgress`内で再利用し、判定基準を統一

**検出の流れ（フローチャート）**:
```
アクション実行
     │
     ▼
loopDetector.detectLoop()
     │
     ├─ ループ検出あり → stuck_in_loop で終了（主判定）
     │
     └─ ループ検出なし
            │
            ▼
     checkProgress()
            │
            ├─ スタック検出あり → stuck_in_loop で終了（補完）
            │
            └─ スタック検出なし → 継続
```

**非プログレッシブアクションの取り扱い**:
- `loopDetector`: 非プログレッシブ判定なし（すべてのアクションを同等に扱う）
- `checkProgress`: 非プログレッシブアクション（wait/screenshot/mouse_move/scroll）は閾値を2倍に緩和

**テストケース追加（v18）**:
| テストケース | 期待結果 |
|--------------|----------|
| loopDetectorとcheckProgressが同時に検出 | loopDetectorの結果を優先（analysisに「by loopDetector」） |
| loopDetector検出なし＋checkProgress検出あり | checkProgressの結果を採用（analysisに「by checkProgress」） |
| 両方検出なし | 継続 |

---

## 5. テスト計画

### 5.1 単体テスト

| テスト対象 | テスト内容 |
|------------|------------|
| `resultJudge.ts` - `hashScreenshot` | 同一画像で同一ハッシュ、異なる画像で異なるハッシュ |
| `resultJudge.ts` - `checkProgress` | スタック検出の正確性（スクリーンショット変化なし＋同一アクション繰り返し両方）、**二重カウント防止の確認**、**非プログレッシブアクション（wait/screenshot/mouse_move）のスキップ確認** |
| `resultJudge.ts` - `isNonProgressiveAction` | **wait, screenshot, mouse_move, ★v8: scrollが非プログレッシブと判定されること** |
| `resultJudge.ts` - `expectsSubtleScreenChange` | **★v8: left_click, triple_clickが軽微な変化アクションと判定されること** |
| `resultJudge.ts` - `analyzeClaudeResponse` | 結果スキーマJSON抽出、成功/失敗判定、**JSON未返却時の進捗ベースフォールバック**、**isFromFallback=trueでClaude成功を採用** |
| `actionValidator.ts` - `validateActionAndCheckProgress` | 期待アクションとtool_useの照合（keywords/targetElements含む）、**高信頼マッチ時のみshouldAdvanceIndex=true**、**★v5: 画面変化フラグ（screenChanged）を考慮**、**★v5: actionTypeStrictMatch（厳密一致）とactionTypeMatches（緩和マッチ）の区別** |
| `actionValidator.ts` - `extractExpectedActions` | シナリオからのアクション抽出、**失敗時のフォールバック（シナリオ全体を1期待アクション化）**、**isFromFallbackフラグが正しく設定されること** |
| `actionValidator.ts` - `askClaudeForActionCompletion` | **Sonnetモデルを使用したAPI呼び出し（betaヘッダなし）** |
| `actionValidator.ts` - `extractStepCountHint` | **★v7: 「3ステップ」「5つの操作」などの表現からステップ数ヒントを抽出、番号付きリストの検出**、**★v13: 連接語（「次に」「そして」「then」等）ベースのステップ数検出** |
| `actionValidator.ts` - `validateExpectedActionsCount` | **★v7: 最低件数検証、ステップ数ヒントとの乖離チェック（50%以上で警告）**、**★v13: 連接語ベースヒューリスティックを含むステップ数ヒントとの照合** |
| `actionValidator.ts` - `validateActionAndCheckProgress` (非プログレッシブ) | **★v13: 非プログレッシブアクション（wait/screenshot/mouse_move/scroll）でactionType厳密一致時に高信頼扱い、画面変化なしでもインデックス進行** |
| `agentLoop.ts` - `noProgressLowConfidenceCount` | **★v13: 非プログレッシブ/微小変化アクション時はカウント対象外、requiresScreenChange条件の追加確認** |
| `agentLoop.ts` - `mapExecutionErrorToFailureReason` | エラーメッセージからFailureReasonへのマッピング |
| `agentLoop.ts` - `lowConfidenceActionCount` | **★v7: 低/中信頼マッチ10回でaction_mismatch失敗、高信頼マッチでリセット** |

### 5.2 統合テスト

| テストケース | 期待結果 |
|--------------|----------|
| シナリオが正常完了（Claude結果JSON付き） | `status: 'success'`, `claudeResultOutput`あり |
| シナリオが正常完了（Claude結果JSONなし、期待アクション全完了） | `status: 'success'`, `successByProgress: true` |
| シナリオが正常完了（Claude結果JSONなし、期待アクション未完了） | `status: 'failure'`, `failureReason: 'incomplete_actions'` |
| **シナリオが正常完了（フォールバック使用、Claude成功報告）** | **`status: 'success'`, `isFromFallback: true`** |
| アクション実行エラー | `status: 'failure'`, `failureReason: 'action_execution_error'` |
| 要素が見つからない | `status: 'failure'`, `failureReason: 'element_not_found'` |
| 期待アクション抽出失敗 → フォールバック | 期待アクション配列に1要素（シナリオ全体）、**`isFromFallback: true`** |
| 画面が変化しない | `status: 'failure'`, `failureReason: 'action_no_effect'` |
| **★v5: 高信頼マッチだが画面変化なし** | **インデックス進行しない、ログに警告出力** |
| **★v5: expectedToolAction=right_click、actual=left_click** | **厳密一致せず、中信頼度として扱う** |
| **★v5: expectedToolAction=click（汎用）、actual=double_click** | **緩和マッチ成功、画面変化あればインデックス進行** |
| **waitアクションが連続しても失敗しない** | **正常に継続（非プログレッシブアクションの閾値緩和）** |
| **screenshotアクションが連続しても失敗しない** | **正常に継続** |
| 同一アクション連続繰り返し（checkProgressで検出） | `status: 'failure'`, `failureReason: 'stuck_in_loop'`, **カウントが二重にならない** |
| 最大イテレーション到達 | `status: 'timeout'`, `failureReason: 'max_iterations'` |
| ユーザー停止 | `status: 'stopped'`, `failureReason: 'user_stopped'` |
| API呼び出し中断 | `status: 'error'`, `failureReason: 'api_error'` |
| **★v6: 期待アクション全完了後もtool_useが継続** | **即時成功終了（残りのtool_useは実行されない）** |
| **★v6: フォールバック時、JSON無し、tool_use停止** | **`status: 'success'`（フォールバック成功）** |
| **★v6: 高信頼マッチ直後は画面変化なし、2アクション後に変化** | **猶予ウィンドウ内で完了判定** |
| **★v7: 低/中信頼マッチが10回連続** | **`status: 'failure'`, `failureReason: 'action_mismatch'`** |
| **★v7: 低信頼マッチ8回→高信頼マッチ→低信頼マッチ5回** | **カウンターリセットにより継続（失敗しない）** |
| **★v7: シナリオ「3ステップで完了」だが2アクションしか抽出されず** | **妥当性警告がログに出力、Claude成功JSON併用で判定** |
| **★v7: 番号付きリスト5件のシナリオで2アクション抽出** | **`validationResult.isValid: false`、警告出力** |
| **★v8: フォールバック時、JSON無し、tool_use停止、エラー/スタックなし** | **`status: 'success'`（ルール統一による成功判定）** |
| **★v8: フォールバック時、JSON無し、tool_use停止、スタック検出あり** | **`status: 'failure'`（スタック検出により失敗）** |
| **★v8: 期待アクション全完了だが妥当性検証失敗** | **即時成功せず、Claude成功JSON待ち** |
| **★v8: scrollアクションが連続しても失敗しない** | **正常に継続（v8で非プログレッシブに追加）** |
| **★v8: テキストフィールドへのクリック（微小な画面変化）** | **中信頼度として継続、猶予ウィンドウで遅延検出** |
| **★v13: waitアクション（expectedToolAction=wait）がキーワードなしで実行** | **actionType厳密一致のみで高信頼扱い、インデックス進行** |
| **★v13: scrollアクション連続中にelement_not_foundカウント** | **カウント対象外のため増加しない（誤判定防止）** |
| **★v13: 「Chromeを開いて、URLを入力して、Enterを押す」（1行複数手順）** | **連接語ベースで3ステップ検出、妥当性検証パス** |
| **★v13: 「次にクリックする」「そして入力する」の連接語シナリオ** | **連接語数+1のステップ数ヒント抽出** |
| **★v13: left_click連続で画面変化なし時のelement_not_foundカウント** | **expectsSubtleChangeのためカウント対象外** |
| **★v16: フォールバック時、JSON無し、追加根拠なし** | **`status: 'failure'`, `failureReason: 'incomplete_actions'`（追加根拠がないため失敗）** |
| **★v16: フォールバック時、JSON無し、verifyFallbackCompletionでverified=true** | **`status: 'success'`（追加根拠Bで成功）** |
| **★v16: Claude失敗JSON（status: failure）だが期待アクション全完了** | **`status: 'success'`（進捗を優先して成功）** |
| **★v16: Claude失敗JSON（status: failure）かつ期待アクション未完了** | **`status: 'failure'`（Claude失敗報告を採用）** |
| **★v16: stopped状態のシナリオアイテムの表示** | **黄色ボーダー（result-stoppedクラス）で表示** |

### 5.3 E2Eテスト

| シナリオ | 期待結果 |
|----------|----------|
| 「メモ帳を開いて文字を入力」 | success + Claude結果JSON |
| 「存在しないアプリを開く」 | failure (element_not_found または action_execution_error) |
| 「同じボタンを100回クリック」 | failure (stuck_in_loop or max_iterations) |
| 「Chromeを起動後、アドレスバーに入力」でChrome未起動 | failure (incomplete_actions または unexpected_state) |
| 1ステップ=複数操作のシナリオ（クリック→待機→入力） | 期待アクションが早期消費されず正しく進行 |
| **「3秒待機して画面確認」（wait連続シナリオ）** | **正常に完了（非プログレッシブで失敗しない）** |
| **★v5: 「ボタンをクリック」だが画面変化なし** | **高信頼マッチでもインデックス進行しない** |
| **★v5: 「ファイルを右クリックしてメニュー表示」** | **right_click厳密一致、画面変化ありでインデックス進行** |
| **★v6: 「アプリを起動して、ウィンドウが表示されたら入力」（非同期UI変化）** | **猶予ウィンドウ内で画面変化を検出し、期待アクション完了** |
| **★v6: 期待アクション3つを完了後、Claudeが追加操作を試みる** | **追加操作前に即時成功終了** |
| **★v7: 「1. アプリを開く 2. ファイルを選択 3. 保存する」（番号付きリスト）** | **3アクション抽出、ステップ数ヒント=3として妥当性検証パス** |
| **★v7: 期待アクションと無関係な操作が続く** | **10回で`action_mismatch`失敗** |

---

## 6. リスクと対策

### 6.1 誤判定のリスク

| リスク | 影響度 | 対策 |
|--------|--------|------|
| 成功を失敗と誤判定 | 中 | スタック検出の閾値を調整可能にする、**進捗ベースフォールバックで救済** |
| 失敗を成功と誤判定 | 高 | Claude結果スキーマの強制 + 期待アクション完了チェック + アクション実行エラーの即時評価 + **★v5: 画面変化を必須条件化** + **★v7: 期待アクション列の妥当性検証** |
| 期待アクション抽出失敗 | 低 | **フォールバックでシナリオ全体を1期待アクション化** |
| 期待アクションの早期消費（1ステップ=複数操作） | 中 | **高信頼マッチ時のみインデックス進行** |
| **★v7: 期待アクション抽出数が不足し早期成功** | 中 | **ステップ数ヒント抽出 + 最低件数検証 + Claude成功JSON併用** |

### 6.2 Claude応答の不安定性

| リスク | 影響度 | 対策 |
|--------|--------|------|
| 結果JSONを返さない | 中 | **期待アクション進捗に基づくフォールバック判定** |
| 不正なJSON形式 | 低 | パース失敗時は進捗ベース判定にフォールバック |
| 言語によるキーワード差異 | 低 | extractBasicKeywordsで主要キーワードを抽出 |

### 6.3 スクリーンショット比較の限界

| リスク | 影響度 | 対策 |
|--------|--------|------|
| 微小な変化（カーソル点滅等）を変化と誤検出 | 低 | サンプリングハッシュで吸収 |
| 大きな変化を同一と誤検出 | 低 | 十分なサンプルサイズを確保 |

### 6.4 期待アクション照合の限界

| リスク | 影響度 | 対策 |
|--------|--------|------|
| アクション抽出が不正確 | 中 | **フォールバック + Claude検証** |
| 追加API呼び出しのコスト | 低 | **低信頼度3回連続時のみClaude検証** |
| 偽陽性（正しいアクションを不一致と誤判定） | 低 | **shouldAdvanceIndexを分離し、不一致でも即時失敗としない** |

### 6.5 同一アクションカウントの二重更新（修正済み）

| リスク | 影響度 | 対策 |
|--------|--------|------|
| sameActionCountが二重にカウントされる | 高 | **checkSameActionRepeatを削除し、checkProgressに統合** |

---

## 7. 調査ログ

### 7.1 実行した検索語（Grep/Globパターン）

| パターン | 目的 |
|----------|------|
| `src/**/*.ts` | TypeScriptソースファイルの特定 |
| `src/**/*.vue` | Vueコンポーネントの特定 |
| `src-tauri/**/*.rs` | Rustソースファイルの特定（targetディレクトリ除外） |
| `*.json` | 設定ファイルの特定 |
| `success\|fail\|failed\|error` | 現在のエラーハンドリング調査 |
| `completed\|result\|judgment\|判定` | 現在の判定ロジック調査 |
| `isScenarioComplete\|end_turn\|stop_reason` | 完了判定ロジック調査 |
| `tool_use\|tool_result\|end_turn` | Claude APIレスポンス処理調査 |
| `BetaMessage\|stop_reason\|text.*block` | 型定義調査 |
| `executeAction\|actionResult\|success` | アクション実行結果の処理調査 |
| `**/*.test.ts` | テストファイル調査 |
| `**/*.spec.ts` | テストファイル調査 |
| `detectLoop\|hashAction` | 既存ループ検出ロジック調査 |

### 7.2 読んだファイル一覧

#### 設定ファイル
- `package.json` - プロジェクト設定
- `tsconfig.json` - TypeScript設定

#### TypeScript（src配下 15ファイル確認）
- `src/main.ts` - エントリポイント
- `src/App.vue` - メインUIコンポーネント（510行）
- `src/services/agentLoop.ts` - エージェントループ実装（478行）- **重点調査**
- `src/services/claudeClient.ts` - Claude APIクライアント（74行）- **変更対象に追加**
- `src/services/scenarioParser.ts` - シナリオ分割（87行）- **参考**
- `src/services/scenarioRunner.ts` - シナリオ実行管理（219行）- **重点調査**
- `src/services/historyManager.ts` - 履歴管理（109行）
- `src/services/index.ts` - サービス再エクスポート
- `src/types/index.ts` - 型定義再エクスポート
- `src/types/scenario.ts` - シナリオ型定義（46行）- **変更対象**
- `src/types/action.ts` - アクション型定義（91行）
- `src/types/capture.ts` - キャプチャ型定義（34行）
- `src/utils/loopDetector.ts` - ループ検出（72行）- **統合対象**
- `src/utils/coordinateScaler.ts` - 座標スケーリング（63行）
- `src/utils/index.ts` - ユーティリティ再エクスポート

#### Rust（src-tauri/src配下 主要ファイル確認）
- `src-tauri/src/main.rs` - エントリポイント
- `src-tauri/src/lib.rs` - ライブラリ定義（69行）
- `src-tauri/src/state.rs` - アプリケーション状態（51行）
- `src-tauri/src/error.rs` - エラー定義（69行）
- `src-tauri/src/commands/control.rs` - 制御コマンド（48行）
- `src-tauri/src/commands/input.rs` - 入力コマンド（97行）

### 7.3 辿った import/依存チェーン

```
agentLoop.ts (成功/失敗判定の中核)
├── claudeClient.ts (API呼び出し) ← 結果スキーマ指示を追加
├── historyManager.ts (履歴管理)
├── loopDetector.ts (ループ検出) ← hashActionを再利用
├── resultJudge.ts (新規: 結果判定) ← 追加
├── actionValidator.ts (新規: アクション照合) ← 追加
└── types/
    ├── action.ts (ComputerAction, ActionRecord, AgentLoopConfig)
    ├── scenario.ts (Scenario, ScenarioStatus)
    ├── capture.ts (CaptureResult)
    └── testResult.ts (新規: TestResult等) ← 追加

scenarioRunner.ts (シナリオ実行管理)
├── agentLoop.ts
└── types/scenario.ts

App.vue (UI)
├── scenarioParser.ts
├── scenarioRunner.ts
└── types/scenario.ts
```

### 7.4 非TSファイル確認の有無

| ファイル種別 | 確認状況 |
|--------------|----------|
| package.json | ✓ 確認済み |
| tsconfig.json | ✓ 確認済み |
| implementation-plan.md | ✓ 確認済み（既存の計画書） |
| test-result-judgment-plan.md | ✓ 確認済み（今回更新対象） |

### 7.5 調査中に発見した関連情報・懸念事項

#### 発見事項
1. **現在の成功判定は非常にシンプル**: `isScenarioComplete`関数は「tool_useがないこと」のみをチェック（`agentLoop.ts:295-297`）
2. **エラー情報は`error`フィールドに文字列で保存**: 構造化されていない（`scenario.ts:20`）
3. **ループ検出は既に実装済み**: `loopDetector.ts`で同一アクションの繰り返しを検出（`hashAction`関数が再利用可能）
4. **UIには基本的な状態表示のみ**: 成功/失敗の詳細表示なし（`App.vue:206-225`）
5. **★アクション実行エラーの処理不足**: `executeAction`が失敗を返しても`tool_result`に文字列で報告するだけで継続（`agentLoop.ts:181-209`）
6. **★シナリオから期待アクションを抽出する仕組みがない**: `scenarioParser.ts`はシナリオ分割のみ

#### 終了パスの調査結果（フィードバック対応）
`agentLoop.ts`の全終了パスを特定:
- L116-117: `abortSignal.aborted` → `{ success: false, error: 'Aborted' }`
- L120-121: `stopRequested` → `{ success: false, error: 'Stopped by user' }`
- L132-134: `response === null` → `{ success: false, error: 'API call aborted' }`
- L137-140: `isScenarioComplete` → `{ success: true }`
- L171-176: `detectLoop` → `{ success: false, error: 'Infinite loop detected' }`
- L228-232: max iterations → `{ success: false, error: 'Max iterations reached' }`
- L234-237: catch block → `{ success: false, error: errorMessage }`

#### 懸念事項
1. **Claudeの応答形式の不確実性**: 結果スキーマを要求しても、常に含まれるとは限らない → **進捗ベースフォールバックで対応**
2. **スクリーンショット比較の精度**: 簡易ハッシュでは微細な変化を捉えられない可能性
3. **テストの不足**: 現在テストファイルが存在しない
4. **期待アクション抽出のAPI呼び出しコスト**: シナリオ開始時に追加のAPI呼び出しが発生 → 1回のみに制限
5. **既存loopDetectorとの統合**: `hashAction`を再利用することで整合性を確保

---

## 8. 結論

### 実装すべき内容

1. **型定義の追加**: `TestResult`型で詳細な結果情報を構造化（`completedActionIndex`含む）
2. **アクション実行エラーの即時評価**: `executeAction`の失敗時に即時終了し`failureReason`にマッピング
3. **Claude結果スキーマの強制（改善版）**: システムプロンプトでJSON形式の結果出力を要求、**未返却時は期待アクション進捗に基づくフォールバック**
4. **期待アクション照合（改善版）**: シナリオを期待アクション列に分解、**高信頼マッチ時のみインデックス進行**
5. **期待アクション抽出フォールバック**: 抽出失敗時はシナリオ全体を1つの期待アクションとして扱う
6. **全終了パスでのTestResult生成**: `agentLoop`の全return文で`createTestResult`を呼び出し
7. **checkProgress呼び出し（統合版）**: アクション実行後に`checkProgress`を呼び出し、**同一アクション検出も統合（二重カウント防止）**
8. **結果判定モジュール**: `resultJudge.ts`でClaude応答分析とスタック検出を実装（既存`loopDetector`と統合）
9. **UI改善**: 成功/失敗の視覚的表示と詳細情報の表示（**4カテゴリ表示: Passed/Failed/Stopped/Pending** - v17統一）

### 優先度

| 項目 | 優先度 | 理由 |
|------|--------|------|
| 型定義追加（`PendingHighConfidenceMatch`含む） | 高 | 他の実装の前提 |
| **★v6: 期待アクション全完了時の即時成功確定** | 高 | v6重大度高フィードバック対応 |
| アクション実行エラー即時評価 | 高 | 重大度高フィードバック対応 |
| Claude結果スキーマ強制 | 高 | 重大度高フィードバック対応 |
| analyzeClaudeResponse呼び出し（進捗フォールバック含む） | 高 | フィードバック3対応 |
| **★v6: フォールバック時JSON欠如対応** | 高 | v6重大度中フィードバック対応 |
| **★v7: analyzeClaudeResponse本体にフォールバック分岐明示追加** | 高 | v7重大度中フィードバック対応 |
| checkProgress呼び出し（同一アクション検出統合） | 高 | フィードバック2対応 |
| 期待アクション照合（高信頼マッチ時のみ進行） | 高 | フィードバック1対応 |
| 期待アクション抽出フォールバック | 高 | フィードバック4対応 |
| **★v7: 低/中信頼マッチ連続時のaction_mismatch失敗** | 中 | v7重大度中フィードバック対応 |
| **★v7: 期待アクション列の妥当性検証** | 中 | v7重大度中フィードバック対応 |
| **★v6: 画面変化猶予ウィンドウ** | 中 | v6重大度中フィードバック対応 |
| 全終了パスでのTestResult生成 | 中 | 重大度中フィードバック対応 |
| UI改善（4カテゴリ: Passed/Failed/Stopped/Pending） | 中 | 重大度中フィードバック対応（v17統一） |
| 単体テスト | 低 | 動作確認後に追加 |

---

## 9. フィードバック対応サマリー（v18）

### 対応した指摘事項

#### 今回の新規フィードバック対応（v18）

| 重大度 | 指摘内容 | 対応内容 | 対応箇所 |
|--------|----------|----------|-----------|
| **中** | フォールバック成功判定のルールがv11とv16の説明で併記されており、最終の判定フローが一つに統一されていないため、古い条件で実装すると成功/失敗の判定がズレる恐れがある | **最新版の判定フローを1つの決定木/疑似コードに統一**。v11以前のルール（「tool_use停止＋エラー/スタックなし＝成功」）は廃止とし、v16以降の「追加根拠必須」ルールを最終版として明確化 | セクション 1.4（v18追加: 統一判定フロー決定木（最終版）） |
| **中** | フォールバック成功の追加根拠Bが「最終画面でのキーワード存在確認」に依存しており、開始画面から同じ要素が存在するケースや完了条件が画面に現れないケースで誤判定し得る | **最終アクションの期待要素・直前画面との差分・完了状態の再確認を追加**。`verifyFallbackCompletion`関数に開始時/直前画面のスクリーンショットと最終アクション情報を追加パラメータとして渡し、差分検証・confidence判定を追加。low confidenceは失敗扱い | セクション 1.4（v18追加: 追加根拠Bの誤判定対策）, agentLoopデータフロー（v18更新） |
| **中** | 既存`loopDetector`を維持しつつ`checkProgress`でもスタック検出を行う方針だが、優先順位や重複時のfailureReason確定ルールが明記されていない | **loopDetectorを主判定、checkProgressを補完として優先順位を明確化**。重複検出時はloopDetectorを優先し、failureReasonは両者とも`stuck_in_loop`に統一（検出機構の違いはanalysisフィールドに記載）。フローチャートと統合コード例を追加 | セクション 4.3（v18更新: ループ検出との関係） |

#### 前回のフィードバック対応（v17）

| 重大度 | 指摘内容 | 対応内容 | 対応箇所 |
|--------|----------|----------|-----------|
| **中** | フォールバック成功判定が`additionalConfirmation`/`verifyFallbackCompletion`に依存しているが、最終スクリーンショットの取得・保持のデータフローが明記されておらず、`TestResult`から`lastScreenshot`を削除する方針とも矛盾しているため、フォールバック時の成功判定が実装不能になり得る | **`agentLoop`終了時に最新スクリーンショットを取得して`additionalConfirmation`を生成・受け渡す手順（保存先/寿命含む）を追加記載**。最終スクリーンショットは`TestResult`に保存せず、`agentLoop`内で一時的に保持してフォールバック検証にのみ使用し破棄する方針を明確化。`analyzeClaudeResponse`関数シグネチャに`additionalConfirmation`パラメータを追加 | セクション 1.4（v17追加: agentLoopでの最終スクリーンショット取得・受け渡しデータフロー） |
| **低** | UI集計方針が「success以外は失敗」と「Stopped/Errorを別枠表示」で矛盾しており、実装者の解釈がぶれる | **UI仕様を一本化**。結論セクションと優先度表の記述を「4カテゴリ表示: Passed/Failed/Stopped/Pending」に統一し、v15で導入した4カテゴリ方針と整合させた | セクション 8 結論（v17統一）, 優先度表（v17統一） |

#### 前回のフィードバック対応（v16）

| 重大度 | 指摘内容 | 対応内容 | 対応箇所 |
|--------|----------|----------|-----------|
| **高** | フォールバック（`isFromFallback`）や妥当性検証NG時の成功条件が「`tool_use`停止＋期待アクション完了」で足りており、抽出漏れがあると未完了でも成功判定になり得る | **フォールバック時は成功確定に追加根拠（Claude成功JSON、最終targetElements検証、シナリオ再確認）を必須化**。根拠がない場合は`incomplete_actions`で失敗扱い。`verifyFallbackCompletion`関数を追加し、最終画面でキーワード存在を確認 | セクション 1.4（v16追加: フォールバック時の成功確定に追加根拠を必須化）, フォールバック判定ルール表（v16更新） |
| **中** | Claudeの結果JSONが`status: failure`の場合に進捗と突合せず即失敗確定しており、期待アクション完了・画面変化が成立しているケースで誤失敗になり得る | **Claude失敗報告時に`completedActionIndex >= expectedActions.length`をチェックし、期待アクション全完了なら進捗を優先して成功判定**。期待アクション未完了の場合のみClaude失敗報告を採用 | Phase 3 ステップ 3.2（v16更新: analyzeClaudeResponse内のClaude失敗報告処理） |
| **低** | UIのシナリオ一覧が「success以外=失敗」クラス前提のままで、Stopped/Error別枠表示と視覚表示が一致しない | **`result-stopped`クラスを追加し、Stopped/Errorを視覚的に分離**。シナリオアイテムの`:class`バインディングを3分類（success/failure/stopped）に拡張し、CSSに`.result-stopped`（黄色ボーダー）を追加 | Phase 7 ステップ 7.1（v16更新: シナリオアイテム:classとCSS） |

#### 前回のフィードバック対応（v15）

| 重大度 | 指摘内容 | 対応内容 | 対応箇所 |
|--------|----------|----------|-----------|
| **高** | 妥当性検証NG時に`tool_use`停止＋Claude成功JSONを必須にしており、JSON未返却だとシナリオ完了でも失敗になり得る（到達=成功という依頼条件に反する） | **JSON未返却時でも「期待アクション全完了 + tool_use停止 + エラー/スタックなし」であれば成功と判定する「パターンB」を追加**。v9の厳格なルールを緩和し、依頼条件「最後まで到達できれば成功」を満たす | セクション 1.4（v15追加: JSON未返却時の成功条件）, 成功確定ルール表（v15更新） |
| **中** | 低/中信頼が一定回数続くと即`action_mismatch`失敗にする設計は、補助操作が多いシナリオで誤失敗を誘発し得る | **カウンタ増加を「画面変化なし」かつ「completedActionIndexが進まない」場合に限定**。補助操作（スクロール、ポップアップ閉じ等）では画面変化があるためカウントが増加せず、誤失敗を防止 | セクション 1.4（v15更新: 低/中信頼マッチ連続時の判定ロジック） |
| **低** | UIサマリーで`stopped`/`error`を「Failed」に合算するため、ユーザー停止が「アクション不能の失敗」と同列に見える | **サマリーを4カテゴリ（Passed/Failed/Stopped/Pending）に分割**。Stoppedを黄色で別枠表示し、ユーザー停止と本当の失敗を区別 | セクション 1.4（v15更新: UI上の成功/失敗の定義）, Phase 7 ステップ 7.1（v15更新） |

#### 前回のフィードバック対応（v13）

| 重大度 | 指摘内容 | 対応内容 | 対応箇所 |
|--------|----------|----------|-----------|
| **中** | `validateActionAndCheckProgress`と`EXTRACT_ACTIONS_PROMPT`の組み合わせだと、`wait/screenshot/mouse_move/scroll`など非プログレッシブアクションのキーワードが空になりやすく、`actionType`一致だけでは`shouldAdvanceIndex=false`のまま進捗が進まない可能性 | **非プログレッシブアクションは`actionType`厳密一致のみで高信頼扱いに変更**。また`EXTRACT_ACTIONS_PROMPT`を更新し、非プログレッシブアクション用のキーワード抽出を必須化 | セクション 1.4（v13追加: 非プログレッシブアクションのキーワード抽出必須化） |
| **中** | `element_not_found`昇格ロジック（`!screenChanged && low/medium`）は非プログレッシブ/微小変化アクションでもカウントが進むため、正常な待機・スクロールで誤って失敗判定になり得る | **`requiresScreenChange`がtrueのときのみカウント**。非プログレッシブアクション（`isNonProgressiveAction`）や微小変化アクション（`expectsSubtleChange`）はスキップまたはリセット | セクション 1.4（v13追加: element_not_found昇格ロジックの非プログレッシブ対応） |
| **中** | `validateExpectedActionsCount`は行数・明示的なステップ数ヒントに依存するため、1行で複数手順を書いたシナリオの抽出漏れを検知できず、早期成功で未完了が成功扱いになり得る | **連接語ベースの簡易ヒューリスティック（「次に/そして/後に/and/then/、」など）を追加**。妥当性が弱い場合は既存のv9ルール（`tool_use`停止＋Claude成功JSON＋エラー/スタックなし）を維持 | セクション 1.4（v13追加: 連接語ベースのステップ数ヒューリスティック） |

#### 前回の新規フィードバック対応（v12）

| 重大度 | 指摘内容 | 対応内容 | 対応箇所 |
|--------|----------|----------|-----------|
| **中** | `element_not_found`を`executeAction`のエラー文字列/Claude自己申告に依存しており、座標クリック主体の実行系では「アイコン/テキストが見つからない」失敗を確実に拾えない | **`targetElements`を使った事前/事後の視覚検証ルールを追加**。また「画面変化なし＋低信頼連続」を`element_not_found`に昇格するルールを追加 | セクション 1.4（v12追加: element_not_found検出の強化） |
| **中** | 画面変化判定が`hashScreenshot`の簡易サンプリング一致のみで、時計/カーソル/アニメーション等のノイズで「進捗あり」と判定し`completedActionIndex`が誤進行する恐れ | **差分しきい値・知覚ハッシュ・動的領域マスク等のノイズ耐性方針を追加** | セクション 1.4（v12追加: 画面変化判定のノイズ耐性）, Phase 6 ステップ 6.1 |
| **低** | `ScenarioRunner`の更新方針がsuccess/それ以外の二分のみで、既存の`stopped`表示が失われる可能性 | **`stopped`/`aborted`を保持する分岐方針を追記**。`TestResultStatus`に基づく適切なステータスマッピングを追加 | Phase 6 ステップ 6.3（v12更新） |

#### 前回の新規フィードバック対応（v11）

| 重大度 | 指摘内容 | 対応内容 | 対応箇所 |
|--------|----------|----------|-----------|
| **高** | 早期成功条件（72行目）に`isFromFallback`を含めると、フォールバック時に`tool_use`継続中でも即成功になり、シナリオ未完了でも成功扱いになり得る | **`isFromFallback`を早期成功条件から削除**。フォールバック時は早期成功判定ではなく`analyzeClaudeResponse`に委ね、`tool_use`停止＋Claude成功JSON＋エラー/スタックなしの全条件を要求 | セクション 1.4（v11更新: 早期成功条件のコード例） |
| **中** | 116行目の「抽出できない場合は失敗」と124行目の「フォールバック時は成功可」が矛盾し、実装がぶれる | **フォールバック適用時の判定ルールを統一**。正常抽出時（`isFromFallback: false`）は期待アクション未完了で失敗、フォールバック時（`isFromFallback: true`）は`tool_use`停止＋エラー/スタックなしで成功と明確化 | セクション 1.4（v11更新: 結果JSON未返却時の方針） |
| **低** | `FailureReason`に`action_execution_error`と`execution_error`が並存し意味が重複、`lastScreenshot`も「保存しない」方針と不整合 | **`execution_error`を削除し`action_execution_error`に統合**。**`lastScreenshot`を型定義から削除**（ログ容量削減方針と整合） | Phase 1 ステップ 1.1（型定義） |

#### 前回の新規フィードバック対応（v10）

| 重大度 | 指摘内容 | 対応内容 | 対応箇所 |
|--------|----------|----------|-----------|
| **中** | `src/services/actionValidator.ts` の `validateActionAndCheckProgress` 返却型に `expectsSubtleChange` が定義されていないのに返却値で使用している | **返却型に`expectsSubtleChange?: boolean`を追加**。これにより、微小変化フラグを明示的に返却可能に | Phase 4 ステップ 4.1（返却型定義） |
| **中** | `src/services/resultJudge.ts` の `isNonProgressiveAction` / `expectsSubtleScreenChange` で `ComputerActionType` を使う前提だが import が計画に含まれていない | **import文に`ComputerActionType`を追加**。`import type { ComputerAction, ComputerActionType } from '../types';`に修正 | Phase 6 ステップ 6.1（resultJudge.ts import） |

#### 前回の新規フィードバック対応（v9）

| 重大度 | 指摘内容 | 対応内容 | 対応箇所 |
|--------|----------|----------|-----------|
| **高** | 妥当性検証が不一致でもClaude成功JSONがあれば成功確定する記述があり、抽出不足でも「成功」と判定され得る | **妥当性検証NG時の成功確定条件を厳格化**。Claude成功JSONのみでは成功確定せず、`tool_use`停止＋Claude成功JSON＋エラー/スタックなしの**すべての条件**が揃った場合のみ成功を許可 | セクション 1.4（v9追加: 妥当性検証NG時の成功確定ルール表）, Phase 3 ステップ 3.2 |
| **中** | `expectsSubtleChange`/`expectsSubtleScreenChange`を定義しているが、進捗判定・スタック判定への適用手順が明示されていない | **`validateActionAndCheckProgress`と`checkProgress`で微小変化アクションへの適用手順を明示化**。微小変化アクション（left_click等）は画面変化なしでもhigh confidenceを維持し猶予ウィンドウに委ねる。`checkProgress`では閾値を2倍に緩和 | Phase 4 ステップ 4.1, Phase 6 ステップ 6.1 |

#### v9での確認事項への回答

| 確認事項 | 回答 |
|----------|------|
| **妥当性検証NG時の「追加根拠」はClaude成功JSONのみで十分か、それとも`tool_use`停止やUI状態確認まで必要か** | **`tool_use`停止まで必要**。v9では、妥当性検証NGの場合、Claude成功JSONのみでは成功確定せず、以下のすべてが揃った場合のみ成功を許可する：(1) `tool_use`停止、(2) Claude成功JSON、(3) エラー/スタック検出なし。これにより、抽出不足（例: 5ステップで2アクションしか抽出されない）の場合でも、Claudeが本当に完了と判断するまで継続し、誤った早期成功を防止する。 |

#### 前回のフィードバック対応（v8）

| 重大度 | 指摘内容 | 対応内容 | 対応箇所 |
|--------|----------|----------|-----------|
| **高** | フォールバック時（`isFromFallback`）のJSON欠如の扱いが「成功」「失敗」で矛盾しており、完了シナリオを失敗扱いにする実装が入り得る | **フォールバック時のJSON欠如ルールを統一表で明示化**。「tool_use停止＋エラー/スタックなし＝成功」を採用し、矛盾を解消 | セクション 1.4（v8追加: JSON欠如ルール統一表） |
| **高** | 期待アクション全完了の早期成功チェックが`completedActionIndex`のみで、抽出妥当性検証を参照していないため、抽出漏れがあると未完了でも成功確定し得る | **agentLoopの早期成功チェックに`validateExpectedActionsCount`を追加**。妥当性が低い場合は即時成功せず、Claude成功JSONまたはtool_use停止を追加根拠として要求 | セクション 1.4（v6-1 + v8更新）, Phase 4 ステップ 4.2 |
| **中** | 画面変化必須の判定で非プログレッシブ扱いが`wait/screenshot/mouse_move`に限定されており、フォーカス移動や軽微なUI変化のクリックなど正しい操作が「変化なし」で失敗扱いになり得る | **非プログレッシブアクションに`scroll`を追加**。また`expectsSubtleScreenChange`関数を追加し、軽微なUI変化への対策（猶予ウィンドウ、Claude検証、中信頼度継続）を明文化 | Phase 4 ステップ 4.1, Phase 6 ステップ 6.1 |

#### 前回のフィードバック対応（v7）

| 重大度 | 指摘内容 | 対応内容 | 対応箇所 |
|--------|----------|----------|-----------|
| **中** | `action_mismatch`を失敗理由として定義しているのに、不一致を失敗にする判定が計画内に見当たらず「次のアクションと一致しない」ケースがタイムアウト/ループ扱いになり得る | **`lowConfidenceActionCount`カウンターを追加し、低/中信頼マッチが10回続いたら`failureReason: 'action_mismatch'`で終了する条件を追加** | セクション 1.4（v7対応）, Phase 4 ステップ 4.2 |
| **中** | v6-2で「フォールバック時にJSON欠如なら成功」と書いているが、Phase 3の`analyzeClaudeResponse`本体にはその分岐が入っておらず実装時に漏れる恐れ | **`analyzeClaudeResponse`の`isComplete`分岐の冒頭に`isFromFallback && !resultOutput && !hasToolUse`チェックを明示追加**。セクション1.4のv6-2と整合させた | Phase 3 ステップ 3.2 |
| **中** | 成功判定が`completedActionIndex >= expectedActions.length`依存だが、`extractExpectedActions`は「非空なら成功」扱いで抽出精度の妥当性チェックがなく、抽出が欠落すると早期成功になり得る | **`extractStepCountHint`と`validateExpectedActionsCount`を追加**。シナリオ文のステップ数との突合・最低件数の検証を行い、Claude成功JSONとの併用で「期待アクション列の妥当性」を確認してから早期成功を許可 | セクション 1.4（v7対応）, Phase 4 ステップ 4.1 |

#### 前回のフィードバック対応（v6）

| 重大度 | 指摘内容 | 対応内容 | 対応箇所 |
|--------|----------|----------|-----------|
| **高** | `completedActionIndex`が`expectedActions.length`に到達しても、`hasToolUse`がある限り完了判定に入らず、余計な`tool_use`継続で失敗に転ぶ可能性 | **agentLoopのイテレーション先頭で`completedActionIndex >= expectedActions.length`をチェックし、全完了時は即時成功終了**。残りの`tool_use`は実行しない。`analyzeClaudeResponse`にも全完了時のガードを追加 | Phase 4 ステップ 4.2, セクション 1.4（v6-1） |
| **中** | フォールバック時（`isFromFallback: true`）にJSON未返却かつ`tool_use`が止まった場合、`analyzeClaudeResponse`の`isComplete`分岐で`incomplete_actions`失敗になる | **フォールバック時はJSON欠如でも、`tool_use`停止＋エラー/スタックなしなら成功と判定**。「JSON欠如は補助的理由」方針と整合 | Phase 3 ステップ 3.2, セクション 1.4（v6-2） |
| **中** | 画面変化を「同一アクション直後」のみで判定しているため、UI変化が`wait`の後に出るケースで期待アクション完了が認識されず失敗しやすい | **`pendingHighConfidenceMatch`構造を導入し、高/中信頼マッチ後は猶予ウィンドウ（2アクション）内の画面変化も完了判定に使用**。猶予期間内に画面変化があれば遡って完了扱い | Phase 4 ステップ 4.2, セクション 1.4（v6-3） |
| **低** | 影響範囲では`src/services/scenarioParser.ts`に期待アクション抽出を追加とある一方、実装手順は新規`src/services/actionValidator.ts`に実装しており記述が不整合 | **影響範囲テーブルの`scenarioParser.ts`を「変更なし」に修正**。期待アクション抽出は`actionValidator.ts`に実装 | セクション 2.1, 2.3 |

#### Questionsへの回答（v6）

| 質問 | 回答 |
|------|------|
| **期待アクションが完了した時点でClaudeが`tool_use`を続けても即時終了させる前提で良いですか？** | **はい**。期待アクション全完了時点で成功を確定し、残りの`tool_use`を無視/中断します。これにより余計な操作による誤判定を防ぎます。 |
| **フォールバック時にJSONが無い場合、エラー/スタックなしなら success 扱いで問題ないですか？** | **はい**。フォールバック時はシナリオ全体が1つの期待アクションとして扱われるため、Claudeがエラー報告なしで完了した場合は成功とみなします。ただし、明示的なエラー/スタック検出がない場合に限ります。 |

#### 前回のフィードバック対応（v5）

| 重大度 | 指摘内容 | 対応内容 | 対応箇所 |
|--------|----------|----------|-----------|
| **高** | `validateActionAndCheckProgress`の設計はキーワード/Claude応答テキストのみで`completedActionIndex`を進めるため、画面が変わらないクリックでも成功扱いになり得る | **画面変化（`screenChanged`）を`shouldAdvanceIndex`の必須条件として組み込み**。アクション実行後に画面変化を検出し、変化がない場合はインデックスを進行しない。非プログレッシブアクション（wait/screenshot/mouse_move）は例外として扱う | Phase 4 ステップ 4.1, 4.2, セクション 1.4 |
| **中** | `actionTypeMatches`が「クリック系かどうか」だけで一致判定しており、`left_click`と`right_click`/`double_click`の違いが無視される | **`actionTypeStrictMatch`フラグを追加し、`expectedToolAction`が具体的（`left_click`、`right_click`等）な場合は厳密一致を要求**。`expectedToolAction === 'click'`（汎用クリック）の場合のみ緩和マッチを許可。高信頼度判定には`actionTypeStrictMatch`を使用 | Phase 4 ステップ 4.1 |
| **低** | `checkSameActionRepeat`の削除が計画内で繰り返し言及されているが、現状コードには該当関数がなく作業項目が宙に浮く | **計画書の記述を修正**。「削除」ではなく「checkProgress内に統合的に新規実装」が正確な表現であることを明記 | セクション 1.4 |

#### 前回のフィードバック対応（v4）

| 重大度 | 指摘内容 | 対応内容 | 対応箇所 |
|--------|----------|----------|-----------|
| **高** | `extractExpectedActions`失敗時は「Claude成功なら成功」と書いているが、`analyzeClaudeResponse`は`expectedActions.length === 0`のときしかClaude成功を採用せず、フォールバック（1件返却）だと成功判定がブロックされ得る | `extractExpectedActions`の戻り値に`isFromFallback`フラグを追加。`analyzeClaudeResponse`に`isFromFallback`引数を追加し、フォールバック時はClaude成功報告を採用 | Phase 4 ステップ 4.1, Phase 3 ステップ 3.2, セクション 1.4 |
| **中** | `checkProgress`が`wait`/`screenshot`/`mouse_move`など画面変化が起きにくいアクションでも「変化なし/同一アクション連続」で失敗判定するため、正常な待機や更新待ちで失敗になり得る | `isNonProgressiveAction`関数を追加し、非プログレッシブアクションは変化なしカウントを増加させない。同一アクション検出の閾値も緩和（2倍、最低10回） | Phase 6 ステップ 6.1 |
| **中** | `askClaudeForActionCompletion`が`client.messages.create`で画像付きリクエストを送っており、computer-useモデルが`beta.messages.create`+`betas`ヘッダ必須の場合は実行不能になる | ビジョン対応の通常モデル（Sonnet: `claude-sonnet-4-20250514`）を使用するよう変更。この関数は画像解析のみでtool_useを使用しないため、betaヘッダ不要 | Phase 4 ステップ 4.1 |

#### 前回のフィードバック対応（v3）

| 重大度 | 指摘内容 | 対応内容 | 対応箇所 |
|--------|----------|----------|-----------|
| **高** | Claudeの結果JSONを受け取った場合に期待アクション完了の検証がなく、未完了でも成功になり得る | `analyzeClaudeResponse`でJSON採用前に`completedActionIndex >= expectedActions.length`を検証。不一致なら`shouldContinue=true`で継続、またはtool_useがなければ`incomplete_actions`で失敗 | Phase 3 ステップ 3.2, セクション 1.4 |
| **高** | 期待アクション照合が`toolAction.text`とアクション種別だけに依存し、クリック系は`text`が無く高信頼マッチに到達しない | `claudeResponseContext`パラメータを追加し、直前のClaude応答テキストからキーワード/targetElementsを照合。中信頼度が続いた場合はClaude視覚検証を実行 | Phase 4 ステップ 4.1, 4.2, セクション 1.4 |

#### 前回の対応済み事項（v2）

| 重大度 | 指摘内容 | 対応内容 | 対応箇所 |
|--------|----------|----------|-----------|
| 高 | `completedActionIndex`を`tool_use`ごとに増加させる設計で期待アクションを消費し過ぎる | `validateActionAndCheckProgress`で**高信頼マッチ時のみshouldAdvanceIndex=true**を返す設計に変更。中/低信頼度ではインデックスを進めない | Phase 4 ステップ 4.1, 4.2 |
| 中 | `checkSameActionRepeat`と`checkProgress`がsameActionCountを二重に更新 | **checkSameActionRepeatを削除**し、checkProgressに同一アクション検出を統合。sameActionCountの更新は一箇所のみ | Phase 6 ステップ 6.1, セクション 1.4 |
| 中 | 結果JSON未返却時を無条件失敗とする方針でシナリオ到達後もフォーマット不備で失敗 | **期待アクション完了/進捗判定に基づくフォールバック**を追加。期待アクションが全完了なら成功判定。JSON欠如は補助的な失敗理由にとどめる | Phase 3 ステップ 3.2, セクション 1.4 |
| 中 | `extractExpectedActions`失敗時に照合を完全スキップしClaude自己申告に依存 | 失敗時は**シナリオ全体を1つの期待アクションとして返すフォールバック**を追加。`extractBasicKeywords`で主要キーワードを抽出 | Phase 4 ステップ 4.1, セクション 1.4 |

### 主要な設計変更（v18更新）

#### v18での変更

1. **統一判定フロー決定木の追加（新規 v18 - 重大度: 中）**
   - v11とv16でフォールバック成功判定のルールが併記されており、実装者が混乱する恐れがあった
   - 最終的な判定フローを1つの決定木/疑似コードとして統一
   - v11以前のルール（「tool_use停止＋エラー/スタックなし＝成功」）は廃止と明記
   - v16以降の「追加根拠必須」ルールを最終版として明確化
   - 疑似コード、フロー図、判定ルール表を追加

2. **追加根拠B（verifyFallbackCompletion）の誤判定対策（新規 v18 - 重大度: 中）**
   - v16の追加根拠Bは「最終画面でのキーワード存在確認」のみで、以下のケースで誤判定が発生し得た:
     - 開始画面から同じ要素が存在するケース
     - 完了条件が画面に現れないケース
   - 解決策として以下を追加:
     - **強化1**: 直前画面との差分検証（`previousScreenshotBase64`パラメータ追加）
     - **強化2**: 完了状態の明示的確認（プロンプト改善）
     - **強化3**: 最終アクションの期待結果確認（`lastExecutedAction`パラメータ追加）
   - `confidence`フィールドを追加し、`low`の場合は`verified: false`に強制

3. **loopDetectorとcheckProgressの優先順位・重複時ルールの明文化（新規 v18 - 重大度: 中）**
   - 既存の`loopDetector`を維持しつつ`checkProgress`でもスタック検出を行う方針だが、優先順位が明記されていなかった
   - 解決策:
     - **loopDetectorが主判定**: 完全一致検出で誤検出リスクが低いため
     - **checkProgressは補完**: 閾値未満でも画面変化がない状態を検出
   - 重複検出時の統合ルールを疑似コードとフローチャートで明示
   - `failureReason`は両者とも`stuck_in_loop`に統一（検出機構の違いは`analysis`に記載）

#### v17での変更

1. **agentLoopでの最終スクリーンショット取得・受け渡しデータフローを明確化（新規 v17 - 重大度: 中）**
   - `verifyFallbackCompletion`関数は最終スクリーンショット（`finalScreenshotBase64`）を必要とするが、`TestResult`から`lastScreenshot`を削除する方針と矛盾していた
   - 解決策: 最終スクリーンショットは`TestResult`に保存せず、`agentLoop`内で一時的に保持
   - データフロー:
     1. `agentLoop`のツール実行ループ内で`captureResult.imageBase64`を保持（既存変数を流用）
     2. `analyzeClaudeResponse`を呼び出す前に、フォールバック条件を満たす場合のみ`verifyFallbackCompletion`を呼び出す
     3. 検証完了後、スクリーンショットは破棄（`TestResult`には保存しない）
   - `analyzeClaudeResponse`関数シグネチャに`additionalConfirmation`パラメータを追加
   - `AdditionalConfirmation`インターフェースを`resultJudge.ts`に追加

2. **UI集計方針の統一（新規 v17 - 重大度: 低）**
   - 結論セクション（セクション8）で「success以外は全て失敗としてカウント」と記載されていた
   - Phase 7では「Passed/Failed/Stopped/Pendingの4カテゴリ」と記載されており矛盾していた
   - 解決策: 全記述を「4カテゴリ表示: Passed/Failed/Stopped/Pending」に統一
   - v15で導入した4カテゴリ方針と整合させた

#### v16での変更

1. **フォールバック時の成功確定に追加根拠を必須化（新規 v16 - 重大度: 高）**
   - v11のフォールバックルールは「tool_use停止＋エラー/スタックなし」だけで成功と判定していた
   - 期待アクション抽出に漏れがあった場合（例: 5ステップシナリオで1アクションしか抽出されない）、未完了でも成功扱いになる問題があった
   - フォールバック時（`isFromFallback: true`）のJSON欠如時は追加根拠を必須化:
     - **追加根拠A**: Claude成功JSON（Claudeが`status: success`を返した場合）
     - **追加根拠B**: `verifyFallbackCompletion`による最終画面検証（キーワード存在確認）
     - **追加根拠C**: Claudeによるシナリオ完了再確認
   - 追加根拠がない場合は`incomplete_actions`で失敗扱い

2. **Claude失敗JSON時の進捗突合を追加（新規 v16 - 重大度: 中）**
   - Claudeが`status: failure`のJSONを返した場合でも、期待アクション完了状況と突合
   - `completedActionIndex >= expectedActions.length`（期待アクション全完了）の場合は進捗を優先して成功判定
   - 期待アクション未完了の場合のみClaude失敗報告を採用
   - これにより「Claudeが次のステップを見つけられずに失敗報告したが、実はシナリオ完了済み」のケースを救済

3. **UIシナリオアイテムにresult-stoppedクラスを追加（新規 v16 - 重大度: 低）**
   - v15でサマリーは4カテゴリに分割したが、シナリオ個別アイテムは2分類のままだった
   - シナリオアイテムの`:class`バインディングを3分類に拡張:
     - `result-success`: `status === 'success'`
     - `result-stopped`: `status === 'stopped'` または `status === 'error'`
     - `result-failure`: `status === 'failure'` または `status === 'timeout'`
   - CSSに`.result-stopped`（黄色ボーダー: `border-left: 4px solid #ffc107`）を追加
   - これによりサマリーと個別アイテムの視覚表示が一致

#### v15での変更

1. **JSON未返却時でも成功とする条件を追加（新規 v15 - 重大度: 高）**
   - v9では妥当性検証NG時にClaude成功JSONを必須としていたが、これでは「最後まで到達できれば成功」という依頼条件に反する
   - **パターンB**を追加: JSON未返却でも以下の全条件を満たせば成功と判定
     - `tool_use`停止
     - `completedActionIndex >= expectedActions.length`（期待アクション全完了）
     - エラー/スタック検出なし
     - 明示的な失敗報告がない
   - これにより依頼条件「最後まで到達できれば成功」を満たす

2. **低/中信頼マッチ連続時の`action_mismatch`判定を改善（新規 v15 - 重大度: 中）**
   - v7では低/中信頼マッチが10回続くと即座に`action_mismatch`失敗になっていた
   - 補助操作（スクロール、ポップアップ閉じ、複数回クリック等）が多いシナリオで誤失敗を誘発する問題があった
   - カウンタ増加条件を厳格化: 以下の**両方**を満たす場合のみカウント増加
     - `!screenChanged`（画面変化なし）
     - `completedActionIndex === previousCompletedActionIndex`（期待アクションインデックスが進行していない）
   - 画面変化があるか、completedActionIndexが進行した場合はカウンターをリセット

3. **UIサマリーでStopped/Errorを別枠表示（新規 v15 - 重大度: 低）**
   - v12ではUIサマリーで`stopped`/`error`を「Failed」に合算していた
   - ユーザー停止と本当の失敗が同列に見える問題があった
   - サマリーを4カテゴリに分割:
     - **Passed** (緑): `status === 'success'`
     - **Failed** (赤): `status === 'failure'` または `status === 'timeout'`
     - **Stopped** (黄): `status === 'stopped'` または `status === 'error'`
     - **Pending** (グレー): 未完了
   - `.summary-item.stopped`のCSSスタイルを追加（黄色背景、黒文字）

#### v13での変更

1. **非プログレッシブアクションのキーワード抽出必須化と高信頼扱い（新規 v13）**
   - `validateActionAndCheckProgress`で非プログレッシブアクション（wait/screenshot/mouse_move/scroll）に対する特別処理を追加
   - 非プログレッシブアクションは`actionType`厳密一致のみで高信頼扱いとし、画面変化なしでもインデックス進行可能に
   - `EXTRACT_ACTIONS_PROMPT`を更新し、非プログレッシブアクション用のキーワード（wait→「待機」、scroll→「スクロール」等）の抽出を必須化

2. **element_not_found昇格ロジックの非プログレッシブ対応（新規 v13）**
   - `noProgressLowConfidenceCount`のカウント条件に`validation.requiresScreenChange`を追加
   - 非プログレッシブアクション（`isNonProgressiveAction`）や微小変化アクション（`expectsSubtleChange`）はカウント対象外に
   - これにより正常な待機・スクロールで誤って`element_not_found`判定になる問題を防止

3. **連接語ベースのステップ数ヒューリスティック（新規 v13）**
   - `extractStepCountHint`に連接語ベースのヒューリスティックを追加
   - 日本語連接語（「次に」「そして」「その後」「後に」等）および英語連接語（「then」「and then」「after that」等）を検出
   - 句読点（「、」「,」）で区切られた動詞句パターンも検出
   - 連接語数+1をステップ数ヒントとして返却し、1行複数手順シナリオの抽出漏れを検知

#### v12での変更

1. **element_not_found検出の強化（新規 v12）**
   - 座標ベースの`executeAction`では「要素が見つからない」を検出できない問題に対応
   - `verifyTargetElementsPresence`関数を追加: 期待アクションの`targetElements`が画面上に存在するかをClaudeに確認
   - 「画面変化なし＋低信頼連続」（5回）を`element_not_found`に昇格するルールを追加
   - Claude応答テキストからの失敗キーワード検出も補助的に使用

2. **画面変化判定のノイズ耐性強化（新規 v12）**
   - 単純な`hashScreenshot`に代わる差分率ベースの判定を追加
   - `ScreenChangeDetectionConfig`: ノイズ許容率と進捗判定の最小変化率を設定可能
   - `calculateScreenDiffRatio`: サンプリングベースの差分率計算
   - `hasSignificantScreenChange`: ノイズと意味のある変化を区別
   - 連続微小変化パターンの検出（時計/カーソル等の動的要素対応）
   - 将来的な動的領域マスクの概念を記載

3. **stopped/aborted保持の分岐方針（新規 v12）**
   - `mapTestResultStatusToScenarioStatus`関数を追加
   - `TestResultStatus`から`ScenarioStatus`への適切なマッピングを実装
   - `stopped`ステータスを`failed`に一括変換せず、独立して保持
   - AbortError時の適切なTestResult生成を追加
   - UIでの表示対応: `stopped`アイコン（⏹）と「ユーザーによる停止」の区別表示

#### v11での変更

1. **早期成功条件から`isFromFallback`を削除（新規 v11）**
   - agentLoopの早期成功条件（`if (validationResult.isValid || isFromFallback)`）を修正
   - `isFromFallback`を早期成功条件から削除し、`validationResult.isValid`のみで判定
   - フォールバック時は早期成功せず、`analyzeClaudeResponse`に委ねて厳格に判定
   - これにより、フォールバック時に`tool_use`継続中でも即成功になる問題を防止

2. **フォールバック時の判定ルールを統一（新規 v11）**
   - セクション1.4の「結果JSON未返却時の方針」を明確化
   - 正常抽出時（`isFromFallback: false`）: 期待アクション未完了は失敗
   - フォールバック時（`isFromFallback: true`）: `tool_use`停止＋エラー/スタックなしで成功
   - JSON有無は成功/失敗の決定要因ではないことを明記

3. **FailureReasonの重複を整理（新規 v11）**
   - `execution_error`を削除し、`action_execution_error`に統合
   - 両者は意味が同一（アクション実行時のエラー）であり、理由コードを一本化

4. **TestResult型から`lastScreenshot`を削除（新規 v11）**
   - セクション4.1の「最後のスクリーンショットは`TestResult`に保存しない」方針と整合
   - ログ容量削減のため、型定義からも削除

#### v10での変更

5. **validateActionAndCheckProgress返却型の修正（v10）**
   - 返却型に`expectsSubtleChange?: boolean`を追加
   - 既に返却値で使用されていた`expectsSubtleChange`フラグを型定義に明示化
   - これにより`agentLoop.ts`側で微小変化フラグを明示的に参照可能に

6. **resultJudge.tsのimport修正（v10）**
   - `import type { ComputerAction, ComputerActionType } from '../types';`に変更
   - `isNonProgressiveAction`と`expectsSubtleScreenChange`で使用している`ComputerActionType[]`型を正しくimport
   - 型安全性の向上

#### v9での変更

3. **妥当性検証NG時の成功確定条件を厳格化（新規 v9）**
   - v8では「Claude成功JSON **または** tool_use停止」で成功を許可していた
   - v9では「`tool_use`停止 **かつ** Claude成功JSON **かつ** エラー/スタックなし」の**すべて**が必要に変更
   - これにより抽出不足で期待アクションが少ない場合の誤った早期成功を防止
   - `analyzeClaudeResponse`内のv7妥当性チェック部分に`hasToolUse`条件を追加

2. **微小変化アクションへの適用手順を明示化（新規 v9）**
   - `validateActionAndCheckProgress`で`expectsSubtleChange`を使用した特別処理を追加
   - 微小変化アクション（left_click等）で画面変化なしの場合:
     - `shouldAdvanceIndex = false`（即時進行しない）
     - `confidence = 'high'`を維持（猶予ウィンドウに委ねる）
   - 返却値に`expectsSubtleChange`フラグを追加
   - `checkProgress`でも`expectsSubtleScreenChange`を適用し、閾値を2倍に緩和

#### v8での変更

3. **フォールバック時のJSON欠如ルール統一（v8）**
   - フォールバック時（`isFromFallback: true`）のJSON欠如時の扱いを統一表で明示
   - 「tool_use停止＋エラー/スタックなし＝成功」ルールを採用
   - 完了シナリオを誤って失敗扱いにする矛盾を解消

4. **早期成功チェックへの妥当性検証追加（v8 → v9で更新）**
   - agentLoopの早期成功チェック（v6-1）に`validateExpectedActionsCount`を追加
   - 妥当性が低い場合（`!validationResult.isValid`）は即時成功せず
   - ~~Claude成功JSONまたはtool_use停止を追加根拠として要求~~ → **v9で厳格化**
   - フォールバック時（`isFromFallback: true`）は妥当性検証をスキップ

5. **非プログレッシブアクション判定の拡張（v8）**
   - `scroll`を非プログレッシブアクションリストに追加
   - `expectsSubtleScreenChange`関数を追加（軽微なUI変化への対応）
   - 対策として猶予ウィンドウ（v6-3）、Claude検証、中信頼度継続を明文化
   - **v9で適用手順を明示化**

#### v7での変更

4. **低/中信頼マッチ連続時の`action_mismatch`失敗判定（v7）**
   - `lowConfidenceActionCount`カウンターを追加
   - 低/中信頼マッチが10回続いたら`failureReason: 'action_mismatch'`で失敗終了
   - 高信頼マッチが発生したらカウンターをリセット
   - `AgentLoopConfig`に`maxLowConfidenceActions`設定を追加

5. **analyzeClaudeResponseにフォールバック時JSON欠如対応を明示追加（v7）**
   - `isComplete`分岐の冒頭に`isFromFallback && !resultOutput && !hasToolUse`チェックを追加
   - v6-2で記述されていたコード例がPhase 3本体に明示されていなかった問題を修正
   - セクション1.4とPhase 3ステップ3.2の整合性を確保

6. **期待アクション列の妥当性検証（v7）**
   - `extractStepCountHint`: シナリオ文からステップ数ヒントを抽出（「3ステップ」等の表現、番号付きリスト）
   - `validateExpectedActionsCount`: 最低件数検証、ステップ数ヒントとの乖離チェック
   - Claude成功JSONとの併用で早期成功を防止
   - `AgentLoopConfig`に`strictExpectedActionsValidation`設定を追加

#### v6での変更

7. **期待アクション全完了時の即時成功確定（v6-1）**
   - agentLoopのメインループ先頭で`completedActionIndex >= expectedActions.length`をチェック
   - 全完了の場合は**即時成功として終了**（残りの`tool_use`は実行しない）
   - `analyzeClaudeResponse`にも全完了時のガードを追加
   - これにより余計な`tool_use`継続による誤判定を防止

2. **フォールバック時のJSON欠如対応（新規 v6-2）**
   - フォールバック時（`isFromFallback: true`）にJSON未返却の場合の特別対応
   - `tool_use`停止＋エラー/スタック検出なし → 成功と判定
   - 「JSON欠如は補助的理由」方針と整合

3. **画面変化の猶予ウィンドウ（新規 v6-3）**
   - `PendingHighConfidenceMatch`構造を導入
   - 高信頼マッチ時に画面変化がない場合、猶予ウィンドウ（2アクション）を設定
   - 猶予期間内に画面変化があれば遡って完了扱い
   - 非同期UIレンダリングやアニメーション完了後の変化に対応

4. **画面変化を`shouldAdvanceIndex`の必須条件に（v5）**
   - `validateActionAndCheckProgress`に`screenChanged`パラメータを追加
   - 戻り値に`requiresScreenChange`フラグを追加
   - 高信頼マッチでも画面変化がない場合は`shouldAdvanceIndex = false`
   - 非プログレッシブアクション（`wait`, `screenshot`, `mouse_move`）は例外として画面変化を要求しない
   - agentLoop.tsでアクション実行後に画面変化を検出し、照合関数に渡す
   - Claude検証でも画面変化を確認し、変化なしの場合はインデックスを進めない

2. **`actionTypeMatches`の厳密一致対応（新規 v5）**
   - `actionTypeStrictMatch`フラグを追加
   - `expectedToolAction`が具体的な値（`left_click`, `right_click`, `double_click`等）の場合は厳密一致を要求
   - `expectedToolAction === 'click'`（汎用クリック）の場合のみ緩和マッチを許可
   - 高信頼度判定では`actionTypeStrictMatch`を使用（緩和マッチは中信頼度止まり）

3. **`checkSameActionRepeat`の記述修正（新規 v5）**
   - 現状コードに該当関数は存在しないため、「削除」という表現を修正
   - 「checkProgress内に統合的に新規実装」が正確な表現

4. **フォールバック使用フラグの追加（v4）**
   - `extractExpectedActions`の戻り値を`ExtractExpectedActionsResult`型に変更
   - `isFromFallback: boolean`フラグでフォールバック使用を明示
   - `analyzeClaudeResponse`に`isFromFallback`引数を追加
   - フォールバック時（`isFromFallback: true`）はClaude成功報告を採用

5. **画面変化が起きにくいアクションの進捗判定スキップ（v4）**
   - `isNonProgressiveAction`関数を追加（`wait`, `screenshot`, `mouse_move`を判定）
   - 非プログレッシブアクションは`unchangedCount`を増加させない
   - 同一アクション検出の閾値を緩和（非プログレッシブは2倍、最低10回）

6. **askClaudeForActionCompletionのAPI経路統一（v4）**
   - ビジョン対応の通常モデル（`claude-sonnet-4-20250514`）を使用
   - Computer Use API（Opus 4.5）は`beta.messages.create`+`betas`ヘッダ必須だが、この関数は画像解析のみ
   - 通常の`messages.create`でビジョン対応モデルを使用することで動作保証
   - `extractExpectedActions`も同様にSonnetを使用（テキスト処理のみ、beta不要）

7. **Claude結果JSON採用前の検証（v3）**
   - `analyzeClaudeResponse`の戻り値に`shouldContinue`フラグを追加
   - Claudeが`status: success`を返しても`completedActionIndex < expectedActions.length`なら継続または失敗
   - 期待アクション抽出が失敗した場合（`expectedActions.length === 0`または`isFromFallback === true`）はClaudeの判定を信頼

8. **クリック系アクションの照合改善（v3）**
   - `validateActionAndCheckProgress`に`claudeResponseContext`パラメータを追加
   - クリック系アクションでは`toolAction.text`が空のため、直前のClaude応答テキストからキーワード/targetElementsを照合
   - `needsClaudeVerification`フラグを追加し、クリック系で中信頼度の場合にClaude視覚検証を促す
   - 中信頼度カウンター（`mediumConfidenceActionCount`）で3回連続時にClaude検証を実行

9. **期待アクション照合の粒度改善（v2）**
   - `validateAction` → `validateActionAndCheckProgress`に名称変更
   - `shouldAdvanceIndex`フラグを追加し、高信頼マッチ時のみtrue
   - 中信頼度が3回続いた場合にClaude検証を実行

10. **同一アクション検出の一元化（v2、v5で表現修正）**
    - **v5修正**: 現状コードに`checkSameActionRepeat`関数は存在しないため「削除」ではなく「新規実装」が正確
    - `checkProgress`内で`sameActionCount`を更新（唯一の更新箇所として一元化）

11. **JSON未返却時のフォールバック（v2）**
    - `analyzeClaudeResponse`に`expectedActions`と`completedActionIndex`を引数追加
    - `successByProgress`フラグで進捗ベース成功を識別
    - 期待アクション全完了で成功判定

12. **期待アクション抽出のフォールバック（v2）**
    - `extractExpectedActions`失敗時、空配列ではなくシナリオ全体を1期待アクション化
    - `extractBasicKeywords`で主要キーワードを簡易抽出

### Questionへの回答

**Q: clickの`tool_use`には要素名や`text`が入る想定ですか？**

**A: いいえ、入りません。**

`ComputerAction`インターフェース（`src/types/action.ts`）を確認した結果:
- `text`フィールドは`type`および`key`アクション専用
- クリック系アクション（`left_click`, `double_click`等）では`coordinate`のみが使用され、`text`は空

**対応策**:
- 直前のClaude応答テキスト（`claudeResponseContext`）を照合に使用
- Claudeは通常「○○をクリックします」のようなテキストを応答に含めるため、そこからキーワード/targetElementsを照合
- 高信頼マッチが得られない場合は、中信頼度カウンターが閾値に達した時点でClaude視覚検証を実行

---

計画書ファイルパス: /Users/satoshizerocolored/dev/localtester2/test-result-judgment-plan.md
