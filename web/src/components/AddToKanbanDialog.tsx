import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { reportError } from "../services/error";
import { fetchTaskTemplates, createTask, attachSessionToTask, type TaskTemplate } from "../services/tasks";
import { sessionService } from "../services/session";
import type { SessionItem } from "./SessionList";
import { createPortal } from "react-dom";

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.4)",
  zIndex: 3000,
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  paddingTop: "12vh",
};

const dialogStyle: React.CSSProperties = {
  width: "min(92vw, 420px)",
  maxHeight: "min(76vh, 520px)",
  overflow: "auto",
  borderRadius: "14px",
  border: "1px solid var(--border-color)",
  background: "var(--menu-bg, var(--content-bg, #fff))",
  boxShadow: "0 18px 50px rgba(15, 23, 42, 0.22)",
  padding: "16px",
};

const templateButtonStyle: React.CSSProperties = {
  width: "100%",
  border: "1px solid var(--border-color)",
  background: "transparent",
  borderRadius: "10px",
  padding: "10px 12px",
  textAlign: "left",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  gap: "2px",
};

export function AddToKanbanDialog({
  open,
  session,
  onClose,
  onAttached,
}: {
  open: boolean;
  session: SessionItem | null;
  onClose: () => void;
  onAttached?: (session: SessionItem) => void;
}) {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) {
      setTemplates([]);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    fetchTaskTemplates()
      .then((items) => {
        if (!cancelled) setTemplates(items.filter((item) => !!item.id));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onClose]);

  if (!open || !session) return null;
  const rootId = session.root_id || "";
  const sessionKey = session.key || session.session_key;
  const sessionName = session.name || `Session ${sessionKey.slice(0, 8)}`;

  const handlePick = async (template: TaskTemplate) => {
    if (!rootId || !sessionKey || busy) return;
    setBusy(true);
    try {
      const detail = await createTask(rootId, template.id || "", sessionName);
      await attachSessionToTask(rootId, detail.task.id, sessionKey);
      // 前缀命名对齐看板原生 "{模板名} / #{N}" 格式，保留用户原语义
      const nextName = `${template.name} / ${sessionName}`;
      if ((session.name || "").trim() !== nextName) {
        try {
          await sessionService.renameSession(rootId, sessionKey, nextName);
        } catch {
          // 重命名失败不阻断绑定：任务已建、会话已挂
        }
      }
      reportError("clipboard.write_failed", t("sessionList.addToKanbanSuccess"), { severity: "info" });
      onAttached?.({ ...session, task_id: detail.task.id });
      onClose();
    } catch (err) {
      const message = String((err as Error)?.message || "");
      reportError(
        "session.delete_failed",
        message.includes("already bound") || message.includes("already has a main session")
          ? t("sessionList.addToKanbanAlreadyAttached")
          : t("sessionList.addToKanbanFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      role="presentation"
      style={overlayStyle}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div role="dialog" aria-label={t("sessionList.addToKanbanTitle")} style={dialogStyle}>
        <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--text-primary)" }}>
          {t("sessionList.addToKanbanTitle")}
        </div>
        <div
          style={{
            fontSize: "12px",
            color: "var(--text-secondary)",
            marginTop: "4px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {sessionName}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "12px" }}>
          {loading ? (
            <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "10px 0", textAlign: "center" }}>
              {t("common.loading")}
            </div>
          ) : failed ? (
            <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "10px 0", textAlign: "center" }}>
              {t("sessionList.addToKanbanFailed")}
            </div>
          ) : templates.length === 0 ? (
            <div style={{ fontSize: "12px", color: "var(--text-secondary)", padding: "10px 0", textAlign: "center" }}>
              {t("sessionList.addToKanbanEmpty")}
            </div>
          ) : (
            templates.map((template) => (
              <button
                key={template.id}
                type="button"
                disabled={busy}
                onClick={() => void handlePick(template)}
                style={{ ...templateButtonStyle, opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }}
              >
                <span style={{ fontSize: "13px", color: "var(--text-primary)", fontWeight: 600 }}>{template.name}</span>
                {template.description ? (
                  <span
                    style={{
                      fontSize: "11px",
                      color: "var(--text-secondary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {template.description}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
        {busy ? (
          <div style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "10px" }}>
            {t("sessionList.addToKanbanCreating")}
          </div>
        ) : (
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", marginTop: "12px", lineHeight: 1.5 }}>
            {t("sessionList.addToKanbanAttachWarning")}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
