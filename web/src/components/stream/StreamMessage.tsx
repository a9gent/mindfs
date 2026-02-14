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

  // 顺序分组逻辑：保持内容、思考、工具调用的原始顺序
  const grouped = useMemo(() => {
    const result: GroupedContent[] = [];
    let currentText = "";
    let currentThinking = "";
    
    // 用于快速查找并更新已存在的工具块
    const toolCallRefs = new Map<string, GroupedContent>();

    const flush = () => {
      if (currentText) {
        result.push({ type: "text", content: currentText });
        currentText = "";
      }
      if (currentThinking) {
        result.push({ type: "thinking", content: currentThinking });
        currentThinking = "";
      }
    };

    for (const chunk of chunks) {
      switch (chunk.type) {
        case "message_chunk":
          if (currentThinking) flush();
          currentText += chunk.data.content || "";
          break;

        case "thought_chunk":
          if (currentText) flush();
          currentThinking += chunk.data.content || "";
          break;

        case "tool_call":
          flush(); // 工具调用出现前，先清空之前的文字/思考
          if (chunk.data.callId) {
            const toolBlock: GroupedContent = {
              type: "tool",
              tool: chunk.data.name,
              callId: chunk.data.callId,
              status: chunk.data.status || "running",
              contentDetail: formatToolContent(chunk.data.content),
            };
            result.push(toolBlock);
            toolCallRefs.set(chunk.data.callId, toolBlock);
          }
          break;

        case "tool_call_update":
          if (chunk.data.callId && toolCallRefs.has(chunk.data.callId)) {
            const tc = toolCallRefs.get(chunk.data.callId)!;
            tc.status = chunk.data.status || "complete";
            tc.contentDetail = formatToolContent(chunk.data.content) || tc.contentDetail;
          }
          break;

        case "error":
          flush();
          result.push({ type: "text", content: chunk.data.message });
          break;
      }
    }

    flush();
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
            return <TextChunk key={`text-${index}`} content={item.content || ""} />;
          case "thinking":
            return <ThinkingBlock key={`thought-${index}`} content={item.content || ""} />;
          case "tool":
            return (
              <ToolCallCard
                key={item.callId || `tool-${index}`}
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
            marginTop: "4px"
          }}
        >
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              background: "var(--accent-color)",
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
