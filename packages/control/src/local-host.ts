export const MINU_CHANNELS_LOCAL_HOSTNAME = "minu-channels.localhost";
export const DEFAULT_CHANNELS_PORT = 47_410;
export const DEFAULT_CONTROL_PORT = 47_411;
export const DEFAULT_WEB_PORT = 47_412;

export function isLocalChannelsHostname(hostname: string | undefined): boolean {
  return hostname === MINU_CHANNELS_LOCAL_HOSTNAME
    || hostname === "127.0.0.1"
    || hostname === "localhost"
    || hostname === "[::1]"
    || hostname === "::1";
}

export function localChannelsUrl(port: number): string {
  return `http://${MINU_CHANNELS_LOCAL_HOSTNAME}:${port}/`;
}
