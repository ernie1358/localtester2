import { start, cancel, onUrl } from '@fabianlars/tauri-plugin-oauth';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getSupabaseClient, getSession, signOut } from './supabaseClient';
import type { AuthResult } from '../types/auth';

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

  try {
    const client = await getSupabaseClient();

    // tauri-plugin-oauthでOAuthサーバーを起動
    port = await start();
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

    // unlistenを格納する配列（TypeScriptの制御フロー解析の問題を回避）
    const unlistenHolder: Array<() => void> = [];

    // リダイレクトURLを待機するPromise
    const authPromise = new Promise<AuthResult>((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ success: false, error: '認証がタイムアウトしました。再度お試しください。' });
      }, 300000); // 5分タイムアウト

      // onUrl()でリダイレクトURLを受信
      onUrl(async (callbackUrl) => {
        clearTimeout(timeout);

        try {
          const url = new URL(callbackUrl);

          // PKCEフローでは認証コード(code)がクエリパラメータとして返される
          const code = url.searchParams.get('code');

          if (code) {
            // PKCE flow - codeをセッションに交換
            const { error: exchangeError } = await client.auth.exchangeCodeForSession(code);
            if (exchangeError) {
              resolve({ success: false, error: exchangeError.message });
            } else {
              resolve({ success: true });
            }
          } else {
            // エラーチェック（認証がキャンセルされた場合など）
            const errorParam = url.searchParams.get('error');
            const errorDescription = url.searchParams.get('error_description');

            if (errorParam) {
              resolve({ success: false, error: errorDescription || errorParam });
            } else {
              resolve({ success: false, error: '認証コードを取得できませんでした' });
            }
          }
        } catch (err) {
          resolve({
            success: false,
            error: err instanceof Error ? err.message : '不明なエラーが発生しました'
          });
        }
      }).then((fn) => { unlistenHolder.push(fn); });
    });

    // 外部ブラウザで認証ページを開く
    await openUrl(data.url);

    const result = await authPromise;

    // クリーンアップ
    if (unlistenHolder.length > 0) {
      unlistenHolder[0]();
    }

    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : '不明なエラーが発生しました',
    };
  } finally {
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
