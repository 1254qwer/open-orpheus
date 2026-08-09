import { defineConfig } from "vite";

import LoggerPlugin from "./plugins/LoggerPlugin.mjs";

// https://vitejs.dev/config
export default defineConfig({
  plugins: [
    LoggerPlugin({
      logger: "src/preload/logger.ts",
    }),
  ],
});
