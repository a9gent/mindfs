import { useEffect, useMemo, useState } from "react";
import {
  sessionService,
  type ExchangeAux,
  type TodoUpdate,
  type ToolCall,
} from "../services/session";

type ExchangeLike = {
  seq?: number;
  role?: string;
  agent?: string;
  content?: string;
  context_window?: {
    totalTokens: number;
    modelContextWindow: number;
  };
  timestamp?: string;
  toolCall?: ToolCall;
  todoUpdate?: TodoUpdate;
  pending_ack?: boolean;
};

type ExchangeAuxMapLike = Record<string, ExchangeAux[]>;

export type TimelineItem =
  | {
      id: string;
      type: "user_text" | "assistant_text";
      content: string;
      timestamp?: string;
      agent?: string;
      pendingAck?: boolean;
      seq?: number;
      contextWindow?: {
        totalTokens: number;
        modelContextWindow: number;
      };
    }
  | { id: string; type: "thought"; content: string }
  | { id: string; type: "tool"; toolCall: ToolCall }
  | { id: string; type: "todo"; todoUpdate: TodoUpdate; timestamp?: string };

type UseSessionStreamResult = {
  timeline: TimelineItem[];
  isStreaming: boolean;
  streamVersion: number;
  streamStatusText: string;
};

type ContextWindowLike = {
  totalTokens: number;
  modelContextWindow: number;
};

function hashText(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableTimelineID(
  prefix: string,
  index: number,
  content: string,
  timestamp?: string,
  agent?: string,
): string {
  return `${prefix}:${index}:${timestamp || ""}:${agent || ""}:${hashText(content)}`;
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
    const kind = (item.toolCall.kind || "").toLowerCase();
    if (kind === "ask_user") return item;
    const status = (item.toolCall.status || "").toLowerCase();
    if (
      status === "running" ||
      status === "in_progress" ||
      status === "pending"
    ) {
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

function assistantSegmentItem(
  index: number,
  ex: ExchangeLike,
  content: string,
  segmentIndex: number,
  includeContextWindow: boolean,
): TimelineItem | null {
  if (!content) {
    return null;
  }
  return {
    id: stableTimelineID(
      "assistant",
      index * 1000 + segmentIndex,
      content,
      ex.timestamp,
      ex.agent,
    ),
    type: "assistant_text",
    content,
    timestamp: ex.timestamp,
    agent: ex.agent,
    seq: ex.seq,
    contextWindow: includeContextWindow ? ex.context_window : undefined,
  };
}

function buildAssistantTimeline(
  ex: ExchangeLike,
  index: number,
  auxList: ExchangeAux[],
): TimelineItem[] {
  const content = ex.content || "";
  if (!auxList.length) {
    const single = assistantSegmentItem(index, ex, content, 0, true);
    return single ? [single] : [];
  }

  const lines = content === "" ? [] : content.split("\n");
  const totalLines = lines.length;
  const out: TimelineItem[] = [];
  const normalizedAux = auxList.map((aux, auxIndex) => ({
    ...aux,
    auxIndex,
    line: Math.max(0, Math.min(totalLines, Number(aux.line || 0))),
  }));
  normalizedAux.sort((left, right) => {
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    return left.auxIndex - right.auxIndex;
  });

  let emittedLines = 0;
  let segmentIndex = 0;
  for (const aux of normalizedAux) {
    if (aux.line > emittedLines) {
      const segment = assistantSegmentItem(
        index,
        ex,
        lines.slice(emittedLines, aux.line).join("\n"),
        segmentIndex,
        false,
      );
      if (segment) {
        out.push(segment);
        segmentIndex += 1;
      }
      emittedLines = aux.line;
    }
    if (aux.thought) {
      out.push({
        id: stableTimelineID(
          "thought",
          index * 1000 + segmentIndex,
          aux.thought,
          ex.timestamp,
          ex.agent,
        ),
        type: "thought",
        content: aux.thought,
      });
      segmentIndex += 1;
    } else if (aux.toolcall) {
      const normalizedTool = normalizeToolCall(aux.toolcall);
      out.push({
        id:
          normalizedTool.callId ||
          stableTimelineID(
            "tool",
            index * 1000 + segmentIndex,
            JSON.stringify(normalizedTool),
            ex.timestamp,
            ex.agent,
          ),
        type: "tool",
        toolCall: normalizedTool,
      });
      segmentIndex += 1;
    }
  }

  if (emittedLines < totalLines) {
    const segment = assistantSegmentItem(
      index,
      ex,
      lines.slice(emittedLines).join("\n"),
      segmentIndex,
      true,
    );
    if (segment) {
      out.push(segment);
      segmentIndex += 1;
    }
  } else {
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (out[i].type === "assistant_text") {
        out[i] = {
          ...out[i],
          contextWindow: ex.context_window,
        };
        break;
      }
    }
  }

  return out;
}

function buildBaseTimeline(
  exchanges: ExchangeLike[],
  exchangeAux: ExchangeAuxMapLike,
): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (let index = 0; index < exchanges.length; index += 1) {
    const ex = exchanges[index];
    const role = normalizeRole(ex.role);
    const content = ex.content || "";
    if (role === "user") {
      if (!content) continue;
      out.push({
        id: stableTimelineID("user", index, content, ex.timestamp, ex.agent),
        type: "user_text",
        content,
        timestamp: ex.timestamp,
        agent: ex.agent,
        pendingAck: ex.pending_ack === true,
        seq: ex.seq,
      });
      continue;
    }
    if (role === "agent" || role === "assistant") {
      const auxList = ex.seq ? exchangeAux[String(ex.seq)] || [] : [];
      out.push(...buildAssistantTimeline(ex, index, auxList));
      continue;
    }
    if (role === "thought") {
      if (!content) continue;
      out.push({
        id: stableTimelineID("thought", index, content, ex.timestamp, ex.agent),
        type: "thought",
        content,
      });
      continue;
    }
    if (role === "tool") {
      if (!ex.toolCall) continue;
      const normalizedTool = normalizeToolCall(ex.toolCall);
      out.push({
        id:
          normalizedTool.callId ||
          stableTimelineID(
            "tool",
            index,
            JSON.stringify(normalizedTool),
            ex.timestamp,
            ex.agent,
          ),
        type: "tool",
        toolCall: normalizedTool,
      });
      continue;
    }
    if (role === "todo") {
      if (!ex.todoUpdate) continue;
      out.push({
        id: stableTimelineID(
          "todo",
          index,
          JSON.stringify(ex.todoUpdate),
          ex.timestamp,
          ex.agent,
        ),
        type: "todo",
        todoUpdate: ex.todoUpdate,
        timestamp: ex.timestamp,
      });
    }
  }
  return out;
}

function applySessionContextWindow(
  items: TimelineItem[],
  contextWindow?: ContextWindowLike,
): TimelineItem[] {
  const totalTokens = Math.max(0, Number(contextWindow?.totalTokens || 0));
  const modelContextWindow = Math.max(
    0,
    Number(contextWindow?.modelContextWindow || 0),
  );
  if (!totalTokens || !modelContextWindow) {
    return items;
  }
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.type !== "assistant_text") {
      continue;
    }
    if (
      item.contextWindow?.totalTokens &&
      item.contextWindow?.modelContextWindow
    ) {
      return items;
    }
    const next = [...items];
    next[i] = {
      ...item,
      contextWindow: {
        totalTokens,
        modelContextWindow,
      },
    };
    return next;
  }
  return items;
}

export function useSessionStream(
  sessionKey: string | null,
  exchanges: ExchangeLike[] = [],
  exchangeAux: ExchangeAuxMapLike = {},
  sessionContextWindow?: ContextWindowLike,
): UseSessionStreamResult {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamVersion, setStreamVersion] = useState(0);
  const [streamStatusText, setStreamStatusText] = useState("");

  const baseTimeline = useMemo(
    () =>
      applySessionContextWindow(
        buildBaseTimeline(exchanges, exchangeAux),
        sessionContextWindow,
      ),
    [exchanges, exchangeAux, sessionContextWindow],
  );

  useEffect(() => {
    setIsStreaming(false);
    setStreamVersion(0);
    setStreamStatusText("");
    if (!sessionKey) return;

    const unsubscribe = sessionService.subscribe(sessionKey, {
      onStream: (event) => {
        setStreamVersion((value) => value + 1);
        if (event.type === "recovery") {
          setStreamStatusText(event.data?.message || "遇到错误，重试中...");
          setIsStreaming(true);
          return;
        }
        if (event.type === "message_chunk") {
          setStreamStatusText("");
        }
        if (event.type === "message_done" || event.type === "error") {
          setStreamStatusText("");
          setIsStreaming(false);
        } else {
          setIsStreaming(true);
        }
      },
      onDone: () => {
        setStreamStatusText("");
        setIsStreaming(false);
      },
      onError: () => {
        setStreamStatusText("");
        setIsStreaming(false);
      },
    });

    return () => {
      unsubscribe();
    };
  }, [sessionKey]);

  return {
    timeline: settleRunningTools(baseTimeline),
    isStreaming,
    streamVersion,
    streamStatusText,
  };
}
