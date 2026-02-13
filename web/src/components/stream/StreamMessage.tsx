import React, { useMemo } from "react";
import { TextChunk } from "./TextChunk";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";
import type { StreamEvent, ToolCallContentItem } from "../../services/session";

export type StreamChunkData = StreamEvent;

type StreamMessageProps = {
  chunks: StreamChunkData[];
  isStreaming?: boolean;
};

type GroupedContent = {
  type: "text" | "thinking" | "tool";
  content?: string;
  tool?: string;
  callId?: string;
  status?: string;
  contentDetail?: string;
};

export function StreamMessage({ chunks, isStreaming = false }: StreamMessageProps) {
  const formatToolContent = (items?: ToolCallContentItem[]): string | undefined => {
    if (!items || items.length === 0) return undefined;
    const lines: string[] = [];
    for (const item of items) {
      if (item.type === "text") {
        if (item.text) {
          lines.push(item.text);
        }
        continue;
      }
      if (item.type === "diff") {
        const target = item.path || "(unknown)";
        lines.push(`diff: ${target}`);
      }
    }
    if (lines.length === 0) return undefined;
    return lines.join("\n");
  };

  // Group consecutive chunks of the same type
  const grouped = useMemo(() => {
    const result: GroupedContent[] = [];
    let currentText = "";
    let currentThinking = "";
    const toolCalls = new Map<string, GroupedContent>();

    for (const chunk of chunks) {
      switch (chunk.type) {
        case "message_chunk":
          if (currentThinking) {
            result.push({ type: "thinking", content: currentThinking });
            currentThinking = "";
          }
          currentText += chunk.data.content || "";
          break;

        case "thought_chunk":
          if (currentText) {
            result.push({ type: "text", content: currentText });
            currentText = "";
          }
          currentThinking += chunk.data.content || "";
          break;

        case "tool_call":
          if (currentText) {
            result.push({ type: "text", content: currentText });
            currentText = "";
          }
          if (currentThinking) {
            result.push({ type: "thinking", content: currentThinking });
            currentThinking = "";
          }
          if (chunk.data.callId) {
            toolCalls.set(chunk.data.callId, {
              type: "tool",
              tool: chunk.data.name,
              callId: chunk.data.callId,
              status: chunk.data.status || "running",
              contentDetail: formatToolContent(chunk.data.content),
            });
          }
          break;

        case "tool_call_update":
          if (chunk.data.callId && toolCalls.has(chunk.data.callId)) {
            const tc = toolCalls.get(chunk.data.callId)!;
            tc.status = chunk.data.status || "complete";
            tc.contentDetail = formatToolContent(chunk.data.content) || tc.contentDetail;
          }
          break;
        case "message_done":
          break;
        case "error":
          if (currentText) {
            result.push({ type: "text", content: currentText });
            currentText = "";
          }
          if (currentThinking) {
            result.push({ type: "thinking", content: currentThinking });
            currentThinking = "";
          }
          result.push({ type: "text", content: chunk.data.message });
          break;
      }
    }

    // Flush remaining content
    if (currentText) {
      result.push({ type: "text", content: currentText });
    }
    if (currentThinking) {
      result.push({ type: "thinking", content: currentThinking });
    }

    // Add tool calls
    for (const tc of toolCalls.values()) {
      result.push(tc);
    }

    return result;
  }, [chunks]);

  if (grouped.length === 0 && !isStreaming) {
    return null;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {grouped.map((item, index) => {
        switch (item.type) {
          case "text":
            return <TextChunk key={index} content={item.content || ""} />;
          case "thinking":
            return <ThinkingBlock key={index} content={item.content || ""} />;
          case "tool":
            return (
              <ToolCallCard
                key={item.callId || index}
                tool={item.tool || "unknown"}
                callId={item.callId || ""}
                status={item.status || "running"}
                result={item.contentDetail}
              />
            );
          default:
            return null;
        }
      })}

      {isStreaming && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            fontSize: "12px",
            color: "var(--text-secondary)",
          }}
        >
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: "#3b82f6",
              animation: "pulse 1s infinite",
            }}
          />
          正在生成...
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}
