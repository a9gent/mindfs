import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { protectedJSON, ProtectedAPIError } from "../services/api";
import { appURL } from "../services/base";
import { readClipboardText } from "../services/clipboard";
import { fetchEditableFile, saveTextFile } from "../services/file";
import { listRecentDirs } from "../services/recentDirs";
import type { FileEntry } from "../services/directorySort";

type QuickSaveFilePanelProps = {
  open: boolean;
  rootId: string | null;
  /** Current directory relative to the project root ("." for the root itself). */
  currentDir: string;
  /** Absolute filesystem path of the project root, used to shorten recent-dir paths. */
  rootPath?: string | null;
  onClose: () => void;
  onSaved: (path: string, dir: string) => void;
};

const DEFAULT_EXTENSION = ".md";

/** Join a directory path with a child segment, keeping "." as the root. */
function joinDir(dir: string, child: string): string {
  const base = !dir || dir === "." ? "" : dir.replace(/\/+$/, "");
  return base ? `${base}/${child}` : child;
}

/** Parent of a relative dir, or "." when already at the root. */
function parentDir(dir: string): string {
  const trimmed = (dir || ".").replace(/\/+$/, "");
  if (!trimmed || trimmed === ".") return ".";
  const parts = trimmed.split("/");
  parts.pop();
  return parts.length ? parts.join("/") : ".";
}

/** Combine a stem and extension without doubling an already-present extension. */
function composeFileName(name: string, ext: string): string {
  const stem = name.trim();
  const rawExt = ext.trim();
  if (!rawExt) return stem;
  const normExt = rawExt.startsWith(".") ? rawExt : `.${rawExt}`;
  if (stem.toLowerCase().endsWith(normExt.toLowerCase())) return stem;
  return stem + normExt;
}

function invalidName(name: string): boolean {
  return !name || name === "." || name === ".." || /[/\\\x00]/.test(name);
}

export function QuickSaveFilePanel({
  open,
  rootId,
  currentDir,
  rootPath,
  onClose,
  onSaved,
}: QuickSaveFilePanelProps) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [extension, setExtension] = useState(DEFAULT_EXTENSION);
  const [content, setContent] = useState("");
  const [targetDir, setTargetDir] = useState(".");
  const [browseDir, setBrowseDir] = useState(".");
  const [subDirs, setSubDirs] = useState<FileEntry[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [manualPath, setManualPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" && window.innerWidth < 768,
  );
  const requestRef = useRef(0);

  const normalizedCurrentDir = !currentDir || currentDir === rootId ? "." : currentDir;

  // Reset the whole form each time the panel is opened.
  useEffect(() => {
    if (!open) return;
    setName("");
    setExtension(DEFAULT_EXTENSION);
    setContent("");
    setTargetDir(normalizedCurrentDir);
    setBrowseDir(normalizedCurrentDir);
    setManualPath("");
    setError("");
  }, [open, normalizedCurrentDir]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Escape closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  const loadSubDirs = useCallback(
    async (dir: string) => {
      if (!rootId) return;
      const id = ++requestRef.current;
      setBrowsing(true);
      try {
        const payload = await protectedJSON<{ entries?: FileEntry[] }>(
          appURL("/api/tree", new URLSearchParams({ root: rootId, dir })),
        );
        if (id !== requestRef.current) return;
        setSubDirs((payload.entries || []).filter((entry) => entry.is_dir));
      } catch {
        if (id === requestRef.current) setSubDirs([]);
      } finally {
        if (id === requestRef.current) setBrowsing(false);
      }
    },
    [rootId],
  );

  useEffect(() => {
    if (!open) return;
    void loadSubDirs(browseDir);
  }, [open, browseDir, loadSubDirs]);

  const recentDirs = useMemo(() => {
    if (!open || !rootId) return [];
    const base = (rootPath || "").replace(/[\\/]+$/, "");
    return listRecentDirs()
      .filter((item) => item.rootId === rootId)
      .map((item) => {
        const abs = item.path.replace(/\\/g, "/");
        let rel = abs;
        if (base && abs.startsWith(base)) {
          rel = abs.slice(base.length).replace(/^\/+/, "");
        }
        return { ...item, rel: rel || "." };
      })
      .filter((item) => !item.rel.startsWith(".."))
      .slice(0, 6);
  }, [open, rootId, rootPath]);

  const enterDir = (dir: string) => {
    setBrowseDir(dir);
    setTargetDir(dir);
  };

  const applyManualPath = () => {
    const cleaned = manualPath.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "");
    const next = cleaned || ".";
    setTargetDir(next);
    setBrowseDir(next);
  };

  const pasteClipboard = async () => {
    const text = await readClipboardText();
    if (text) {
      setContent((prev) => (prev ? `${prev}${prev.endsWith("\n") ? "" : "\n"}${text}` : text));
    }
  };

  const save = async () => {
    if (!rootId || saving) return;
    const finalName = composeFileName(name, extension);
    if (invalidName(finalName)) {
      setError(t("directory.invalidFileName"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const created = await protectedJSON<{ path?: string }>(
        appURL("/api/file", new URLSearchParams({ root: rootId })),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dir: targetDir, name: finalName }),
        },
      );
      const path = created?.path || joinDir(targetDir, finalName);
      if (content) {
        const file = await fetchEditableFile(rootId, path);
        await saveTextFile(rootId, path, content, file.revision);
      }
      onSaved(path, targetDir);
      onClose();
    } catch (err) {
      if (err instanceof ProtectedAPIError && err.status === 409) {
        setError(t("directory.fileExists"));
      } else if (err instanceof Error && (err.message === "file_edit_conflict" || err.message === "file_not_editable")) {
        setError(t("directory.createFileFailed"));
      } else {
        setError(String((err as Error)?.message || t("directory.createFileFailed")));
      }
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const dirLabel = targetDir === "." ? t("quickSave.projectRoot") : targetDir;

  const body = (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        background: "rgba(15, 23, 42, 0.36)",
        display: "flex",
        alignItems: isMobile ? "flex-end" : "center",
        justifyContent: "center",
        padding: isMobile ? 0 : "24px",
      }}
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t("quickSave.title")}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: isMobile ? "100%" : "min(560px, 100%)",
          maxHeight: isMobile ? "88dvh" : "86vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          borderRadius: isMobile ? "16px 16px 0 0" : "12px",
          border: "1px solid var(--border-color)",
          background: "var(--menu-bg)",
          boxShadow: "0 24px 60px rgba(15, 23, 42, 0.24)",
        }}
      >
        <header
          style={{
            padding: "10px 14px",
            borderBottom: "1px solid var(--border-color)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--text-color)" }}>
            {t("quickSave.title")}
          </div>
          <button type="button" onClick={onClose} aria-label={t("common.cancel")} style={iconButtonStyle}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <div style={{ padding: "12px 14px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
          <div style={fieldStyle}>
            <span style={labelStyle}>{t("quickSave.fileName")}</span>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("quickSave.fileNamePlaceholder")}
                style={{ ...inputStyle, flex: 1 }}
              />
              <input
                value={extension}
                onChange={(event) => setExtension(event.target.value)}
                aria-label={t("quickSave.extension")}
                placeholder={DEFAULT_EXTENSION}
                style={{ ...inputStyle, width: 76, textAlign: "center" }}
              />
            </div>
          </div>

          <div style={fieldStyle}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={labelStyle}>{t("quickSave.content")}</span>
              <button type="button" onClick={() => void pasteClipboard()} style={chipButtonStyle}>
                {t("quickSave.pasteClipboard")}
              </button>
            </div>
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder={t("quickSave.contentPlaceholder")}
              rows={5}
              style={{ ...inputStyle, height: "auto", padding: "8px", resize: "vertical", lineHeight: 1.5, fontFamily: "inherit" }}
            />
          </div>

          <div style={fieldStyle}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={labelStyle}>{t("quickSave.targetDir")}</span>
              <span style={{ fontSize: 11, color: "var(--accent-color)", fontWeight: 700, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {dirLabel}
              </span>
            </div>
            <div style={{ border: "1px solid var(--border-color)", borderRadius: 8, background: "var(--input-bg)", overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--border-color)" }}>
                <button
                  type="button"
                  disabled={browseDir === "."}
                  onClick={() => enterDir(parentDir(browseDir))}
                  style={{ ...chipButtonStyle, opacity: browseDir === "." ? 0.5 : 1 }}
                >
                  {t("quickSave.parent")}
                </button>
                <button
                  type="button"
                  onClick={() => enterDir(".")}
                  style={{ ...chipButtonStyle, opacity: browseDir === "." ? 0.6 : 1 }}
                >
                  {t("quickSave.projectRoot")}
                </button>
                <button
                  type="button"
                  onClick={() => enterDir(normalizedCurrentDir)}
                  style={chipButtonStyle}
                >
                  {t("quickSave.currentDir")}
                </button>
                <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {browseDir === "." ? t("quickSave.projectRoot") : browseDir}
                </span>
              </div>
              <div style={{ maxHeight: 132, overflowY: "auto" }}>
                {browsing ? (
                  <div style={emptyRowStyle}>{t("common.loading")}</div>
                ) : subDirs.length === 0 ? (
                  <div style={emptyRowStyle}>{t("quickSave.noSubdirs")}</div>
                ) : (
                  subDirs.map((entry) => {
                    const childDir = joinDir(browseDir, entry.name);
                    const active = targetDir === childDir;
                    return (
                      <button
                        key={entry.path || entry.name}
                        type="button"
                        onClick={() => enterDir(childDir)}
                        style={{
                          width: "100%",
                          border: "none",
                          borderBottom: "1px solid var(--border-color)",
                          background: active ? "var(--selection-bg)" : "transparent",
                          color: active ? "var(--accent-color)" : "var(--text-primary)",
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "7px 10px",
                          fontSize: 12,
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-secondary)" }}>
                          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                        </svg>
                        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
                        <span style={{ marginLeft: "auto", color: "var(--accent-color)", fontSize: 10, opacity: active ? 1 : 0 }}>✓</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                value={manualPath}
                onChange={(event) => setManualPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applyManualPath();
                  }
                }}
                placeholder={t("quickSave.manualPathPlaceholder")}
                style={{ ...inputStyle, flex: 1 }}
              />
              <button type="button" onClick={applyManualPath} style={chipButtonStyle}>
                {t("quickSave.applyPath")}
              </button>
            </div>
            {recentDirs.length ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <span style={{ ...labelStyle, alignSelf: "center" }}>{t("quickSave.recentDirs")}</span>
                {recentDirs.map((item) => (
                  <button key={`${item.rootId}:${item.rel}`} type="button" onClick={() => enterDir(item.rel)} style={chipButtonStyle}>
                    {item.rel === "." ? t("quickSave.projectRoot") : item.rel}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {error ? (
            <div role="alert" style={{ fontSize: 12, color: "#b91c1c", fontWeight: 700 }}>
              {error}
            </div>
          ) : null}
        </div>

        <footer
          style={{
            padding: "10px 14px",
            borderTop: "1px solid var(--border-color)",
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <button type="button" onClick={onClose} style={buttonStyle("secondary")}>
            {t("common.cancel")}
          </button>
          <button type="button" disabled={saving} onClick={() => void save()} style={{ ...buttonStyle("primary"), opacity: saving ? 0.6 : 1 }}>
            {saving ? t("quickSave.saving") : t("common.save")}
          </button>
        </footer>
      </section>
    </div>
  );

  return createPortal(body, document.body);
}

const fieldStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 5, minWidth: 0 };
const labelStyle: React.CSSProperties = { fontSize: 11, color: "var(--text-secondary)", fontWeight: 700 };
const inputStyle: React.CSSProperties = {
  height: 32,
  boxSizing: "border-box",
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--input-bg)",
  color: "var(--text-color)",
  padding: "0 8px",
  fontSize: 12,
  minWidth: 0,
  outline: "none",
};
const emptyRowStyle: React.CSSProperties = {
  padding: "10px 10px",
  fontSize: 12,
  color: "var(--text-secondary)",
  textAlign: "center",
};
const chipButtonStyle: React.CSSProperties = {
  height: 24,
  borderRadius: 6,
  border: "1px solid var(--border-color)",
  background: "var(--button-bg)",
  color: "var(--text-color)",
  padding: "0 8px",
  fontSize: 11,
  fontWeight: 700,
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
};
const iconButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 8,
  border: "none",
  background: "transparent",
  color: "var(--text-secondary)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  flexShrink: 0,
};

function buttonStyle(kind: "primary" | "secondary"): React.CSSProperties {
  return {
    height: 32,
    borderRadius: 6,
    border: kind === "primary" ? "1px solid var(--accent-color)" : "1px solid var(--border-color)",
    background: kind === "primary" ? "var(--accent-color)" : "var(--button-bg)",
    color: kind === "primary" ? "#fff" : "var(--text-color)",
    padding: "0 12px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}
