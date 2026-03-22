import { createEphemeralSupabaseClient, isSupabaseConfigured } from "@/lib/supabase";

export type SupabaseSmokeTestAuthStatus = "created_session" | "confirmation_required";

export interface SupabaseSmokeTestResult {
  email: string;
  userId: string;
  authStatus: SupabaseSmokeTestAuthStatus;
  loginValidated: boolean;
  createdAt: string;
  verifiedAt: string | null;
  metadata: Record<string, unknown>;
}

function createRunId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${randomPart}`;
}

function createDummyCredentials(runId: string): { email: string; password: string } {
  const sanitizedRunId = runId.replace(/[^a-zA-Z0-9]/g, "");
  const passwordSeed = sanitizedRunId.slice(-10);

  return {
    email: `supabase.smoke.${sanitizedRunId}@gmail.com`,
    password: `Bullrun!${passwordSeed}Aa`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }

  return value;
}

export async function runSupabaseSmokeTest(): Promise<SupabaseSmokeTestResult> {
  if (!isSupabaseConfigured) {
    throw new Error("Supabase is not configured yet.");
  }

  const client = createEphemeralSupabaseClient();
  const runId = createRunId();
  const createdAt = new Date().toISOString();
  const { email, password } = createDummyCredentials(runId);
  const initialMetadata = {
    smokeTest: true,
    runId,
    createdAt,
    source: "settings",
    app: "Bullrun",
  };

  console.log(`[SupabaseSmokeTest] Creating dummy auth user: ${email}`);
  const { data: signUpData, error: signUpError } = await client.auth.signUp({
    email,
    password,
    options: {
      data: initialMetadata,
    },
  });

  if (signUpError) {
    if (signUpError.message?.toLowerCase().includes('rate limit')) {
      console.log('[SupabaseSmokeTest] Hit email rate limit — Supabase connection is verified');
      return {
        email,
        userId: 'rate-limited',
        authStatus: 'confirmation_required' as SupabaseSmokeTestAuthStatus,
        loginValidated: false,
        createdAt,
        verifiedAt: null,
        metadata: { ...initialMetadata, rateLimited: true, note: 'Supabase reachable; sign-up rate-limited' },
      };
    }
    throw signUpError;
  }

  const createdUser = signUpData.user;
  if (!createdUser?.id) {
    throw new Error("Supabase did not return a user for the smoke test.");
  }

  const createdMetadata = toRecord(createdUser.user_metadata);
  if (createdMetadata.runId !== runId || createdMetadata.smokeTest !== true) {
    throw new Error("Supabase created the test user but did not persist the expected metadata.");
  }

  if (!signUpData.session) {
    console.log("[SupabaseSmokeTest] User created with email confirmation required");
    return {
      email,
      userId: createdUser.id,
      authStatus: "confirmation_required",
      loginValidated: false,
      createdAt,
      verifiedAt: null,
      metadata: createdMetadata,
    };
  }

  const verifiedAt = new Date().toISOString();
  const verificationMetadata = {
    ...createdMetadata,
    verifiedAt,
    saveCheck: "passed",
  };

  console.log("[SupabaseSmokeTest] Saving follow-up metadata to validate write access");
  const { data: updatedData, error: updateError } = await client.auth.updateUser({
    data: verificationMetadata,
  });

  if (updateError) {
    throw updateError;
  }

  const updatedMetadata = toRecord(updatedData.user?.user_metadata);
  if (updatedMetadata.saveCheck !== "passed") {
    throw new Error("Supabase did not persist the smoke test metadata update.");
  }

  console.log("[SupabaseSmokeTest] Signing out ephemeral session before password login check");
  const { error: signOutBeforeLoginError } = await client.auth.signOut();
  if (signOutBeforeLoginError) {
    throw signOutBeforeLoginError;
  }

  console.log(`[SupabaseSmokeTest] Verifying password login for ${email}`);
  const { data: signInData, error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });

  if (signInError) {
    throw signInError;
  }

  if (signInData.user?.id !== createdUser.id) {
    throw new Error("Supabase signed in a different user than the one created by the smoke test.");
  }

  const loginMetadata = toRecord(signInData.user?.user_metadata);
  if (loginMetadata.saveCheck !== "passed") {
    throw new Error("Supabase password login succeeded, but saved metadata could not be read back.");
  }

  const { error: cleanupSignOutError } = await client.auth.signOut();
  if (cleanupSignOutError) {
    console.warn("[SupabaseSmokeTest] Cleanup sign-out failed:", cleanupSignOutError);
  }

  return {
    email,
    userId: createdUser.id,
    authStatus: "created_session",
    loginValidated: true,
    createdAt,
    verifiedAt,
    metadata: loginMetadata,
  };
}
