import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { api } from './api';

export type PushResult =
  | { ok: true }
  | { ok: false; reason: 'denied' | 'unsupported' | 'no-project' | 'error'; message: string };

let handlerSet = false;
export function setupNotificationHandler() {
  if (handlerSet || Platform.OS === 'web') return;
  handlerSet = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

/**
 * Ask for permission, get the Expo push token and register it with the hub.
 * Missing EAS projectId (no `eas init` yet) is reported, not thrown.
 */
export async function enablePush(): Promise<PushResult> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'Push notifications need the iOS or Android app.',
    };
  }
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default notifications',
        importance: Notifications.AndroidImportance.HIGH,
        lightColor: '#1F6F6B',
      });
    }
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') {
      return {
        ok: false,
        reason: 'denied',
        message: 'Notifications are off. You can turn them on in Settings.',
      };
    }
    if (!Device.isDevice) {
      return {
        ok: false,
        reason: 'unsupported',
        message: 'Push tokens need a physical device, not a simulator.',
      };
    }
    const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
    const projectId = extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) {
      return {
        ok: false,
        reason: 'no-project',
        message:
          'This build has no EAS project yet, so push is unavailable. Run `eas init` to enable it.',
      };
    }
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    await api.addPushToken(token, Platform.OS);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      reason: 'error',
      message: e instanceof Error ? e.message : 'Could not enable notifications.',
    };
  }
}
