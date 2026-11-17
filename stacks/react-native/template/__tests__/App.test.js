import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('React Native Foundation Stack Verification', () => {
  test('storage contract enforces separation between preferences and secrets', async () => {
    const { preferenceStorage, secureStorage } = await import('../src/services/storage.js').catch(async () => {
      // Fallback for ts-node / transpiled modules if needed
      return await import('../src/services/storage.ts');
    });

    // Storing normal preference should succeed
    await preferenceStorage.setItem('theme', 'dark');
    assert.equal(await preferenceStorage.getItem('theme'), 'dark');

    // Storing sensitive secret in preferenceStorage must throw
    await assert.rejects(
      async () => {
        await preferenceStorage.setItem('auth_token', 'secret-jwt-payload');
      },
      /RULE-MOB-SEC-STORAGE/
    );

    // Storing secret in secureStorage succeeds
    await secureStorage.setSecret('auth_token', 'secret-jwt-payload');
    assert.equal(await secureStorage.getSecret('auth_token'), 'secret-jwt-payload');
  });
});
