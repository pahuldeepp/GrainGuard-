import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/src/**/__tests__/**/*.test.ts"],
  setupFiles: ["<rootDir>/jest.setup.ts"],
  // Map lib shims so they don't try to use the real DB / JWKS in tests
  moduleNameMapper: {
    "^../middleware/rateLimiting$":    "<rootDir>/src/__mocks__/rateLimiting.ts",
    "^../../middleware/rateLimiting$": "<rootDir>/src/__mocks__/rateLimiting.ts",
  },
  clearMocks: true,
};

export default config;
