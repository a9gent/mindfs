import React from "react";

type TokenPart =
  | { type: "text"; value: string }
  | { type: "file"; value: string }
  | { type: "skill"; value: string };

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}

function parseTokenText(content: string): TokenPart[] {
  const parts: TokenPart[] = [];
  const pattern = /\[(read file|use skill):\s*([^\]]+)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: content.slice(lastIndex, match.index) });
    }
    const kind = match[1] === "read file" ? "file" : "skill";
    parts.push({ type: kind, value: match[2].trim() });
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < content.length) {
    parts.push({ type: "text", value: content.slice(lastIndex) });
  }
  return parts;
}

export function InlineTokenText({
  content,
  isDark = false,
  variant = "default",
}: {
  content: string;
  isDark?: boolean;
  variant?: "default" | "inverse";
}) {
  const parts = parseTokenText(content || "");
  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "text") {
          return <React.Fragment key={`text-${index}`}>{part.value}</React.Fragment>;
        }
        const isFile = part.type === "file";
        return (
          <span
            key={`${part.type}-${index}`}
            title={part.value}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "1px 6px",
              margin: "0 1px",
              borderRadius: "8px",
              whiteSpace: "pre",
              verticalAlign: "baseline",
              background: variant === "inverse"
                ? (isFile ? "rgba(59,130,246,0.10)" : "rgba(139,92,246,0.10)")
                : isFile
                  ? (isDark ? "rgba(59,130,246,0.16)" : "rgba(59,130,246,0.10)")
                  : (isDark ? "rgba(139,92,246,0.18)" : "rgba(139,92,246,0.10)"),
              color: variant === "inverse"
                ? (isFile ? "#1d4ed8" : "#7c3aed")
                : isFile
                  ? (isDark ? "#93c5fd" : "#1d4ed8")
                  : (isDark ? "#c4b5fd" : "#7c3aed"),
              border: variant === "inverse"
                ? "none"
                : "none",
            }}
          >
            {isFile ? basename(part.value) : part.value}
          </span>
        );
      })}
    </>
  );
}
