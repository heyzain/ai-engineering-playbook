export default [
  {
    ignores: [
      "node_modules/**",
      "android/**",
      "ios/**",
      "dist/**",
      "coverage/**",
      ".metro/**",
      "metro-cache/**",
      ".playbook/**",
      "**/*.ts",
      "**/*.tsx",
      "**/*.d.ts"
    ],
  },
  {
    files: ["**/*.{js,jsx,mjs}"],
    rules: {
      "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
      "no-undef": "off",
      "no-console": "off"
    }
  }
];
