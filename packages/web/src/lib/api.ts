import { LocalControlClient } from "@minu/channels-control/client";
import { ChannelClient } from "@minu/channels-core/client";

const endpoint = (import.meta.env.VITE_CHANNELS_API_URL ?? "").replace(/\/$/, "");
const controlEndpoint = (import.meta.env.VITE_CHANNELS_CONTROL_API_URL ?? "").replace(/\/$/, "");

export const channels = new ChannelClient(endpoint);
export const localControl = new LocalControlClient(controlEndpoint);
