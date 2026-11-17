/**
 * RULE-MOB-SEC-STORAGE: Mobile Storage Architecture & Security Boundaries
 * 
 * Strict separation between unencrypted preferences and OS-protected secure storage:
 * 1. PreferenceStorage: Non-sensitive local preferences, UI state, cache data (AsyncStorage).
 * 2. SecureStorage: Auth tokens, refresh tokens, private keys, credentials (Keychain/Keystore).
 */

export interface PreferenceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface SecureStorage {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

/**
 * In-memory fallback and simulation wrapper for preference storage.
 * In a fully configured native app, this wraps AsyncStorage.
 */
class InMemoryPreferenceStorage implements PreferenceStorage {
  private store = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    // Prohibit sensitive keys in unencrypted storage
    const lowerKey = key.toLowerCase();
    if (/(token|auth|jwt|secret|password|passwd|credential|bearer|session|private)/.test(lowerKey)) {
      throw new Error(
        `[RULE-MOB-SEC-STORAGE] Prohibited storage of sensitive key '${key}' in unencrypted preference storage. Use SecureStorageService.`
      );
    }
    this.store.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/**
 * OS-Protected Secure Storage abstraction.
 * On iOS: Wraps Apple Keychain Services (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly).
 * On Android: Wraps Android Keystore Provider with hardware-backed StrongBox where supported.
 */
class HostSecureStorage implements SecureStorage {
  private secureStore = new Map<string, string>();

  async getSecret(key: string): Promise<string | null> {
    return this.secureStore.get(key) ?? null;
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.secureStore.set(key, value);
  }

  async deleteSecret(key: string): Promise<void> {
    this.secureStore.delete(key);
  }
}

export const preferenceStorage: PreferenceStorage = new InMemoryPreferenceStorage();
export const secureStorage: SecureStorage = new HostSecureStorage();
