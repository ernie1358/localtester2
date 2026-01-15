# Xenotester

AIを活用したデスクトップテスト自動化ツール

## ダウンロード

**[https://ernie1358.github.io/localtester2/](https://ernie1358.github.io/localtester2/)**

---

## 開発者向け情報

### 環境構築

```bash
# 依存関係のインストール
npm install

# 開発サーバー起動
npm run tauri dev

# ビルド
npm run tauri build
```

### 必要な環境

- Node.js 20+
- Rust (最新stable)
- macOS: Xcode Command Line Tools
- Windows: Visual Studio Build Tools

---

## リリース手順

### 1. 新バージョンのリリース

```bash
# 1. バージョン番号を更新
# package.json と src-tauri/tauri.conf.json の "version" を更新

# 2. 変更をコミット
git add -A
git commit -m "chore: bump version to vX.X.X"
git push origin main

# 3. タグを作成してプッシュ（これでCI/CDが自動実行）
git tag vX.X.X
git push origin vX.X.X
```

### 2. CI/CDの動作

タグをプッシュすると、GitHub Actionsが自動的に以下を実行：

1. **ビルド**: macOS (Apple Silicon / Intel) のバイナリを生成
2. **署名**: 自動アップデート用の署名を付与
3. **アップロード**:
   - Railway Storage にバイナリと `latest.json` をアップロード
   - GitHub Releases にバイナリを添付
4. **リリース作成**: GitHub Releaseを自動生成

### 3. ダウンロードページ

ダウンロードページ (`docs/index.html`) は **自動更新** されます。

- GitHub APIから最新リリース情報を動的に取得
- 手動更新は不要

#### GitHub Pages の初期設定（初回のみ）

1. GitHubリポジトリの **Settings** > **Pages** を開く
2. **Source** を `Deploy from a branch` に設定
3. **Branch** を `main`、フォルダを `/docs` に設定
4. **Save** をクリック

数分後、以下のURLでアクセス可能：
```
https://ernie1358.github.io/localtester2/
```

---

## 自動アップデート機能

### 仕組み

- アプリ起動時とその後1時間ごとに更新をチェック
- 新バージョンがあれば通知バナーを表示
- ユーザーが「今すぐ更新」をクリックするとダウンロード・インストール

### 設定ファイル

| ファイル | 用途 |
|---------|------|
| `src-tauri/tauri.conf.json` | updater設定（公開鍵、エンドポイント） |
| `.github/workflows/release.yml` | CI/CDワークフロー |
| `src/composables/useUpdater.ts` | フロントエンド更新ロジック |

### マニフェスト (latest.json)

Railway Storage に自動アップロードされる更新マニフェスト：

```json
{
  "version": "0.2.0",
  "notes": "Xenotester v0.2.0",
  "pub_date": "2026-01-15T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "...",
      "url": "https://..."
    },
    "darwin-x86_64": {
      "signature": "...",
      "url": "https://..."
    }
  }
}
```

---

## 署名鍵の管理

### 鍵の生成（必要な場合のみ）

```bash
npm run tauri signer generate -- -w ~/.tauri/xenotester.key -p "YOUR_PASSWORD" --ci
```

### GitHub Secrets の設定

| Secret名 | 内容 |
|----------|------|
| `TAURI_SIGNING_PRIVATE_KEY` | 秘密鍵の内容 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 秘密鍵のパスワード |
| `S3_ACCESS_KEY_ID` | Railway Storage アクセスキー |
| `S3_SECRET_ACCESS_KEY` | Railway Storage シークレットキー |

### 公開鍵の更新

鍵を再生成した場合、`src-tauri/tauri.conf.json` の `plugins.updater.pubkey` を更新：

```bash
cat ~/.tauri/xenotester.key.pub
# 出力された内容を tauri.conf.json に設定
```

---

## トラブルシューティング

### CI/CDが失敗する場合

1. **署名エラー**: GitHub Secretsの `TAURI_SIGNING_PRIVATE_KEY` と `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` を確認
2. **S3アップロードエラー**: Railway Storageの認証情報を確認
3. **GitHub Release作成エラー**: ワークフローに `permissions: contents: write` があるか確認

### 自動アップデートが動作しない場合

1. `tauri.conf.json` の `endpoints` URLが正しいか確認
2. Railway Storageの `latest.json` にアクセスできるか確認
3. アプリのバージョンが `latest.json` より古いか確認

---

## 技術スタック

- **フロントエンド**: Vue 3 + TypeScript + Vite
- **バックエンド**: Rust + Tauri v2
- **CI/CD**: GitHub Actions
- **ストレージ**: Railway Storage Buckets
- **自動アップデート**: tauri-plugin-updater

---

## ライセンス

Private
