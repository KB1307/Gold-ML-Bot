import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { signalEngine } from './signalEngine';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Settings, TradingSignal } from '@/types/trading';
import { sendTelegramAlert } from './telegramNotifier';

const SIGNAL_GENERATION_TASK = 'signal-generation-check';
const NOTIFICATION_CHANNEL_ID = 'trading-signals';

try {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
} catch (e: unknown) {
  console.warn("[BgTask] Notifications.setNotificationHandler failed (non-fatal on web):", e instanceof Error ? e.message : String(e));
}

export async function setupNotificationChannel() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL_ID, {
      name: 'Trading Signals',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      sound: 'default',
      enableVibrate: true,
    });
    console.log('✅ Notification channel created');
  }
}

export async function requestNotificationPermissions(): Promise<boolean> {
  if (Platform.OS === 'web') {
    console.log('⚠️ Notifications not supported on web');
    return false;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.log('❌ Notification permission denied');
    return false;
  }

  console.log('✅ Notification permission granted');
  return true;
}

export async function sendSignalNotification(signal: TradingSignal) {
  if (Platform.OS === 'web') {
    console.log('⚠️ Notifications not supported on web');
    return;
  }

  const hasPermission = await requestNotificationPermissions();
  if (!hasPermission) {
    console.log('❌ Cannot send notification - permission denied');
    return;
  }

  try {
    const entryPrice = signal.entryPriceWithSlippage || signal.entryPrice;
    const confidencePercent = (signal.confidence * 100).toFixed(1);

    await Notifications.scheduleNotificationAsync({
      content: {
        title: `${signal.type === 'BUY' ? '📈' : '📉'} New ${signal.type} Signal`,
        body: `Entry: ${entryPrice.toFixed(1)} | Confidence: ${confidencePercent}% | TP1: ${signal.tp1.toFixed(1)} | SL: ${signal.sl.toFixed(1)}`,
        data: { signalId: signal.id, type: signal.type },
        sound: 'default',
        priority: Notifications.AndroidNotificationPriority.HIGH,
      },
      trigger: null,
    });

    console.log('✅ Signal notification sent');
  } catch (error) {
    console.error('❌ Failed to send notification:', error);
  }
}

try {
  TaskManager.defineTask(SIGNAL_GENERATION_TASK, async () => {
    try {
      console.log('\n🔄 Background Task: Checking for new signals...');

      const [savedSettings, savedHistory, savedBalance] = await Promise.all([
        AsyncStorage.getItem('trading_settings'),
        AsyncStorage.getItem('signal_history'),
        AsyncStorage.getItem('account_balance'),
      ]);

      const settings: Settings = savedSettings 
        ? JSON.parse(savedSettings)
        : {
            tp1Pips: 30,
            tp2Pips: 60,
            tp3Pips: 90,
            slPips: 70,
            numberOfTPs: 3,
            minConfidence: 0.90,
            enableNotifications: true,
            enableTelegramNotifier: true,
            basePositionSize: 0.01,
            maxRiskPercentage: 2.0,
            useKellyCriterion: true,
            useDynamicSL: true,
            maxSLPips: 90,
          };

      if (!settings.enableNotifications) {
        console.log('⚠️ Notifications disabled in settings - skipping background check');
        return BackgroundFetch.BackgroundFetchResult.NoData;
      }

      const history: TradingSignal[] = savedHistory 
        ? JSON.parse(savedHistory).map((s: any) => ({
            ...s,
            timestamp: new Date(s.timestamp),
          }))
        : [];

      const accountBalance: number = savedBalance 
        ? JSON.parse(savedBalance)
        : 100;

      await signalEngine.updateCurrentPrice();
      const signal = await signalEngine.generateSignal(settings, accountBalance, history);

      if (signal) {
        console.log(`✅ Background: New signal generated - ${signal.type} @ ${signal.entryPrice.toFixed(1)}`);

        // SETTINGS TOGGLE (BUG FIX) — stamp the frozen Breakeven policy onto the
        // background-emitted signal (same contract as the foreground emission
        // site in TradingContext). Without the stamp the resolver defaults the
        // signal to PROTECTED (getSignalBreakevenPolicy → true for unstamped
        // signals), so background emissions ignored the toggle.
        signal.breakevenPolicy = settings.breakevenEnabled !== false;
        
        // Telegram alert — fire-and-forget, dispatched before any await.
        // Gated by the dedicated notifier toggle so it can be muted during testing.
        if (settings.enableTelegramNotifier !== false) {
          sendTelegramAlert(signal, settings.numberOfTPs);
        } else {
          console.log('🔕 Telegram notifier disabled in settings - skipping alert');
        }

        // Dedupe by id (defensive against re-entrant runs) and cap growth. The
        // foreground reconciles these additions on next resume, so we must not
        // let storage diverge or grow without bound here.
        const deduped = [signal, ...history].filter(
          (s, i, arr) => arr.findIndex(x => x.id === s.id) === i,
        );
        const updatedHistory = deduped.slice(0, 1000);
        await AsyncStorage.setItem('signal_history', JSON.stringify(updatedHistory));

        await sendSignalNotification(signal);

        return BackgroundFetch.BackgroundFetchResult.NewData;
      } else {
        console.log('⚠️ Background: No signal generated');
        return BackgroundFetch.BackgroundFetchResult.NoData;
      }
    } catch (error) {
      console.error('❌ Background task error:', error);
      return BackgroundFetch.BackgroundFetchResult.Failed;
    }
  });
} catch (e: unknown) {
  console.warn("[BgTask] TaskManager.defineTask failed (non-fatal on web):", e instanceof Error ? e.message : String(e));
}

export async function registerBackgroundTask(): Promise<boolean> {
  if (Platform.OS === 'web') {
    console.log('⚠️ Background tasks not supported on web');
    return false;
  }

  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(SIGNAL_GENERATION_TASK);

    if (isRegistered) {
      console.log('✅ Background task already registered');
      return true;
    }

    await BackgroundFetch.registerTaskAsync(SIGNAL_GENERATION_TASK, {
      minimumInterval: 30,
      stopOnTerminate: false,
      startOnBoot: true,
    });

    console.log('✅ Background task registered successfully');
    console.log('   - Task will run every 30 seconds');
    console.log('   - Continues running after app termination');
    console.log('   - Starts automatically on device boot');
    
    return true;
  } catch (error) {
    console.error('❌ Failed to register background task:', error);
    return false;
  }
}

export async function unregisterBackgroundTask(): Promise<void> {
  if (Platform.OS === 'web') {
    return;
  }

  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(SIGNAL_GENERATION_TASK);
    
    if (isRegistered) {
      await TaskManager.unregisterTaskAsync(SIGNAL_GENERATION_TASK);
      console.log('✅ Background task unregistered');
    }
  } catch (error) {
    console.error('❌ Failed to unregister background task:', error);
  }
}

export async function isBackgroundTaskRegistered(): Promise<boolean> {
  if (Platform.OS === 'web') {
    return false;
  }

  try {
    return await TaskManager.isTaskRegisteredAsync(SIGNAL_GENERATION_TASK);
  } catch (error) {
    console.error('❌ Failed to check background task status:', error);
    return false;
  }
}

export async function getBackgroundTaskStatus(): Promise<{
  isRegistered: boolean;
  isAvailable: boolean;
  status?: BackgroundFetch.BackgroundFetchStatus;
}> {
  if (Platform.OS === 'web') {
    return {
      isRegistered: false,
      isAvailable: false,
    };
  }

  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(SIGNAL_GENERATION_TASK);
    const status = await BackgroundFetch.getStatusAsync();

    return {
      isRegistered,
      isAvailable: status === BackgroundFetch.BackgroundFetchStatus.Available,
      status: status ?? undefined,
    };
  } catch (error) {
    console.error('❌ Failed to get background task status:', error);
    return {
      isRegistered: false,
      isAvailable: false,
    };
  }
}
