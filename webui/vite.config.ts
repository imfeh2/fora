import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;
const historyTests = [
  "src/features/members/conversation.test.tsx",
  "src/features/members/use-conversation-history.test.tsx",
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          exclude: [...configDefaults.exclude, ...historyTests],
        },
      },
      {
        extends: true,
        test: {
          name: "history-dom",
          include: historyTests,
          environment: "jsdom",
          environmentOptions: {
            jsdom: {
              url: "http://localhost",
              pretendToBeVisual: true,
            },
          },
          setupFiles: ["src/features/members/conversation-test-setup.ts"],
        },
      },
    ],
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
  },
});
