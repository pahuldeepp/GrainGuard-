import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const useMockAuth = env.VITE_E2E_MOCK_AUTH === "true";

  return {
    plugins: [react()],
    resolve: useMockAuth
      ? {
          alias: {
            "@auth0/auth0-react": fileURLToPath(
              new URL("./src/e2e/auth0Mock.tsx", import.meta.url)
            ),
          },
        }
      : undefined,
  };
});
