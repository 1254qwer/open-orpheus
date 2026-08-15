import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import PinoWorkerPlugin from "./plugins/PinoWorkerPlugin.mjs";
import NoS3Plugin from "./plugins/NoS3Plugin.mjs";
import LoggerPlugin from "./plugins/LoggerPlugin.mjs";

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      $sharedTypes: path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "types"
      ),
    },
  },
  build: {
    rollupOptions: {
      external: [
        // Node built-ins
        "sqlite",
        // Keyv SQLite driver workarounds
        "better-sqlite3",
        // Native/WASM Modules
        "7z-wasm",
        "music-tag-native",
        "@silvia-odwyer/photon-node",
        "@open-orpheus/database",
        "@open-orpheus/window",
        "@open-orpheus/ui",
        "@open-orpheus/dbus",
        "@open-orpheus/smtc",
      ],
    },
  },
  // unzipper has a dependency on @aws-sdk/client-s3, which is not needed in
  // our context and causes build issues. This plugin mocks it out.
  plugins: [NoS3Plugin(), PinoWorkerPlugin(), LoggerPlugin()],
});
