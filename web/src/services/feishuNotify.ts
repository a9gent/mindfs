import { protectedJSON } from "./api";
import { appPath } from "./base";

export type FeishuNotifyConfig = {
  enabled: boolean;
  webhook_url: string;
  app_id: string;
  has_app_secret: boolean;
  chat_id: string;
  events?: string[];
  active: boolean;
};

export type FeishuNotifyUpdate = {
  enabled?: boolean;
  webhook_url?: string;
  app_id?: string;
  /** omit to keep; empty string clears; non-empty replaces */
  app_secret?: string;
  chat_id?: string;
  events?: string[];
};

export async function getFeishuNotifyConfig(): Promise<FeishuNotifyConfig> {
  return protectedJSON<FeishuNotifyConfig>(appPath("/api/feishu-notify"));
}

export async function updateFeishuNotifyConfig(input: FeishuNotifyUpdate): Promise<FeishuNotifyConfig> {
  return protectedJSON<FeishuNotifyConfig>(appPath("/api/feishu-notify"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function sendFeishuNotifyTest(): Promise<void> {
  await protectedJSON(appPath("/api/feishu-notify/test"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}
