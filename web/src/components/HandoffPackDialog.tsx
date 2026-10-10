import React, { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { copyText } from "../services/clipboard";
import { sessionService } from "../services/session";
import type { SessionItem } from "./SessionList";
import {
  loadHandoffTemplate,
  persistHandoffTemplate,
  renderHandoffPack,
  templateFromRenderedPack,
  type HandoffContext,
} from "../services/handoff";

type HandoffPackDialogProps = {
  session: SessionItem | null;
  onClose: () => void;
  onInsert: (pack: string) => void;
};

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.4)",
  zIndex: 3000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "16px",
};

const dialogStyle: React.CSSProperties = {
  width: "min(92vw, 560px)",
  maxHeight: "min(84vh, 640px)",
  background: "var(--content-bg, #fff)",
  border: "1px solid var(--border-color)",
  borderRadius: "14px",
  boxShadow: "0 18px 48px rgba(0,0,0,0.25)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const actionButtonStyle: React.CSSProperties = {
  border: "1px solid var(--border-color)",
  borderRadius: "8px",
  padding: "7px 12px",
  background: "transparent",
  color: "var(--text-primary)",
  fontSize: "12px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const primaryButtonStyle: React.CSSProperties = {
  ...actionButtonStyle,
  background: "var(--accent-color)",
  borderColor: "var(--accent-color)",
  color: "#fff",
};

export function HandoffPackDialog({ session, onClose, onInsert }: HandoffPackDialogProps) {
  const { t } = useI18n();
  const [context, setContext] = useState<HandoffContext | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [pack, setPack] = useState("");
  const [copied, setCopied] = useState(false);
  const [templateSaved, setTemplateSaved] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const requestSeqRef = useRef(0);

  const template = useMemo(() => loadHandoffTemplate(), [session?.key]);

  useEffect(() => {
    if (!session?.root_id) {
      return;
    }
    const seq = ++requestSeqRef.current;
    setContext(null);
    setLoadError(false);
    setCopied(false);
    setTemplateSaved(false);
    sessionService
      .getSessionLogPath(session.root_id, session.session_key || session.key)
      .then(({ path, agentSessionId }) => {
        if (requestSeqRef.current !== seq) {
          return;
        }
        const nextContext: HandoffContext = {
          sessionKey: session.session_key || session.key,
          jsonlPath: path,
          agentSessionId,
        };
        setContext(nextContext);
        setPack(renderHandoffPack(loadHandoffTemplate(), nextContext));
      })
      .catch((err) => {
        if (requestSeqRef.current !== seq) {
          return;
        }
        console.error("[Handoff] Failed to fetch session log path:", err);
        setLoadError(true);
        const fallbackContext: HandoffContext = {
          sessionKey: session.session_key || session.key,
          jsonlPath: "",
          agentSessionId: "",
        };
        setContext(fallbackContext);
        setPack(renderHandoffPack(loadHandoffTemplate(), fallbackContext));
      });
  }, [session]);

  useEffect(() => {
    if (!session) {
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [session, onClose]);

  useEffect(() => {
    if (context && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [context]);

  const handleSaveTemplate = () => {
    if (!context) {
      return;
    }
    persistHandoffTemplate(templateFromRenderedPack(pack, context));
    setTemplateSaved(true);
  };

  if (!session) {
    return null;
  }

  return (
    <div
      style={overlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div style={dialogStyle} role="dialog" aria-modal="true" aria-label={t("session.handoff.title")}>
        <div
          style={{
            padding: "14px 16px 10px",
            borderBottom: "1px solid var(--border-color)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-primary)" }}>
              {t("session.handoff.title")}
            </div>
            <div
              style={{
                fontSize: "11px",
                color: "var(--text-secondary)",
                marginTop: "2px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {session.name || `Session ${session.key.slice(0, 8)}`}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            style={{
              width: "28px",
              height: "28px",
              border: "none",
              borderRadius: "8px",
              background: "transparent",
              color: "var(--text-secondary)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, padding: "12px 16px", display: "flex", flexDirection: "column" }}>
          {!context ? (
            <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "18px 0" }}>
              {loadError ? t("session.handoff.pathFailed") : t("session.handoff.loading")}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            value={pack}
            onChange={(e) => {
              setPack(e.target.value);
              setCopied(false);
              setTemplateSaved(false);
            }}
            spellCheck={false}
            style={{
              flex: 1,
              minHeight: "180px",
              resize: "vertical",
              border: "1px solid var(--border-color)",
              borderRadius: "10px",
              padding: "10px 12px",
              background: "transparent",
              color: "var(--text-primary)",
              fontSize: "12.5px",
              lineHeight: 1.65,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              outline: "none",
            }}
          />
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", padding: "8px 2px 0", lineHeight: 1.5 }}>
            {t("session.handoff.hint")}
          </div>
        </div>

        <div
          style={{
            padding: "10px 16px 14px",
            borderTop: "1px solid var(--border-color)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexWrap: "wrap",
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            disabled={!context}
            onClick={() => {
              void copyText(pack)
                .then(() => setCopied(true))
                .catch((err) => console.error("[Handoff] Failed to copy pack:", err));
            }}
            style={actionButtonStyle}
          >
            {copied ? t("session.handoff.copied") : t("session.handoff.copy")}
          </button>
          <button
            type="button"
            disabled={!context}
            onClick={handleSaveTemplate}
            style={actionButtonStyle}
          >
            {templateSaved ? t("session.handoff.templateSaved") : t("session.handoff.saveTemplate")}
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            disabled={!context}
            onClick={() => {
              onInsert(pack);
              onClose();
            }}
            style={primaryButtonStyle}
          >
            {t("session.handoff.insert")}
          </button>
        </div>
      </div>
    </div>
  );
}
