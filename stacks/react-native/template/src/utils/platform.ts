import { Platform } from 'react-native';

/**
 * Universal platform detection and configuration utilities.
 * Encapsulates platform branching cleanly.
 */

export const isIOS = Platform.OS === 'ios';
export const isAndroid = Platform.OS === 'android';

export function getPlatformValue<T>(options: { ios: T; android: T; default: T }): T {
  return Platform.select({
    ios: options.ios,
    android: options.android,
    default: options.default,
  });
}
