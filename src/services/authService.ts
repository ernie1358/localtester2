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
  // TypeScript制御フロー解析の問題を回避するためオブジェクトで保持
  const cleanup: { unlisten: (() => void) | null } = { unlisten: null };

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
      if (urlReceived) {
        urlReceived(callbackUrl);
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
