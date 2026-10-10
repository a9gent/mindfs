export const HANDOFF_TEMPLATE_STORAGE_KEY = "mindfs-handoff-template";

export const HANDOFF_PATH_FALLBACK = "（路径获取失败，请手动补填）";
export const HANDOFF_AGENT_ID_FALLBACK = "（无）";

// 模板有意保持中文：接力包的读者是主人手下的 AI 代理（工作语言中文），
// 且模板是用户数据存 localStorage，随界面语言切换会造成同值双语混乱
export const DEFAULT_HANDOFF_TEMPLATE = [
  "【会话接力】接手以下 MindFS 会话，继续未完成的任务。",
  "1. 会话源文件（JSONL，每行一条消息；文件可能很大，先用 tail 读最后 200 行，不够再往前翻）：",
  "   {jsonl_path}",
  "2. 会话 ID：{session_key}",
  "3. 若你是 codex，可用原生线程恢复：{agent_session_id}（为空则忽略本条）",
  "请先复述你对任务的理解，然后继续执行。",
].join("\n");

export type HandoffContext = {
  sessionKey: string;
  jsonlPath: string;
  agentSessionId: string;
};

export function loadHandoffTemplate(): string {
  if (typeof window === "undefined") {
    return DEFAULT_HANDOFF_TEMPLATE;
  }
  try {
    const stored = window.localStorage.getItem(HANDOFF_TEMPLATE_STORAGE_KEY);
    if (typeof stored === "string" && stored.includes("{jsonl_path}")) {
      return stored;
    }
    return DEFAULT_HANDOFF_TEMPLATE;
  } catch {
    return DEFAULT_HANDOFF_TEMPLATE;
  }
}

export function persistHandoffTemplate(template: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(HANDOFF_TEMPLATE_STORAGE_KEY, template);
  } catch {
    // storage unavailable; template stays session-local
  }
}

export function renderHandoffPack(template: string, context: HandoffContext): string {
  return template
    .split("{jsonl_path}").join(context.jsonlPath || HANDOFF_PATH_FALLBACK)
    .split("{session_key}").join(context.sessionKey)
    .split("{agent_session_id}").join(context.agentSessionId || HANDOFF_AGENT_ID_FALLBACK);
}

/**
 * Inverse of renderHandoffPack for "save as default template": put the
 * placeholders back in place of the concrete values currently shown —
 * including the fallback literals shown for missing values, so a pack
 * rendered for a session without an agent id still saves as a template
 * carrying {agent_session_id}.
 */
export function templateFromRenderedPack(rendered: string, context: HandoffContext): string {
  let template = rendered
    .split(HANDOFF_PATH_FALLBACK).join("{jsonl_path}")
    .split(HANDOFF_AGENT_ID_FALLBACK).join("{agent_session_id}");
  if (context.jsonlPath) {
    template = template.split(context.jsonlPath).join("{jsonl_path}");
  }
  if (context.sessionKey) {
    template = template.split(context.sessionKey).join("{session_key}");
  }
  if (context.agentSessionId) {
    template = template.split(context.agentSessionId).join("{agent_session_id}");
  }
  return template;
}
