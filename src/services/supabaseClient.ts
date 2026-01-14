import { createClient, SupabaseClient, Session } from '@supabase/supabase-js';
import { invoke } from '@tauri-apps/api/core';
import type { SupabaseConfig } from '../types/auth';

let supabaseClient: SupabaseClient | null = null;

export async function getSupabaseClient(): Promise<SupabaseClient> {
  if (supabaseClient) {
    return supabaseClient;
  }

  const config = await invoke<SupabaseConfig>('get_supabase_config');

  supabaseClient = createClient(config.url, config.anon_key, {
    auth: {
      storage: localStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false, // Tauriでは手動で処理
      flowType: 'pkce', // PKCEフローを明示的に設定
    },
  });

  return supabaseClient;
}

export async function getSession(): Promise<Session | null> {
  const client = await getSupabaseClient();
  const { data: { session } } = await client.auth.getSession();
  return session;
}

export async function signOut(): Promise<void> {
  const client = await getSupabaseClient();
  await client.auth.signOut();
}

/**
 * Get Supabase configuration (URL and anon key)
 * Used for Edge Function calls
 */
export async function getSupabaseConfig(): Promise<SupabaseConfig> {
  return invoke<SupabaseConfig>('get_supabase_config');
}
