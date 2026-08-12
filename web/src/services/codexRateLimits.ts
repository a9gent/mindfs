import { protectedJSON } from "./api";
import { appPath } from "./base";

export type CodexRateLimitWindow = {
  used_percent: number;
  window_duration_mins?: number;
  resets_at?: number;
};

export type CodexRateLimitResetCredit = {
  id: string;
  reset_type?: string;
  status?: string;
  granted_at?: number;
  expires_at?: number;
  title?: string;
  description?: string;
};

export type CodexRateLimitStatus = {
  uses_chatgpt_plan: boolean;
  weekly?: CodexRateLimitWindow;
  reset_credits?: {
    available_count: number;
    credits?: CodexRateLimitResetCredit[];
  };
};

export type ConsumeCodexRateLimitResetResult = {
  outcome: "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed" | string;
  status: CodexRateLimitStatus;
};

export async function fetchCodexRateLimits(agent = "codex"): Promise<CodexRateLimitStatus> {
  const params = new URLSearchParams({ agent });
  return protectedJSON<CodexRateLimitStatus>(
    `${appPath("/api/agents/codex/rate-limits")}?${params.toString()}`,
  );
}

export async function consumeCodexRateLimitReset(
  idempotencyKey: string,
  creditId?: string,
  agent = "codex",
): Promise<ConsumeCodexRateLimitResetResult> {
  return protectedJSON<ConsumeCodexRateLimitResetResult>(
    appPath("/api/agents/codex/rate-limit-reset"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent,
        idempotency_key: idempotencyKey,
        ...(creditId ? { credit_id: creditId } : {}),
      }),
    },
  );
}
