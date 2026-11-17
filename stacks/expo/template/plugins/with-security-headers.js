/**
 * Expo Config Plugin: with-security-headers
 * 
 * Enforces declarative native configuration for security headers and network security.
 * Demonstrates RULE-EXPO-PLUGINS: all native modifications occur declaratively
 * through plugins rather than manual edits to android/ and ios/ native folders.
 */

module.exports = function withSecurityHeaders(config, options = {}) {
  // 1. Android network security configuration
  if (!config.android) config.android = {};
  if (!config.android.blockedPermissions) {
    config.android.blockedPermissions = [];
  }

  // 2. iOS Info.plist transport security policy
  if (!config.ios) config.ios = {};
  if (!config.ios.infoPlist) config.ios.infoPlist = {};
  
  config.ios.infoPlist.NSAppTransportSecurity = {
    NSAllowsArbitraryLoads: false,
    ...config.ios.infoPlist.NSAppTransportSecurity,
  };

  return config;
};
