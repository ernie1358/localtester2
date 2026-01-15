# 実装計画書: ヒント画像座標検出機能

## 概要

**ステータス: ✅ 既に実装完了済み**

依頼された機能は、現在のコードベースに既に包括的に実装されています。本計画書は、既存実装の調査結果を報告するものです。

### 要求された機能
1. ✅ ヒント画像をスクリーンショットとテンプレートマッチングで照合する
2. ✅ 検出された画像の中心座標を取得する（左上ではなく中心点）
3. ✅ 座標情報をLLMに渡してクリック精度を向上させる
4. ✅ 複数画像の個別座標取得（例: `画像1: 885,226 / 画像2: 223,355`）

### 既存実装の確認
上記のすべての機能が既に実装されていることを確認しました。

---

## 既存実装の詳細

### 処理フロー（既に実装済み）
1. テストステップ実行時にスクリーンショットをキャプチャ
2. 各ヒント画像に対してテンプレートマッチングを実行（Rust側）
3. マッチした場合、ヒント画像の**中心座標**を計算
4. LLMへのリクエスト時に「ヒント画像 + 検出座標」を一緒に渡す
   - 例: `画像1(button.png): 885,226 / 画像2(icon.png): 223,355`

### 1. Rust側: テンプレートマッチング機能

**ファイル: `src-tauri/src/services/template_matcher.rs`** (既存)

- `imageproc` クレートを使用した正規化相互相関(NCC)アルゴリズムによるテンプレートマッチング
- 複数画像の一括処理に対応（スクリーンショットを1回だけデコードして再利用）
- 透過PNG対応（アルファ合成で白背景に変換）
- 不透明度チェック（10%未満の透過画像はマッチング不可として処理）
- スケールファクターに対応（リサイズされたスクリーンショットに合わせてテンプレートもリサイズ）
- **中心座標の計算**: マッチ位置（左上）からテンプレートの幅・高さの半分を加算して中心点を返す

```rust
// template_matcher.rs:320-321 の実装
let center_x = match_x as i32 + (template_width / 2) as i32;
let center_y = match_y as i32 + (template_height / 2) as i32;
```

**ファイル: `src-tauri/src/commands/template_match.rs`** (既存)

- `match_hint_images` Tauriコマンドとして公開
- 非同期処理（`spawn_blocking`でCPU集約処理をワーカースレッドにオフロード）
- 個別画像のエラーは各結果に含まれ、他の画像の処理には影響しない

### 2. TypeScript側: エージェントループでの統合

**ファイル: `src/services/agentLoop.ts`** (既存)

**初期マッチング (205-280行目)**:
```typescript
// テンプレートマッチングを実行
matchResults = await invoke<HintImageMatchResult[]>('match_hint_images', {
  screenshotBase64: captureResult.imageBase64,
  templateImages: options.hintImages.map((img) => ({
    imageData: img.image_data,
    fileName: img.file_name,
  })),
  scaleFactor: captureResult.scaleFactor,
  confidenceThreshold: 0.7,
});

// LLMに渡すテキストを構築
const detectedCoordinates = matchResults
  .filter((r) => r.matchResult.found && !r.matchResult.error)
  .map((r) => `画像${r.index + 1}(${r.fileName}): ${r.matchResult.centerX},${r.matchResult.centerY}`)
  .join(' / ');

if (detectedCoordinates) {
  hintText += `\n\n【画像認識による座標（各画像の中心点）】\n${detectedCoordinates}\n\n上記の座標は画像認識で検出した位置です。`;
}
```

**再マッチング機能 (754-901行目)**:
- 画面遷移後に未検出画像を再マッチング
- 画面変化時は既に検出済みの画像も再マッチング（座標更新のため）
- 永続的エラー（Base64デコードエラー、不透明度不足等）の画像は再試行しない
- サイズ関連エラーは画面変化時のみ再試行
- tool_resultに更新された座標情報を含める

### 3. 型定義

**ファイル: `src/types/capture.ts`** (既存)

```typescript
export type MatchErrorCode =
  | 'screenshot_decode_error'      // 一時的エラー
  | 'template_base64_decode_error' // 永続的エラー
  | 'template_image_decode_error'  // 永続的エラー
  | 'insufficient_opacity'         // 永続的エラー
  | 'non_finite_confidence'        // 永続的エラー
  | 'template_too_large';          // サイズ関連（画面変化で解決可能）

export interface HintImageMatchResult {
  index: number;
  fileName: string;
  matchResult: {
    found: boolean;
    centerX: number | null;
    centerY: number | null;
    confidence: number | null;
    templateWidth: number;
    templateHeight: number;
    error: string | null;
    errorCode: MatchErrorCode | null;
  };
}
```

### 4. テストカバレッジ

**ファイル: `src/__tests__/agentLoop.test.ts`** および **`src/__tests__/agentLoop.screenChange.test.ts`** (既存)

以下のシナリオがテストされています:
- ✅ 座標検出成功時のメッセージ構築
- ✅ 部分的な検出成功（一部画像のみ検出）
- ✅ エラー発生時の継続処理
- ✅ テンプレートマッチングエラー時の継続
- ✅ 画面遷移後の再マッチング
- ✅ 永続的エラーの再試行除外
- ✅ サイズエラーの画面変化時再試行
- ✅ 座標無効化メッセージの送信

---

## 影響範囲

### 変更不要なファイル（既に実装済み）

| ファイル | 実装状況 |
|---------|---------|
| `src-tauri/src/services/template_matcher.rs` | ✅ テンプレートマッチング実装済み、中心座標計算済み |
| `src-tauri/src/commands/template_match.rs` | ✅ Tauriコマンド実装済み |
| `src-tauri/src/lib.rs` | ✅ `match_hint_images`コマンド登録済み |
| `src-tauri/Cargo.toml` | ✅ `imageproc`クレート追加済み |
| `src/services/agentLoop.ts` | ✅ 座標検出・LLM連携実装済み |
| `src/types/capture.ts` | ✅ 型定義追加済み |
| `src/__tests__/agentLoop.test.ts` | ✅ テスト実装済み |
| `src/__tests__/agentLoop.screenChange.test.ts` | ✅ 画面変化テスト実装済み |

## 実装ステップ

### Phase 1: Rust側のテンプレートマッチング基盤

#### Step 1.1: 依存関係の追加
```toml
# src-tauri/Cargo.toml に追加
[dependencies]
imageproc = "0.25"  # テンプレートマッチング機能
```

**選定理由**:
- `imageproc` は純粋なRust実装で、既存の `image = "0.25"` クレートと互換性がある
- GPU加速版（`template-matching`クレート）も選択肢だが、追加の依存やGPU対応の複雑さを避けるため、まずCPU版で実装
- 過去に`Cargo.toml`でOpenCVがコメントアウトされていた形跡があるが、OpenCVはビルド依存が複雑なため不採用

#### Step 1.2: テンプレートマッチングサービスの実装
`src-tauri/src/services/template_matcher.rs` を新規作成:

```rust
//! Template matching service for hint image coordinate detection

use image::{DynamicImage, GenericImageView};
use imageproc::template_matching::{match_template, MatchTemplateMethod, find_extremes};
use serde::Serialize;
use crate::error::XenotesterError;

/// Result of template matching
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchResult {
    /// Whether a match was found
    pub found: bool,
    /// X coordinate of the center point (in resized screenshot coordinates)
    pub center_x: Option<i32>,
    /// Y coordinate of the center point (in resized screenshot coordinates)
    pub center_y: Option<i32>,
    /// Match confidence score (0.0 - 1.0)
    pub confidence: Option<f32>,
    /// Template width (after scaling)
    pub template_width: u32,
    /// Template height (after scaling)
    pub template_height: u32,
    /// Error message if matching failed for this image
    pub error: Option<String>,
}

/// Find template image within screenshot
/// Returns center coordinates of the matched region
///
/// IMPORTANT: スケール整合について
/// - screenshot_base64: リサイズ済みスクリーンショット（例: 1560px）
/// - template_base64: 原寸ヒント画像
/// - scale_factor: スクリーンショットのリサイズ比率（例: 0.6 = 元画像の60%）
///
/// ヒント画像を同じscale_factorでリサイズしてからマッチングを実行する。
/// 返される座標はリサイズ後スクリーンショット上の座標（LLMに渡すのと同じ座標系）。
pub fn find_template_in_screenshot(
    screenshot_base64: &str,
    template_base64: &str,
    scale_factor: f64,
    confidence_threshold: f32,
) -> MatchResult {
    // 内部でエラーをキャッチして MatchResult.error に格納
    match find_template_internal(screenshot_base64, template_base64, scale_factor, confidence_threshold) {
        Ok(result) => result,
        Err(e) => MatchResult {
            found: false,
            center_x: None,
            center_y: None,
            confidence: None,
            template_width: 0,
            template_height: 0,
            error: Some(e.to_string()),
        },
    }
}

/// Internal implementation that returns Result
fn find_template_internal(
    screenshot_base64: &str,
    template_base64: &str,
    scale_factor: f64,
    confidence_threshold: f32,
) -> Result<MatchResult, XenotesterError> {
    // Decode base64 images
    let screenshot = decode_base64_image(screenshot_base64)?;
    let template_original = decode_base64_image(template_base64)?;

    // スケール整合: ヒント画像を同じ比率でリサイズ
    // スクリーンショットはすでにリサイズ済み（scale_factor適用済み）
    // ヒント画像も同じscale_factorを適用してサイズを揃える
    let template = if scale_factor < 1.0 {
        let (orig_w, orig_h) = template_original.dimensions();
        let new_w = (orig_w as f64 * scale_factor).round() as u32;
        let new_h = (orig_h as f64 * scale_factor).round() as u32;

        // 最小サイズチェック（1x1ピクセル未満にならないように）
        let new_w = new_w.max(1);
        let new_h = new_h.max(1);

        template_original.resize_exact(
            new_w,
            new_h,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        template_original
    };

    // Convert to grayscale for matching
    let screenshot_gray = screenshot.to_luma8();
    let template_gray = template.to_luma8();

    let template_width = template_gray.width();
    let template_height = template_gray.height();

    // テンプレートがスクリーンショットより大きい場合は検出不可
    if template_width > screenshot_gray.width() || template_height > screenshot_gray.height() {
        return Ok(MatchResult {
            found: false,
            center_x: None,
            center_y: None,
            confidence: Some(0.0),
            template_width,
            template_height,
            error: Some("Template is larger than screenshot after scaling".to_string()),
        });
    }

    // Perform template matching using Sum of Squared Differences
    // SumOfSquaredDifferencesNormalized gives values from 0.0 (perfect match) to 1.0 (no match)
    let result = match_template(
        &screenshot_gray,
        &template_gray,
        MatchTemplateMethod::SumOfSquaredDifferencesNormalized,
    );

    // Find the minimum value (best match for SSD)
    let extremes = find_extremes(&result);

    // Convert SSD score to confidence (1.0 - min_value for SSD)
    let confidence = 1.0 - extremes.min_value;

    if confidence >= confidence_threshold {
        // Calculate center coordinates (in resized screenshot coordinate system)
        // match_x, match_y は左上座標、中心を返すために template_width/2, template_height/2 を加算
        let (match_x, match_y) = extremes.min_value_location;
        let center_x = match_x as i32 + (template_width / 2) as i32;
        let center_y = match_y as i32 + (template_height / 2) as i32;

        Ok(MatchResult {
            found: true,
            center_x: Some(center_x),
            center_y: Some(center_y),
            confidence: Some(confidence),
            template_width,
            template_height,
            error: None,
        })
    } else {
        Ok(MatchResult {
            found: false,
            center_x: None,
            center_y: None,
            confidence: Some(confidence),
            template_width,
            template_height,
            error: None,
        })
    }
}

/// Decode base64 image to DynamicImage
fn decode_base64_image(base64_data: &str) -> Result<DynamicImage, XenotesterError> {
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};

    let bytes = BASE64_STANDARD
        .decode(base64_data)
        .map_err(|e| XenotesterError::ImageError(format!("Base64 decode error: {}", e)))?;

    image::load_from_memory(&bytes)
        .map_err(|e| XenotesterError::ImageError(format!("Image decode error: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_template_larger_than_screenshot() {
        // テンプレートがスクリーンショットより大きい場合のテスト
        // 実際のBase64画像を使用する必要がある
    }

    #[test]
    fn test_center_calculation() {
        // 中心座標計算のテスト
        // match_x=10, template_width=100 -> center_x = 10 + 50 = 60
    }
}
```

#### Step 1.3: IPCコマンドの追加
`src-tauri/src/commands/template_match.rs` を新規作成:

```rust
//! Template matching commands

use crate::services::template_matcher::{find_template_in_screenshot, MatchResult};

/// Match multiple template images against a screenshot
/// Returns an array of match results with center coordinates
///
/// **設計方針: 画像ごとの失敗を吸収**
/// 個別の画像でデコード/マッチング失敗が発生しても、
/// 他の画像の結果は正常に返す。失敗した画像は `found=false` + `error` で返す。
/// これにより1枚の画像の問題で全体が失敗することを防ぐ。
#[tauri::command]
pub fn match_hint_images(
    screenshot_base64: String,
    template_images: Vec<TemplateImage>,
    scale_factor: f64,
    confidence_threshold: Option<f32>,
) -> Vec<HintImageMatchResult> {
    let threshold = confidence_threshold.unwrap_or(0.7);

    let mut results = Vec::new();

    for (index, template) in template_images.iter().enumerate() {
        // 各画像の処理は独立 - エラーは MatchResult.error に格納される
        let match_result = find_template_in_screenshot(
            &screenshot_base64,
            &template.image_data,
            scale_factor,
            threshold,
        );

        results.push(HintImageMatchResult {
            index,
            file_name: template.file_name.clone(),
            match_result,
        });
    }

    results
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateImage {
    pub image_data: String,
    pub file_name: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HintImageMatchResult {
    pub index: usize,
    pub file_name: String,
    pub match_result: MatchResult,
}
```

#### Step 1.4: モジュール登録

`src-tauri/src/services/mod.rs`:
```rust
pub mod template_matcher;
```

`src-tauri/src/commands/mod.rs`:
```rust
pub mod template_match;
```

#### Step 1.5: lib.rs の更新
```rust
// src-tauri/src/lib.rs
// 既存のインポートに追加
use commands::{/* 既存 */, template_match};

// invoke_handler に追加
.invoke_handler(tauri::generate_handler![
    // 既存のコマンド...
    template_match::match_hint_images,
])
```

### Phase 2: TypeScript側の統合

#### Step 2.1: 型定義の追加
`src/types/capture.ts` に追加:

```typescript
/** Result of template matching for a single hint image */
export interface HintImageMatchResult {
  index: number;
  fileName: string;
  matchResult: {
    found: boolean;
    centerX: number | null;
    centerY: number | null;
    confidence: number | null;
    templateWidth: number;
    templateHeight: number;
    /** Error message if matching failed for this specific image */
    error: string | null;
  };
}
```

#### Step 2.2: agentLoop.ts の更新

ヒント画像処理部分を更新して、座標検出とプロンプト拡張を行う:

```typescript
// src/services/agentLoop.ts の変更点

// 新しいインポート
import type { HintImageMatchResult } from '../types';

// runAgentLoop 関数内、ヒント画像の追加部分を変更

// Add hint images if provided
if (options.hintImages && options.hintImages.length > 0) {
  log(`[Agent Loop] Adding ${options.hintImages.length} hint images to request`);

  // Perform template matching to detect coordinates
  // **重要**: scaleFactor を渡してヒント画像をリサイズ済みスクリーンショットと同じスケールに揃える
  let matchResults: HintImageMatchResult[] = [];
  try {
    matchResults = await invoke<HintImageMatchResult[]>('match_hint_images', {
      screenshotBase64: captureResult.imageBase64,
      templateImages: options.hintImages.map(img => ({
        imageData: img.image_data,
        fileName: img.file_name,
      })),
      scaleFactor: captureResult.scaleFactor,  // スケール整合のために必須
      confidenceThreshold: 0.7,
    });

    // 個別の結果をログ出力（エラーがあった画像も含む）
    const foundCount = matchResults.filter(r => r.matchResult.found).length;
    const errorCount = matchResults.filter(r => r.matchResult.error).length;
    log(`[Agent Loop] Template matching completed: ${foundCount}/${matchResults.length} found, ${errorCount} errors`);

    // 個別エラーがあればログに記録（処理は継続）
    matchResults
      .filter(r => r.matchResult.error)
      .forEach(r => log(`[Agent Loop] Template match error for ${r.fileName}: ${r.matchResult.error}`));

  } catch (error) {
    // Rust側の予期せぬエラー（通常は発生しない）- 座標なしで継続
    log(`[Agent Loop] Template matching unexpected error, continuing without coordinates: ${error}`);
  }

  // Build hint text with coordinate information
  let hintText = '\n\n【ヒント画像】\n以下は、探してほしい要素やクリック対象のキャプチャです。';

  // Add coordinate information if available (エラーなく検出されたもののみ)
  // **重要**: filter() 後の idx ではなく、r.index（元のヒント画像順序）を使用
  // これにより、未検出画像があっても番号がずれない
  // 例: 画像1未検出、画像2検出、画像3検出 → "画像2: 885,226 / 画像3: 223,355"
  const detectedCoordinates = matchResults
    .filter(r => r.matchResult.found && !r.matchResult.error)
    .map(r => `画像${r.index + 1}(${r.fileName}): ${r.matchResult.centerX},${r.matchResult.centerY}`)
    .join(' / ');

  if (detectedCoordinates) {
    hintText += `\n\n【画像認識による座標（各画像の中心点）】\n${detectedCoordinates}\n\n上記の座標は画像認識で検出した位置です。これらを参考にして正確に操作してください。`;
  } else {
    hintText += '\nこれらを参考にして正確に操作してください：';
  }

  initialMessageContent.push({
    type: 'text',
    text: hintText,
  });

  for (const hintImage of options.hintImages) {
    initialMessageContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: normalizeMimeType(hintImage.mime_type),
        data: hintImage.image_data,
      },
    });
  }
}
```

#### Step 2.3: claudeClient.ts のプロンプト更新

```typescript
// src/services/claudeClient.ts - RESULT_SCHEMA_INSTRUCTION を更新

export const RESULT_SCHEMA_INSTRUCTION = `
あなたはE2Eテスト自動化ツールです。以下のルールを厳守してください。

【ヒント画像について】
ユーザーからヒント画像が提供される場合があります。これらの画像は：
- クリックすべきアイコンやボタンの見本
- 探すべきUI要素のスクリーンショット
- 操作対象の参考画像
として活用してください。

【座標情報について】
ヒント画像と一緒に「画像認識による座標」が提供される場合があります。この座標はテンプレートマッチングにより検出された、ヒント画像がスクリーンショット内で見つかった位置の中心点です。
- 座標が提供されている場合は、その位置を優先的に参照してください
- ただし、座標はあくまで参考値です。現在の画面と実際に照合して、正確な位置を判断してください
- 座標が検出されなかった画像については、視覚的に探してください

【最重要ルール - 絶対に守ること】
// ... 以下は既存のまま
`;
```

### Phase 3: テストの追加

#### Step 3.1: agentLoop.test.ts の更新

```typescript
// 新しいテストケースを追加

describe('runAgentLoop - Hint Image Coordinate Detection', () => {
  it('should include detected coordinates in hint text when template matching succeeds', async () => {
    // Mock match_hint_images to return successful matches
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'match_hint_images') {
        return [
          {
            index: 0,
            fileName: 'button.png',
            matchResult: {
              found: true,
              centerX: 885,
              centerY: 226,
              confidence: 0.85,
              templateWidth: 100,
              templateHeight: 50,
              error: null,
            },
          },
          {
            index: 1,
            fileName: 'icon.png',
            matchResult: {
              found: true,
              centerX: 223,
              centerY: 355,
              confidence: 0.92,
              templateWidth: 48,
              templateHeight: 48,
              error: null,
            },
          },
        ];
      }
      // ... other mock implementations
    });

    // Execute and verify coordinate text is present in format "画像1(button.png): 885,226 / 画像2(icon.png): 223,355"
    // ...
  });

  it('should continue with partial results when some images fail', async () => {
    // 1枚目は成功、2枚目はエラーのケース
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'match_hint_images') {
        return [
          {
            index: 0,
            fileName: 'success.png',
            matchResult: {
              found: true,
              centerX: 500,
              centerY: 300,
              confidence: 0.85,
              templateWidth: 100,
              templateHeight: 50,
              error: null,
            },
          },
          {
            index: 1,
            fileName: 'error.png',
            matchResult: {
              found: false,
              centerX: null,
              centerY: null,
              confidence: null,
              templateWidth: 0,
              templateHeight: 0,
              error: 'Base64 decode error: invalid padding',
            },
          },
        ];
      }
      // ... other mock implementations
    });

    // 1枚目の座標は含まれ（"画像1(success.png): 500,300"）、2枚目のエラーはログに記録されるが処理は継続
    // ...
  });

  it('should handle case when no templates are found', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'match_hint_images') {
        return [
          {
            index: 0,
            fileName: 'notfound.png',
            matchResult: {
              found: false,
              centerX: null,
              centerY: null,
              confidence: 0.3,  // 閾値未満
              templateWidth: 100,
              templateHeight: 50,
              error: null,
            },
          },
        ];
      }
      // ... other mock implementations
    });

    // 座標テキストなし、従来通りヒント画像のみ送信
    // ...
  });
});
```

## 技術的考慮事項

### スケール整合（重大度: 高）

**問題**: スクリーンショットは `capture_screen` でリサイズ済み（例: 2560px → 1560px, scaleFactor=0.609）だが、ヒント画像は原寸のまま。このスケール差があるとテンプレートマッチングで検出できない。

**解決策**: ヒント画像も同じ `scaleFactor` でリサイズしてからマッチング
- `match_hint_images` コマンドに `scaleFactor` パラメータを追加
- Rust側でヒント画像を `image.resize_exact(w * scaleFactor, h * scaleFactor)` でリサイズ
- マッチング結果の座標は「リサイズ後スクリーンショット」上の座標（LLMに渡す画像と同じ座標系）

**実装箇所**:
1. `template_matcher.rs`: `find_template_in_screenshot` に `scale_factor: f64` 引数
2. `template_match.rs`: `match_hint_images` に `scale_factor: f64` 引数
3. `agentLoop.ts`: `invoke('match_hint_images', { scaleFactor: captureResult.scaleFactor, ... })`

### 座標表示における画像番号の一貫性（重大度: 中）

**問題**: `filter()` でマッチしなかった画像を除外した後に `map((r, idx) => ...)` で番号付けすると、`idx` は除外後のインデックスになり、元のヒント画像順序とずれる。

**例**:
- 画像0: 未検出
- 画像1: 検出成功 (885, 226)
- 画像2: 検出成功 (223, 355)

誤った実装: `filter().map((r, idx) => 画像${idx+1}...)` → `画像1: 885,226 / 画像2: 223,355`
正しい実装: `filter().map(r => 画像${r.index+1}...)` → `画像2: 885,226 / 画像3: 223,355`

**解決策**:
- `r.index`（元の順序）を使用して番号付け
- さらに `r.fileName` も併記して、どの画像の座標かを明確にする
- 出力形式: `画像2(button.png): 885,226 / 画像3(icon.png): 223,355`

### 中心座標の計算

**重要**: 依頼の要件により、検出位置は画像の**中心点**を返す必要がある。

```
テンプレート幅 200px の画像が x=100 で検出された場合:
center_x = 100 + (200 / 2) = 200
```

これにより、LLMはクリック対象の中心に直接クリックできる。

### エラーハンドリング（重大度: 中）

**問題**: 1枚のヒント画像のデコード/マッチング失敗で `match_hint_images` 全体がエラーになると、他の正常な画像の座標も取得できない。

**解決策**: 画像ごとに失敗を吸収し、個別に結果を返す
- `find_template_in_screenshot` は常に `MatchResult` を返す（エラー時も）
- エラー発生時は `MatchResult { found: false, error: Some("..."), ... }` を返す
- `match_hint_images` は `Vec<HintImageMatchResult>` を返す（全体失敗しない）

### パフォーマンス

1. **テンプレートマッチングの計算コスト**
   - `imageproc` のテンプレートマッチングは O(n*m) の計算量
   - リサイズ後のスクリーンショット（1560px程度）と複数のヒント画像では処理時間が懸念される
   - 対策: 将来的に `match_template_parallel` を使用してマルチスレッド処理を検討

2. **画像のリサイズ**
   - スクリーンショットはAPIに送信するために既にリサイズされている（MAX_LONG_EDGE: 1560px）
   - ヒント画像も同じ `scaleFactor` でリサイズしてからマッチング
   - 検出座標は「リサイズ後の座標系」で計算されるため、LLMに渡す座標として適切

### セキュリティ

1. **画像データの検証**
   - Base64デコード時のエラーハンドリング → 個別エラーとして吸収
   - 不正な画像フォーマットに対するガード → 個別エラーとして吸収

2. **信頼度閾値**
   - デフォルト 0.7 (70%) の閾値で誤検出を防止
   - 将来的にユーザー設定可能にすることを検討

### 既存機能への影響

1. **テンプレートマッチング失敗時のフォールバック**
   - 個別画像の失敗は `MatchResult.error` に記録し、処理は継続
   - 全画像で失敗しても既存の動作（画像をLLMに送信）は維持

2. **座標情報の信頼性**
   - 座標はあくまで「参考値」としてLLMに伝達
   - LLMは最終的に視覚的判断で操作を決定

## テスト計画

### 単体テスト

1. **Rust側 (template_matcher.rs)**
   - Base64デコードのテスト
   - 中心座標計算のテスト
   - 閾値による検出/非検出の境界テスト
   - テンプレートがスクリーンショットより大きい場合

2. **TypeScript側 (agentLoop.ts)**
   - 座標情報付きヒントテキストの生成（"885,226 / 223,355" 形式）
   - テンプレートマッチング失敗時のフォールバック
   - 部分的成功（一部画像のみ検出）

### 統合テスト

1. **E2Eテスト**
   - 実際のスクリーンショットとヒント画像でのマッチング精度
   - LLMへの送信フォーマット確認

## リスクと対策

| リスク | 影響度 | 対策 |
|-------|-------|------|
| テンプレートマッチング精度が低い | 中 | 閾値調整、マッチングアルゴリズムの改善 |
| 処理時間が長すぎる | 中 | 並列処理、画像サイズ制限、タイムアウト設定 |
| スケーリング問題 | 高 | **対応済み**: ヒント画像を `scaleFactor` でリサイズ |
| 個別画像エラーで全体失敗 | 中 | **対応済み**: 画像ごとに失敗を吸収 |
| imageproc クレートのビルド問題 | 低 | 代替として `template-matching` (GPU) を検討 |

## 調査ログ

### 実行した検索語（Grep/Globで使用したパターン）

- `hint.*image|hintImage|hint_image|StepImage` - ヒント画像関連コード
- `capture_screen` - スクリーンキャプチャコマンド
- `imageBase64|image_data` - Base64画像データ
- `scaleFactor|displayScaleFactor` - スケーリング関連
- `template|match|opencv|coordinate` - テンプレートマッチング関連

### 読んだファイル一覧

**src/ 配下**
- `src/services/agentLoop.ts` - ヒント画像の送信処理（199-214行目がヒント画像追加ロジック）
- `src/services/scenarioRunner.ts` - シナリオ実行とヒント画像読み込み
- `src/services/claudeClient.ts` - LLMプロンプト定義（RESULT_SCHEMA_INSTRUCTION）
- `src/services/scenarioDatabase.ts` - DB操作（getStepImages）
- `src/constants/hintImages.ts` - ヒント画像制限定数
- `src/components/ScenarioForm.vue` - ヒント画像UI
- `src/types/` 配下 - action.ts, capture.ts, database.ts, scenario.ts, testResult.ts, index.ts
- `src/__tests__/agentLoop.test.ts` - 既存テスト（ヒント画像メッセージ構築のテストパターン）
- `src/__tests__/hintImages.test.ts` - ヒント画像バリデーションテスト

**src-tauri/ 配下**
- `src-tauri/Cargo.toml` - 依存関係（`image = "0.25"` 確認、`# template-matching = ["opencv"]` コメント発見）
- `src-tauri/src/lib.rs` - Tauriエントリポイント、コマンド登録
- `src-tauri/src/main.rs` - メイン
- `src-tauri/src/error.rs` - エラー型定義
- `src-tauri/src/services/capture.rs` - スクリーンキャプチャ
- `src-tauri/src/services/image_processor.rs` - 画像リサイズ（MAX_LONG_EDGE: 1560px）
- `src-tauri/src/services/mod.rs` - サービスモジュール
- `src-tauri/src/commands/screenshot.rs` - スクリーンショットコマンド
- `src-tauri/src/commands/mod.rs` - コマンドモジュール

### 辿った import/依存チェーン

1. `scenarioRunner.ts` → `agentLoop.ts` → `claudeClient.ts`
2. `scenarioRunner.ts` → `scenarioDatabase.ts` (getStepImages)
3. `agentLoop.ts` → `@tauri-apps/api/core` (invoke)
4. Rust: `lib.rs` → `commands/*` → `services/*`

### 非TSファイル確認

- ✅ `src-tauri/Cargo.toml` - 確認済み（`imageproc = "0.25"` 既に追加済み）
- ✅ `package.json` - 依存関係確認

### 調査中に発見した関連情報

1. **Git履歴から最近のコミットで本機能が実装されていることを確認**:
   - `bd182f1 refactor: async match_hint_images + error codes for robust error handling`
   - `cbe792e fix: improve hint image error handling for edge cases`
   - `6864849 fix: correctly identify screenshot decode errors as transient`
   - `5fb4985 fix: improve hint image error handling and add screen change tests`
   - `73547a2 fix: update hint image re-matching to handle screen changes and permanent errors`

2. **画像リサイズの制約**
   - MAX_LONG_EDGE: 1560px（API制限の1568pxより少し小さい安全マージン）
   - MAX_TOTAL_PIXELS: 1,150,000（約1.15メガピクセル）

---

## 結論

**追加の実装は不要です。**

依頼された機能は既に完全に実装されており、以下の動作が確認されています:

1. ✅ スクリーンショットとヒント画像のテンプレートマッチング（`imageproc`使用）
2. ✅ 検出した画像の**中心座標**計算（左上ではなく中心点）
3. ✅ 複数画像の個別座標取得
4. ✅ LLMへの座標情報付きメッセージ送信
   - 形式: `画像1(button.png): 885,226 / 画像2(icon.png): 223,355`
5. ✅ 画面遷移時の再マッチングと座標更新
6. ✅ 包括的なエラーハンドリングと再試行ロジック
7. ✅ テストカバレッジ（`agentLoop.test.ts`, `agentLoop.screenChange.test.ts`）

---

計画書ファイルパス: /Users/satoshizerocolored/dev/localtester2/implementation-plan-hint-image-coordinate-detection.md
