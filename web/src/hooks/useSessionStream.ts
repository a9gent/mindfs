import { useEffect, useMemo, useState } from "react";
import { sessionService, type ToolCall } from "../services/session";

type ExchangeLike = {
  role?: string;
  agent?: string;
  content?: string;
  timestamp?: string;
  toolCall?: ToolCall;
  pending_ack?: boolean;
};

export type TimelineItem =
  | { id: string; type: "user_text" | "assistant_text"; content: string; timestamp?: string; agent?: string; pendingAck?: boolean }
  | { id: string; type: "thought"; content: string }
  | { id: string; type: "tool"; toolCall: ToolCall };

type UseSessionStreamResult = {
  timeline: TimelineItem[];
  isStreaming: boolean;
  streamVersion: number;
};

function nowID(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRole(role?: string): string {
  return (role || "").toLowerCase();
}

function normalizeToolCallStatus(status?: string): string {
  const value = (status || "").toLowerCase();
  if (value === "completed") return "complete";
  if (value === "pending") return "running";
  return value || "running";
}

function normalizeToolCall(input: ToolCall): ToolCall {
  const raw = input as ToolCall & {
    toolCallId?: string;
    tool_call_id?: string;
  };
  const callId = raw.callId || raw.toolCallId || raw.tool_call_id || "";
  return {
    ...input,
    callId,
    status: normalizeToolCallStatus(raw.status),
  };
}

function settleRunningTools(items: TimelineItem[]): TimelineItem[] {
  return items.map((item) => {
    if (item.type !== "tool") return item;
    const status = (item.toolCall.status || "").toLowerCase();
    if (status === "running" || status === "in_progress" || status === "pending") {
      return {
        ...item,
        toolCall: {
          ...item.toolCall,
          status: "complete",
        },
      };
    }
    return item;
  });
}

function buildBaseTimeline(exchanges: ExchangeLike[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const ex of exchanges) {
    const role = normalizeRole(ex.role);
    const content = ex.content || "";
    if (role === "user") {
      if (!content) continue;
      out.push({ id: nowID("user"), type: "user_text", content, timestamp: ex.timestamp, agent: ex.agent, pendingAck: ex.pending_ack === true });
      continue;
    }
    if (role === "agent" || role === "assistant") {
      if (!content) continue;
      out.push({ id: nowID("assistant"), type: "assistant_text", content, timestamp: ex.timestamp, agent: ex.agent });
      continue;
    }
    if (role === "thought") {
      if (!content) continue;
      out.push({ id: nowID("thought"), type: "thought", content });
      continue;
    }
    if (role === "tool") {
      if (!ex.toolCall) continue;
      out.push({
        id: ex.toolCall.callId || nowID("tool"),
        type: "tool",
        toolCall: normalizeToolCall(ex.toolCall),
      });
    }
  }
  return out;
}

export function useSessionStream(
  sessionKey: string | null,
  exchanges: ExchangeLike[] = []
): UseSessionStreamResult {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamVersion, setStreamVersion] = useState(0);

  const baseTimeline = useMemo(() => buildBaseTimeline(exchanges), [exchanges]);

  useEffect(() => {
    setIsStreaming(false);
    setStreamVersion(0);
    if (!sessionKey) return;

    const unsubscribe = sessionService.subscribe(sessionKey, {
      onStream: (event) => {
        setStreamVersion((value) => value + 1);
        if (event.type === "message_done" || event.type === "error") {
          setIsStreaming(false);
        } else {
          setIsStreaming(true);
        }
      },
      onDone: () => setIsStreaming(false),
      onError: () => setIsStreaming(false),
    });

    return () => {
      unsubscribe();
    };
  }, [sessionKey]);

  return {
    timeline: settleRunningTools(baseTimeline),
    isStreaming,
    streamVersion,
  };
}
