import { start, cancel, onUrl } from '@fabianlars/tauri-plugin-oauth';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getSupabaseClient, getSession, signOut } from './supabaseClient';
import type { AuthResult } from '../types/auth';

/**
 * OAuth認証完了後にブラウザに表示するHTML
 */
const OAUTH_SUCCESS_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>認証完了 - Xenotester</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    }
    .container {
      text-align: center;
      padding: 40px;
      background: rgba(255,255,255,0.1);
      border-radius: 16px;
      backdrop-filter: blur(10px);
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    }
    .checkmark {
      width: 80px;
      height: 80px;
      margin: 0 auto 24px;
      background: #4ade80;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .checkmark svg { width: 40px; height: 40px; }
    h1 { font-size: 24px; margin-bottom: 12px; }
    p { color: #a0a0a0; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    </div>
    <h1>認証が完了しました</h1>
    <p>このタブを閉じてアプリに戻ってください</p>
  </div>
</body>
</html>
`;

/**
 * Google OAuthでサインイン（PKCEフロー）
 *
 * 認証フロー:
 * 1. tauri-plugin-oauthでローカルサーバーを起動してリダイレクト待機
 * 2. 外部ブラウザでGoogle認証を開始
 * 3. onUrl()でリダイレクトURLを受け取り、codeパラメータを取得
 * 4. exchangeCodeForSession()でcodeをセッションに交換
 *
 * 注意: supabaseClient.tsで flowType: 'pkce' を設定しているため、
 * リダイレクトにはcodeパラメータのみが返される
 */
export async function signInWithGoogle(): Promise<AuthResult> {
  let port: number | null = null;
  // TypeScript制御フロー解析の問題を回避するためオブジェクトで保持
  const cleanup: { unlisten: (() => void) | null } = { unlisten: null };

  try {
    const client = await getSupabaseClient();

    // tauri-plugin-oauthでOAuthサーバーを起動（固定ポート8585、カスタムHTML応答）
    try {
      port = await start({
        ports: [8585],
        response: OAUTH_SUCCESS_HTML,
      });
    } catch (startError) {
      // ポート競合時は明確なエラーメッセージを返す
      const message = startError instanceof Error ? startError.message : '';
      if (message.includes('Address already in use') || message.includes('port')) {
        return {
          success: false,
          error: 'ポート8585が使用中です。他のアプリケーションを終了してから再度お試しください。',
        };
      }
      throw startError;
    }
    const redirectUrl = `http://localhost:${port}`;

    // Supabase OAuth URLを生成（PKCEフロー）
    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectUrl,
        skipBrowserRedirect: true, // URLを取得するだけで自動リダイレクトしない
      },
    });

    if (error || !data.url) {
      throw new Error(error?.message || 'Failed to get OAuth URL');
    }

    // タイムアウト用のハンドル
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    // コールバックURLを受け取るためのPromise
    const callbackPromise = new Promise<string>((resolve) => {
      timeoutId = setTimeout(() => {
        resolve('__timeout__');
      }, 300000); // 5分タイムアウト
    });

    // onUrl()リスナーを登録（awaitで登録完了を待機してからブラウザを開く）
    let urlReceived: ((url: string) => void) | null = null;
    const urlPromise = new Promise<string>((resolve) => {
      urlReceived = resolve;
    });

    cleanup.unlisten = await onUrl((callbackUrl) => {
      // OAuth認証のコールバックURLのみを処理（favicon等のリクエストを無視）
      try {
        const parsedUrl = new URL(callbackUrl);

        // 起動したポートと一致するか検証（セキュリティ対策）
        // localhost, 127.0.0.1, ::1 をループバックとして許可
        const loopbackHosts = ['localhost', '127.0.0.1', '::1'];
        const isCorrectHost = loopbackHosts.includes(parsedUrl.hostname);
        const isCorrectPort = parsedUrl.port === String(port);

        if (!isCorrectHost || !isCorrectPort) {
          return; // 不正なリダイレクトを無視
        }

        const hasCode = parsedUrl.searchParams.has('code');
        const hasError = parsedUrl.searchParams.has('error');

        if ((hasCode || hasError) && urlReceived) {
          urlReceived(callbackUrl);
        }
      } catch {
        // URL解析に失敗した場合は無視
      }
    });

    // 外部ブラウザで認証ページを開く（リスナー登録完了後）
    await openUrl(data.url);

    // URLを受信するか、タイムアウトするまで待機
    const result = await Promise.race([urlPromise, callbackPromise]);

    // タイムアウトをクリア
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }

    if (result === '__timeout__') {
      return { success: false, error: '認証がタイムアウトしました。再度お試しください。' };
    }

    // コールバックURLを処理
    try {
      const url = new URL(result);

      // PKCEフローでは認証コード(code)がクエリパラメータとして返される
      const code = url.searchParams.get('code');

      if (code) {
        // PKCE flow - codeをセッションに交換
        const { error: exchangeError } = await client.auth.exchangeCodeForSession(code);
        if (exchangeError) {
          return { success: false, error: exchangeError.message };
        }

        // 認証成功後、アプリウィンドウを前面に表示
        try {
          const mainWindow = getCurrentWindow();
          await mainWindow.show(); // 非表示状態から表示
          await mainWindow.unminimize(); // 最小化状態から復元
          await mainWindow.setFocus(); // フォーカスを設定
        } catch (focusError) {
          console.warn('[authService] Failed to focus window:', focusError);
        }

        return { success: true };
      } else {
        // エラーチェック（認証がキャンセルされた場合など）
        const errorParam = url.searchParams.get('error');
        const errorDescription = url.searchParams.get('error_description');

        if (errorParam) {
          return { success: false, error: errorDescription || errorParam };
        }
        return { success: false, error: '認証コードを取得できませんでした' };
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : '不明なエラーが発生しました'
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '不明なエラーが発生しました',
    };
  } finally {
    // unlistenを必ずクリーンアップ
    if (cleanup.unlisten !== null) {
      try {
        cleanup.unlisten();
      } catch {
        // クリーンアップエラーは無視
      }
    }
    if (port !== null) {
      try {
        await cancel(port);
      } catch {
        // 既に停止している場合は無視
      }
    }
  }
}

/**
 * 現在の認証状態をチェック
 */
export async function checkAuth(): Promise<boolean> {
  try {
    const session = await getSession();
    return session !== null;
  } catch {
    return false;
  }
}

/**
 * Supabaseクライアントを再export（App.vueで使用）
 */
export { getSupabaseClient, getSession, signOut };
