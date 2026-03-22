import createContextHook from "@nkzw/create-context-hook";
import { useCallback, useMemo } from "react";
import { Platform } from "react-native";
import Purchases, { LOG_LEVEL, PurchasesPackage } from "react-native-purchases";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

function getRCToken() {
  if (__DEV__ || Platform.OS === "web")
    return process.env.EXPO_PUBLIC_REVENUECAT_TEST_API_KEY;
  return Platform.select({
    ios: process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY,
    android: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY,
    default: process.env.EXPO_PUBLIC_REVENUECAT_TEST_API_KEY,
  });
}

const apiKey = getRCToken();
if (apiKey) {
  void Purchases.setLogLevel(LOG_LEVEL.VERBOSE);
  Purchases.configure({ apiKey });
  console.log("[RC] RevenueCat configured successfully");
} else {
  console.warn("[RC] No RevenueCat API key found");
}

const ENTITLEMENT_ID = "Bullrun Pro";

export const [SubscriptionProvider, useSubscription] = createContextHook(() => {
  const queryClient = useQueryClient();

  const customerInfoQuery = useQuery({
    queryKey: ["rc-customer-info"],
    queryFn: async () => {
      try {
        const info = await Purchases.getCustomerInfo();
        console.log("[RC] Customer info fetched:", JSON.stringify(info.entitlements.active));
        return info;
      } catch (e) {
        console.error("[RC] Failed to get customer info:", e);
        throw e;
      }
    },
    retry: 2,
    retryDelay: 1000,
    staleTime: 30_000,
  });

  const offeringsQuery = useQuery({
    queryKey: ["rc-offerings"],
    queryFn: async () => {
      try {
        const offerings = await Purchases.getOfferings();
        console.log("[RC] Offerings fetched:", offerings.current?.identifier);
        return offerings;
      } catch (e) {
        console.error("[RC] Failed to get offerings:", e);
        throw e;
      }
    },
    retry: 2,
    retryDelay: 1000,
    staleTime: 60_000,
  });

  const purchaseMutation = useMutation({
    mutationFn: async (pkg: PurchasesPackage) => {
      console.log("[RC] Purchasing package:", pkg.identifier);
      const result = await Purchases.purchasePackage(pkg);
      return result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["rc-customer-info"] });
    },
    onError: (error: any) => {
      if (error.userCancelled) {
        console.log("[RC] Purchase cancelled by user");
      } else {
        console.error("[RC] Purchase error:", error);
      }
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async () => {
      console.log("[RC] Restoring purchases...");
      const info = await Purchases.restorePurchases();
      return info;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["rc-customer-info"] });
    },
    onError: (error: any) => {
      console.error("[RC] Restore error:", error);
    },
  });

  const customerInfo = customerInfoQuery.data ?? null;
  const currentOffering = offeringsQuery.data?.current ?? null;

  const isPro =
    customerInfo?.entitlements?.active?.[ENTITLEMENT_ID]?.isActive === true;

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
      isPro,
      customerInfo,
      currentOffering,
      purchasePackage,
      restorePurchases,
      isPurchasing: purchaseMutation.isPending,
      isRestoring: restoreMutation.isPending,
      isLoadingOfferings: offeringsQuery.isLoading,
      isLoadingCustomerInfo: customerInfoQuery.isLoading,
      purchaseError: purchaseMutation.error,
      restoreError: restoreMutation.error,
    }),
    [
      currentOffering,
      customerInfo,
      customerInfoQuery.isLoading,
      isPro,
      offeringsQuery.isLoading,
      purchaseMutation.error,
      purchaseMutation.isPending,
      purchasePackage,
      restoreMutation.error,
      restoreMutation.isPending,
      restorePurchases,
    ]
  );
});
