import "react-native-url-polyfill/auto";

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Linking from "expo-linking";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

interface EnvCandidate {
  name: string;
  value: string | undefined;
}

function resolveEnvValue(candidates: EnvCandidate[]): EnvCandidate | null {
  const configuredCandidate = candidates.find((candidate) => {
    const normalizedValue = candidate.value?.trim();
    return Boolean(normalizedValue);
  });

  return configuredCandidate ?? null;
}

const supabaseUrlCandidate = resolveEnvValue([
  {
    name: "EXPO_PUBLIC_SUPABASE_URL",
    value: process.env.EXPO_PUBLIC_SUPABASE_URL,
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_URL",
    value: process.env.NEXT_PUBLIC_SUPABASE_URL,
  },
]);

const supabaseAnonKeyCandidate = resolveEnvValue([
  {
    name: "EXPO_PUBLIC_SUPABASE_ANON_KEY",
    value: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  },
  {
    name: "EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
    value: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY,
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    value: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
    value: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY,
  },
]);

const supabaseUrl = supabaseUrlCandidate?.value?.trim() ?? null;
const supabaseAnonKey = supabaseAnonKeyCandidate?.value?.trim() ?? null;

export const AUTH_CALLBACK_PATH = "auth/callback";
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

if (!isSupabaseConfigured) {
  console.warn(
    "[Supabase] Missing project URL or publishable key. Account features will stay disabled."
  );
} else {
  console.log(
    `[Supabase] Client configuration detected | urlSource=${supabaseUrlCandidate?.name ?? "unknown"} | keySource=${supabaseAnonKeyCandidate?.name ?? "unknown"}`
  );
}

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(supabaseUrl as string, supabaseAnonKey as string, {
      auth: {
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
        flowType: "pkce",
      },
    })
  : null;

export function getSupabaseRedirectUrl(path: string = AUTH_CALLBACK_PATH): string {
  return Linking.createURL(path);
}
