import createContextHook from "@nkzw/create-context-hook";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import {
  type Provider,
  type Session,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  AUTH_CALLBACK_PATH,
  getSupabaseRedirectUrl,
  isSupabaseConfigured,
  supabase,
} from "@/lib/supabase";
import {
  runSupabaseSmokeTest as executeSupabaseSmokeTest,
  type SupabaseSmokeTestResult,
} from "@/lib/supabaseSmokeTest";

WebBrowser.maybeCompleteAuthSession();

const SESSION_QUERY_KEY = ["supabase-auth-session"] as const;

type OAuthProvider = Extract<Provider, "google" | "apple">;

function getSupabaseClient(): SupabaseClient {
  if (!supabase || !isSupabaseConfigured) {
    throw new Error("Supabase is not configured yet.");
  }

  return supabase;
}

function getReadableErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Something went wrong. Please try again.";
}

function readQueryParam(
  parsedUrl: ReturnType<typeof Linking.parse>,
  key: string
): string | null {
  const value = parsedUrl.queryParams?.[key];

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const firstValue = value[0];
    return typeof firstValue === "string" ? firstValue : null;
  }

  return null;
}

function isAuthCallbackUrl(url: string): boolean {
  return url.includes(AUTH_CALLBACK_PATH);
}

async function exchangeSessionFromUrl(url: string): Promise<Session | null> {
  const client = getSupabaseClient();
  const parsedUrl = Linking.parse(url);
  const errorDescription =
    readQueryParam(parsedUrl, "error_description") ??
    readQueryParam(parsedUrl, "error");

  if (errorDescription) {
    throw new Error(errorDescription);
  }

  const accessToken = readQueryParam(parsedUrl, "access_token");
  const refreshToken = readQueryParam(parsedUrl, "refresh_token");

  if (accessToken && refreshToken) {
    console.log("[Auth] Restoring Supabase session from redirect tokens");
    const { data, error } = await client.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    if (error) {
      throw error;
    }

    return data.session;
  }

  const code = readQueryParam(parsedUrl, "code");

  if (!code) {
    console.log("[Auth] Redirect URL did not include an auth code");
    return null;
  }

  console.log("[Auth] Exchanging Supabase auth code for session");
  const { data, error } = await client.auth.exchangeCodeForSession(code);

  if (error) {
    throw error;
  }

  return data.session;
}

export const [AuthProvider, useAuth] = createContextHook(() => {
  const queryClient = useQueryClient();
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeOAuthProvider, setActiveOAuthProvider] =
    useState<OAuthProvider | null>(null);
  const [supabaseSmokeTestResult, setSupabaseSmokeTestResult] =
    useState<SupabaseSmokeTestResult | null>(null);
  const lastHandledUrlRef = useRef<string | null>(null);

  const sessionQuery = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async () => {
      if (!supabase || !isSupabaseConfigured) {
        console.log("[Auth] Supabase config missing, skipping session bootstrap");
        return null;
      }

      console.log("[Auth] Bootstrapping existing Supabase session");
      const { data, error } = await supabase.auth.getSession();

      if (error) {
        console.error("[Auth] Failed to read existing session:", error);
        throw error;
      }

      return data.session ?? null;
    },
    enabled: isSupabaseConfigured,
    staleTime: Infinity,
    retry: false,
  });

  const handleResolvedSession = useCallback(
    (session: Session | null) => {
      queryClient.setQueryData<Session | null>(SESSION_QUERY_KEY, session);
    },
    [queryClient]
  );

  const processRedirectUrl = useCallback(
    async (url: string) => {
      if (!isSupabaseConfigured || !supabase || !isAuthCallbackUrl(url)) {
        return null;
      }

      if (lastHandledUrlRef.current === url) {
        console.log("[Auth] Skipping duplicate auth redirect");
        return sessionQuery.data ?? null;
      }

      lastHandledUrlRef.current = url;
      console.log(`[Auth] Processing auth redirect: ${url}`);
      const session = await exchangeSessionFromUrl(url);
      handleResolvedSession(session);
      return session;
    },
    [handleResolvedSession, sessionQuery.data]
  );

  useEffect(() => {
    if (!supabase || !isSupabaseConfigured) {
      return;
    }

    console.log("[Auth] Registering Supabase auth state listener");
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      console.log(
        `[Auth] Supabase auth event received: ${event} | user=${session?.user?.id ?? "anonymous"}`
      );
      handleResolvedSession(session ?? null);

      if (event === "SIGNED_OUT") {
        setStatusMessage("Account signed out.");
      }
    });

    return () => {
      console.log("[Auth] Removing Supabase auth state listener");
      subscription.unsubscribe();
    };
  }, [handleResolvedSession]);

  useEffect(() => {
    if (!supabase || !isSupabaseConfigured || Platform.OS === "web") {
      return;
    }

    const client = supabase;
    const handleAppStateChange = (state: AppStateStatus) => {
      if (state === "active") {
        console.log("[Auth] App became active, starting token auto-refresh");
        void client.auth.startAutoRefresh();
        return;
      }

      console.log("[Auth] App left active state, stopping token auto-refresh");
      void client.auth.stopAutoRefresh();
    };

    handleAppStateChange(AppState.currentState);
    const subscription = AppState.addEventListener("change", handleAppStateChange);

    return () => {
      subscription.remove();
      void client.auth.stopAutoRefresh();
    };
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      return;
    }

    const hydrateRedirect = async () => {
      const initialUrl = await Linking.getInitialURL();
      if (!initialUrl || !isAuthCallbackUrl(initialUrl)) {
        return;
      }

      try {
        await processRedirectUrl(initialUrl);
        setErrorMessage(null);
        setStatusMessage("Account connected successfully.");
      } catch (error) {
        const readableMessage = getReadableErrorMessage(error);
        console.error("[Auth] Failed to process initial auth redirect:", error);
        setErrorMessage(readableMessage);
      }
    };

    void hydrateRedirect();

    const subscription = Linking.addEventListener("url", ({ url }) => {
      if (!isAuthCallbackUrl(url)) {
        return;
      }

      void (async () => {
        try {
          await processRedirectUrl(url);
          setErrorMessage(null);
          setStatusMessage("Account connected successfully.");
        } catch (error) {
          const readableMessage = getReadableErrorMessage(error);
          console.error("[Auth] Failed to process live auth redirect:", error);
          setErrorMessage(readableMessage);
        }
      })();
    });

    return () => {
      subscription.remove();
    };
  }, [processRedirectUrl]);

  const signInWithEmailMutation = useMutation({
    mutationFn: async ({ email, password }: { email: string; password: string }) => {
      const client = getSupabaseClient();
      console.log(`[Auth] Signing in with email: ${email}`);
      const { data, error } = await client.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        throw error;
      }

      return data.session ?? null;
    },
    onMutate: () => {
      setErrorMessage(null);
      setStatusMessage(null);
    },
    onSuccess: (session) => {
      handleResolvedSession(session);
      setStatusMessage("Signed in successfully.");
    },
    onError: (error) => {
      const readableMessage = getReadableErrorMessage(error);
      console.error("[Auth] Email sign-in failed:", error);
      setErrorMessage(readableMessage);
    },
  });

  const signUpMutation = useMutation({
    mutationFn: async ({ email, password }: { email: string; password: string }) => {
      const client = getSupabaseClient();
      const redirectTo = getSupabaseRedirectUrl();
      console.log(`[Auth] Creating account with email: ${email} | redirect=${redirectTo}`);
      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: redirectTo,
        },
      });

      if (error) {
        throw error;
      }

      return data;
    },
    onMutate: () => {
      setErrorMessage(null);
      setStatusMessage(null);
    },
    onSuccess: (result) => {
      handleResolvedSession(result.session ?? null);
      setStatusMessage(
        result.session
          ? "Account created and signed in."
          : "Account created. Check your email to confirm your address."
      );
    },
    onError: (error) => {
      const readableMessage = getReadableErrorMessage(error);
      console.error("[Auth] Account creation failed:", error);
      setErrorMessage(readableMessage);
    },
  });

  const signInWithOAuthMutation = useMutation({
    mutationFn: async (provider: OAuthProvider) => {
      const client = getSupabaseClient();
      const redirectTo = getSupabaseRedirectUrl();
      console.log(`[Auth] Starting ${provider} OAuth flow | redirect=${redirectTo}`);
      const { data, error } = await client.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo,
          skipBrowserRedirect: true,
          queryParams:
            provider === "google"
              ? {
                  access_type: "offline",
                  prompt: "select_account",
                }
              : undefined,
        },
      });

      if (error) {
        throw error;
      }

      if (!data?.url) {
        throw new Error(`Unable to open ${provider} sign-in.`);
      }

      const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);
      console.log(`[Auth] ${provider} auth result: ${JSON.stringify(result)}`);

      if (result.type === "success") {
        return processRedirectUrl(result.url);
      }

      if (result.type === "cancel" || result.type === "dismiss") {
        throw new Error("The sign-in flow was cancelled.");
      }

      throw new Error("The sign-in flow did not complete.");
    },
    onMutate: (provider) => {
      setActiveOAuthProvider(provider);
      setErrorMessage(null);
      setStatusMessage(null);
    },
    onSuccess: (_, provider) => {
      setStatusMessage(
        provider === "apple"
          ? "Signed in with Apple successfully."
          : "Signed in with Google successfully."
      );
    },
    onError: (error) => {
      const readableMessage = getReadableErrorMessage(error);
      console.error("[Auth] OAuth sign-in failed:", error);
      setErrorMessage(readableMessage);
    },
    onSettled: () => {
      setActiveOAuthProvider(null);
    },
  });

  const signOutMutation = useMutation({
    mutationFn: async () => {
      const client = getSupabaseClient();
      console.log("[Auth] Signing out current Supabase user");
      const { error } = await client.auth.signOut();

      if (error) {
        throw error;
      }

      return null;
    },
    onMutate: () => {
      setErrorMessage(null);
      setStatusMessage(null);
    },
    onSuccess: () => {
      handleResolvedSession(null);
      setStatusMessage("Account signed out.");
    },
    onError: (error) => {
      const readableMessage = getReadableErrorMessage(error);
      console.error("[Auth] Sign-out failed:", error);
      setErrorMessage(readableMessage);
    },
  });

  const supabaseSmokeTestMutation = useMutation({
    mutationFn: async () => executeSupabaseSmokeTest(),
    onMutate: () => {
      setErrorMessage(null);
      setStatusMessage("Running Supabase smoke test...");
      setSupabaseSmokeTestResult(null);
    },
    onSuccess: (result) => {
      console.log("[Auth] Supabase smoke test succeeded:", result);
      setSupabaseSmokeTestResult(result);
      setStatusMessage(
        result.authStatus === "created_session"
          ? "Supabase smoke test passed. Dummy user created, metadata saved, and email login verified."
          : "Supabase smoke test passed. Dummy user created and metadata saved, but email confirmation is required before password login can be verified."
      );
    },
    onError: (error) => {
      const readableMessage = getReadableErrorMessage(error);
      console.error("[Auth] Supabase smoke test failed:", error);
      setSupabaseSmokeTestResult(null);
      setErrorMessage(`Supabase smoke test failed: ${readableMessage}`);
    },
  });

  const session = sessionQuery.data ?? null;
  const user: User | null = session?.user ?? null;

  const signInWithEmail = useCallback(
    async (email: string, password: string) => {
      const normalizedEmail = email.trim().toLowerCase();
      return signInWithEmailMutation.mutateAsync({
        email: normalizedEmail,
        password,
      });
    },
    [signInWithEmailMutation]
  );

  const signUpWithEmail = useCallback(
    async (email: string, password: string) => {
      const normalizedEmail = email.trim().toLowerCase();
      return signUpMutation.mutateAsync({
        email: normalizedEmail,
        password,
      });
    },
    [signUpMutation]
  );

  const signInWithOAuth = useCallback(
    async (provider: OAuthProvider) => signInWithOAuthMutation.mutateAsync(provider),
    [signInWithOAuthMutation]
  );

  const signOut = useCallback(async () => signOutMutation.mutateAsync(), [signOutMutation]);

  const runSupabaseSmokeTest = useCallback(
    async () => supabaseSmokeTestMutation.mutateAsync(),
    [supabaseSmokeTestMutation]
  );

  return useMemo(
    () => ({
      isConfigured: isSupabaseConfigured,
      session,
      user,
      isAuthenticated: Boolean(user),
      statusMessage,
      errorMessage,
      activeOAuthProvider,
      isLoadingSession: sessionQuery.isLoading,
      isSigningInWithEmail: signInWithEmailMutation.isPending,
      isCreatingAccount: signUpMutation.isPending,
      isSigningOut: signOutMutation.isPending,
      isSigningInWithOAuth: signInWithOAuthMutation.isPending,
      isRunningSupabaseSmokeTest: supabaseSmokeTestMutation.isPending,
      supabaseSmokeTestResult,
      signInWithEmail,
      signUpWithEmail,
      signInWithOAuth,
      signOut,
      runSupabaseSmokeTest,
    }),
    [
      activeOAuthProvider,
      errorMessage,
      session,
      sessionQuery.isLoading,
      signInWithEmail,
      signInWithEmailMutation.isPending,
      signInWithOAuth,
      signInWithOAuthMutation.isPending,
      signOut,
      signOutMutation.isPending,
      signUpMutation.isPending,
      signUpWithEmail,
      statusMessage,
      supabaseSmokeTestMutation.isPending,
      supabaseSmokeTestResult,
      runSupabaseSmokeTest,
      user,
    ]
  );
});
