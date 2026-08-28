import { ChannelClient } from "@minu/channels-core/client";

const endpoint = (import.meta.env.VITE_CHANNELS_API_URL ?? "").replace(/\/$/, "");

export const channels = new ChannelClient(endpoint);
