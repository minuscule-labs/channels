import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_CHANNELS_PROXY_TARGET ?? "http://127.0.0.1:4310";
  const controlTarget = env.VITE_CHANNELS_CONTROL_PROXY_TARGET ?? "http://127.0.0.1:4311";
  const serviceToken = env.MINU_CHANNELS_SERVICE_TOKEN;
  const channelProxy = {
    target,
    changeOrigin: true,
    headers: serviceToken ? { authorization: `Bearer ${serviceToken}` } : undefined,
    configure(proxy: { on(event: "proxyReq", listener: (request: { removeHeader(name: string): void }) => void): void }) {
      proxy.on("proxyReq", (request) => request.removeHeader("origin"));
    },
  };
  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        "/channels": channelProxy,
        "/workspaces": channelProxy,
        "/identities": channelProxy,
        "/local": { target: controlTarget, changeOrigin: true },
      },
    },
  };
});
