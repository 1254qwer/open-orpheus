import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { version } from "../package.json" with { type: "json" };

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  ssr: {
    noExternal: ["@lucide/svelte", "bits-ui"],
  },
  server: {
    hmr: {
      // Avoid conflict with dummy Vite HMR endpoint used by Electron Forge
      path: "sveltekit-hmr",
    },
  },
});
