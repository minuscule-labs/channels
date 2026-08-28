import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_CHANNELS_PROXY_TARGET ?? "http://127.0.0.1:4310";
  const controlTarget = env.VITE_CHANNELS_CONTROL_PROXY_TARGET ?? "http://127.0.0.1:4311";
  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        "/channels": { target, changeOrigin: true },
        "/workspaces": { target, changeOrigin: true },
        "/identities": { target, changeOrigin: true },
        "/local": { target: controlTarget, changeOrigin: true },
      },
    },
  };
});
