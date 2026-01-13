import type { Session, User } from '@supabase/supabase-js';

export type { Session, User };

export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: User | null;
  error: string | null;
}

export interface AuthResult {
  success: boolean;
  error?: string;
}

export interface SupabaseConfig {
  url: string;
  anon_key: string;
}
