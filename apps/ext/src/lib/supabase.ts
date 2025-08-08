import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger';
import type { Database } from './types';

// Read from Vite/WXT env (exposed at build-time). Prefix must be VITE_.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

let client: SupabaseClient<Database> | null = null;

if (supabaseUrl && supabaseAnonKey) {
  client = createClient<Database>(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: {
        getItem: async (key: string) => {
          const result = await browser.storage.local.get(key);
          return result[key] || null;
        },
        setItem: async (key: string, value: string) => {
          await browser.storage.local.set({ [key]: value });
        },
        removeItem: async (key: string) => {
          await browser.storage.local.remove(key);
        },
      },
    },
  });
} else if (import.meta.env.DEV) {
  logger.info(
    'Supabase not configured (VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY missing). Cloud sync disabled in extension dev.',
    {
      component: 'supabase',
    }
  );
}

export const supabase = client;
export type { Database } from './types';
