import createContextHook from "@nkzw/create-context-hook";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Platform } from "react-native";
import Purchases, {
  LOG_LEVEL,
  PurchasesPackage,
  type CustomerInfo,
} from "react-native-purchases";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/contexts/AuthContext";

/**
 * REVENUECAT DORMANT SWITCH (user directive, 2026-08-29 — "disable it until
 * further notice"). When true, the SDK is never configured and everything
 * below gates off `apiKey` being falsy: no network calls at boot or anywhere
 * else (no more offerings/customer-info "operation was aborted" errors), no
 * identity sync. Subscription state resolves instantly to free-tier defaults
 * and the paywall falls back to its static pricing. Re-enable by flipping
 * this to false — all SDK wiring is intentionally left in place.
 */
const REVENUECAT_DORMANT = true;

function getRCToken(): string | undefined {
  if (REVENUECAT_DORMANT) {
    return undefined;
  }

  if (__DEV__ || Platform.OS === "web") {
    return process.env.EXPO_PUBLIC_REVENUECAT_TEST_API_KEY;
  }

  return Platform.select({
    ios: process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY,
    android: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY,
    default: process.env.EXPO_PUBLIC_REVENUECAT_TEST_API_KEY,
  }) as string | undefined;
}

const apiKey = getRCToken();
if (apiKey) {
  try {
    void Purchases.setLogLevel(LOG_LEVEL.VERBOSE);
    Purchases.configure({ apiKey });
    console.log("[RC] RevenueCat configured successfully");
  } catch (e: unknown) {
    console.warn("[RC] RevenueCat init failed (non-fatal):", e instanceof Error ? e.message : String(e));
  }
} else if (REVENUECAT_DORMANT) {
  console.log("[RC] Dormant — all RevenueCat activity disabled until re-enabled");
} else {
  console.warn("[RC] No RevenueCat API key found");
}

const ENTITLEMENT_PRO = "Bullrun Pro";
const ENTITLEMENT_PRO_GOLD = "Bullrun Pro Gold";

export type SubscriptionTier = "free" | "pro" | "pro_gold";

const PRO_DAILY_SIGNAL_CAP = 5;
const CUSTOMER_INFO_QUERY_KEY = ["rc-customer-info"] as const;
const OFFERINGS_QUERY_KEY = ["rc-offerings"] as const;
const APP_USER_ID_QUERY_KEY = ["rc-app-user-id"] as const;

async function refreshRevenueCatIdentity(targetUserId: string | null): Promise<string | null> {
  if (!apiKey) {
    return null;
  }

  const currentAppUserId = await Purchases.getAppUserID();
  console.log(
    `[RC] Identity sync requested | current=${currentAppUserId} | target=${targetUserId ?? "anonymous"}`
  );

  if (targetUserId) {
    if (currentAppUserId === targetUserId) {
      console.log("[RC] RevenueCat already aligned with authenticated user");
      return currentAppUserId;
    }

    const result = await Purchases.logIn(targetUserId);
    console.log(
      `[RC] RevenueCat login complete | original=${result.customerInfo.originalAppUserId}`
    );
    return Purchases.getAppUserID();
  }

  if (currentAppUserId.startsWith("$RCAnonymousID:")) {
    console.log("[RC] RevenueCat already using anonymous identity");
    return currentAppUserId;
  }

  console.log("[RC] Resetting RevenueCat user back to anonymous");
  await Purchases.logOut();
  return Purchases.getAppUserID();
}

export const [SubscriptionProvider, useSubscription] = createContextHook(() => {
  const queryClient = useQueryClient();
  const { user, isLoadingSession } = useAuth();
  const lastSyncedUserIdRef = useRef<string | null | undefined>(undefined);

  const customerInfoQuery = useQuery({
    queryKey: CUSTOMER_INFO_QUERY_KEY,
    queryFn: async () => {
      if (!apiKey) {
        return null;
      }

      try {
        const info = await Purchases.getCustomerInfo();
        console.log(
          "[RC] Customer info fetched:",
          JSON.stringify(info.entitlements.active)
        );
        return info;
      } catch (e) {
        console.error("[RC] Failed to get customer info:", e);
        throw e;
      }
    },
    enabled: Boolean(apiKey),
    retry: 2,
    retryDelay: 1000,
    staleTime: 30_000,
  });

  const offeringsQuery = useQuery({
    queryKey: OFFERINGS_QUERY_KEY,
    queryFn: async () => {
      if (!apiKey) {
        return null;
      }

      try {
        const offerings = await Purchases.getOfferings();
        console.log("[RC] Offerings fetched:", offerings.current?.identifier);
        return offerings;
      } catch (e) {
        console.error("[RC] Failed to get offerings:", e);
        throw e;
      }
    },
    enabled: Boolean(apiKey),
    retry: 2,
    retryDelay: 1000,
    staleTime: 60_000,
  });

  const appUserIdQuery = useQuery({
    queryKey: APP_USER_ID_QUERY_KEY,
    queryFn: async () => {
      if (!apiKey) {
        return null;
      }

      const currentAppUserId = await Purchases.getAppUserID();
      console.log(`[RC] Current app user id: ${currentAppUserId}`);
      return currentAppUserId;
    },
    enabled: Boolean(apiKey),
    retry: false,
    staleTime: 30_000,
  });

  const syncCustomerIdentityMutation = useMutation({
    mutationFn: async (targetUserId: string | null) => refreshRevenueCatIdentity(targetUserId),
    onSuccess: async (currentAppUserId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: CUSTOMER_INFO_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: OFFERINGS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: APP_USER_ID_QUERY_KEY }),
      ]);

      queryClient.setQueryData<string | null>(APP_USER_ID_QUERY_KEY, currentAppUserId);
    },
    onError: (error) => {
      console.error("[RC] Failed to sync RevenueCat identity:", error);
    },
  });

  // Hold mutateAsync in a ref so the effect deps stay STABLE. The object
  // returned by useMutation has a NEW identity on every render, and having it
  // in the deps re-ran this effect on every render — after a failed sync the
  // lastSyncedUserIdRef guard never latched, so each re-run scheduled another
  // sync whose pending/error state change re-rendered the provider, which
  // re-ran the effect again: an unbounded sync/re-render loop (the RC-driven
  // loading/remount churn seen 2026-08-29). While REVENUECAT_DORMANT this
  // effect exits early on !apiKey; the ref fix guarantees the loop cannot
  // return when the switch is flipped back on.
  const syncIdentityMutateRef = useRef(syncCustomerIdentityMutation.mutateAsync);
  syncIdentityMutateRef.current = syncCustomerIdentityMutation.mutateAsync;

  useEffect(() => {
    if (!apiKey || isLoadingSession) {
      return;
    }

    const targetUserId = user?.id ?? null;
    if (lastSyncedUserIdRef.current === targetUserId) {
      return;
    }

    console.log(
      `[RC] Scheduling identity sync for user=${targetUserId ?? "anonymous"}`
    );
    void syncIdentityMutateRef
      .current(targetUserId)
      .then(() => {
        lastSyncedUserIdRef.current = targetUserId;
      })
      .catch((error) => {
        console.error("[RC] Identity sync attempt failed:", error);
      });
  }, [apiKey, isLoadingSession, user?.id]);

  const purchaseMutation = useMutation({
    mutationFn: async (pkg: PurchasesPackage) => {
      if (!apiKey) {
        throw new Error("RevenueCat is not configured.");
      }

      console.log("[RC] Purchasing package:", pkg.identifier);
      const result = await Purchases.purchasePackage(pkg);
      return result;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CUSTOMER_INFO_QUERY_KEY });
    },
    onError: (error: any) => {
      if (error?.userCancelled) {
        console.log("[RC] Purchase cancelled by user");
      } else {
        console.error("[RC] Purchase error:", error);
      }
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async () => {
      if (!apiKey) {
        throw new Error("RevenueCat is not configured.");
      }

      console.log("[RC] Restoring purchases...");
      const info = await Purchases.restorePurchases();
      return info;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CUSTOMER_INFO_QUERY_KEY });
    },
    onError: (error: any) => {
      console.error("[RC] Restore error:", error);
    },
  });

  const customerInfo: CustomerInfo | null = customerInfoQuery.data ?? null;
  const currentOffering = offeringsQuery.data?.current ?? null;
  const appUserId = appUserIdQuery.data ?? null;

  const isProGold =
    customerInfo?.entitlements?.active?.[ENTITLEMENT_PRO_GOLD]?.isActive === true;
  const isProBase =
    customerInfo?.entitlements?.active?.[ENTITLEMENT_PRO]?.isActive === true;
  const isPro = isProBase || isProGold;

  const tier: SubscriptionTier = isProGold
    ? "pro_gold"
    : isProBase
    ? "pro"
    : "free";

  const dailySignalCap: number | null = isProGold
    ? null
    : isProBase
    ? PRO_DAILY_SIGNAL_CAP
    : 0;

  const purchasePackage = useCallback(
    (pkg: PurchasesPackage) => purchaseMutation.mutateAsync(pkg),
    [purchaseMutation]
  );

  const restorePurchases = useCallback(
    () => restoreMutation.mutateAsync(),
    [restoreMutation]
  );

  return useMemo(
    () => ({
      isRevenueCatConfigured: Boolean(apiKey),
      isPro,
      isProGold,
      tier,
      dailySignalCap,
      customerInfo,
      currentOffering,
      appUserId,
      purchasePackage,
      restorePurchases,
      isPurchasing: purchaseMutation.isPending,
      isRestoring: restoreMutation.isPending,
      isLoadingOfferings: offeringsQuery.isLoading,
      isLoadingCustomerInfo: customerInfoQuery.isLoading,
      isSyncingCustomerIdentity: syncCustomerIdentityMutation.isPending,
      purchaseError: purchaseMutation.error,
      restoreError: restoreMutation.error,
    }),
    [
      appUserId,
      currentOffering,
      customerInfo,
      customerInfoQuery.isLoading,
      dailySignalCap,
      isPro,
      isProGold,
      tier,
      offeringsQuery.isLoading,
      purchaseMutation.error,
      purchaseMutation.isPending,
      purchasePackage,
      restoreMutation.error,
      restoreMutation.isPending,
      restorePurchases,
      syncCustomerIdentityMutation.isPending,
    ]
  );
});
