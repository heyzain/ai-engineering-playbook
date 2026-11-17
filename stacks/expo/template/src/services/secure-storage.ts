/**
 * RULE-MOB-SEC-STORAGE: Expo Secure Storage Service
 *
 * Provides a unified contract for mobile storage:
 * 1. Sensitive credentials (tokens, auth session, keys) MUST use OS-protected secure storage
 *    via expo-secure-store (backed by iOS Keychain / Android Keystore Provider).
 * 2. Unencrypted storage (AsyncStorage) is strictly reserved for non-sensitive UI preferences and cache.
 */

export interface SecureStorageContract {
  setItem(key: string, value: string): Promise<void>;
  getItem(key: string): Promise<string | null>;
  deleteItem(key: string): Promise<void>;
}

// In-memory fallback for headless unit tests / environments without native bridge
class InMemorySecureStore implements SecureStorageContract {
  private store = new Map<string, string>();

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async deleteItem(key: string): Promise<void> {
    this.store.delete(key);
  }
}

let secureStoreAdapter: SecureStorageContract;

try {
  // Dynamically load expo-secure-store if present in runtime
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ExpoSecureStore = require("expo-secure-store");
  secureStoreAdapter = {
    async setItem(key: string, value: string): Promise<void> {
      await ExpoSecureStore.setItemAsync(key, value, {
        keychainAccessible: ExpoSecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
    },
    async getItem(key: string): Promise<string | null> {
      return ExpoSecureStore.getItemAsync(key);
    },
    async deleteItem(key: string): Promise<void> {
      await ExpoSecureStore.deleteItemAsync(key);
    },
  };
} catch {
  // Headless test fallback
  secureStoreAdapter = new InMemorySecureStore();
}

export const SecureStorage: SecureStorageContract = secureStoreAdapter;
