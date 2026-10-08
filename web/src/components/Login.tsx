import React, { useEffect, useState, type ReactElement } from "react";
import {
  getStoredLauncherNodes,
  setStoredLauncherNodes,
  type LauncherNode,
} from "../services/storage";
import {
  consumePendingRelayNodes,
  getNativeLauncherNodes,
  setNativeLauncherNodes,
} from "../services/launcherNodeSync";
import {
  appPackageLabel,
  fetchAppUpdateState,
  isUpdatableNativeRuntime,
  normalizeAppUpdateState,
  type AppUpdateState,
} from "../services/appUpdate";
import { downloadURL } from "../services/download";
import { useI18n, type MessageKey, type MessageParams } from "../i18n";

type LoginProps = {
  onOpenNode: (nodeURL: string) => void;
  repository?: {
    load: () => Promise<LauncherNode[]>;
    save: (nodes: LauncherNode[]) => Promise<LauncherNode[]>;
  };
};

const RELAY_URL = "https://relay.a9gent.com/nodes";
const LAUNCHER_BG =
  "radial-gradient(circle at top left, rgba(91, 125, 184, 0.07), transparent 22%), radial-gradient(circle at right 18%, rgba(148, 163, 184, 0.18), transparent 24%), linear-gradient(180deg, #f8fafc 0%, #edf2f7 100%)";
const SURFACE = "var(--mindfs-launcher-surface)";
const SURFACE_STRONG = "var(--mindfs-launcher-surface-strong)";
const BORDER = "var(--mindfs-launcher-border)";
const BORDER_STRONG = "var(--mindfs-launcher-border-strong)";
const TEXT = "var(--mindfs-launcher-text)";
const MUTED = "var(--mindfs-launcher-muted)";
const ACCENT = "var(--mindfs-launcher-accent)";
const SHADOW = "var(--mindfs-launcher-shadow)";

function normalizeNodeURL(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      return "";
    }
    parsed.hash = "";
    const relayNodePath = /^\/n\/[^/]+\/?$/.test(parsed.pathname);
    const normalized = parsed.toString().replace(/\/+$/, "");
    return relayNodePath ? `${normalized}/` : normalized;
  } catch {
    return "";
  }
}

function sortNodes(nodes: LauncherNode[]): LauncherNode[] {
  return [...nodes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function buildNodeID(): string {
  return `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeLauncherNodes(nodes: LauncherNode[]): LauncherNode[] {
  return nodes
    .map((item) => {
      const id = String(item?.id || "").trim();
      const name = String(item?.name || "").trim();
      const url = normalizeNodeURL(String(item?.url || ""));
      const createdAt = String(item?.createdAt || "").trim();
      const lastOpenedAt = String(item?.lastOpenedAt || "").trim();
      if (!id || !name || !url || !createdAt) {
        return null;
      }
      return {
        id,
        name,
        url,
        createdAt,
        ...(lastOpenedAt ? { lastOpenedAt } : {}),
      };
    })
    .filter((item): item is LauncherNode => item !== null);
}

function mergeLauncherNodes(...groups: LauncherNode[][]): LauncherNode[] {
  const seenURLs = new Set<string>();
  const merged: LauncherNode[] = [];
  for (const group of groups) {
    for (const node of normalizeLauncherNodes(group)) {
      if (seenURLs.has(node.url)) {
        continue;
      }
      seenURLs.add(node.url);
      merged.push(node);
    }
  }
  return sortNodes(merged);
}

function shouldShowAppUpdate(state: AppUpdateState): boolean {
  const status = (state.status || "idle").toLowerCase();
  return (
    state.has_update === true ||
    status === "downloading" ||
    status === "downloaded" ||
    status === "failed"
  );
}

function appUpdateSummary(state: AppUpdateState, t: (key: MessageKey, params?: MessageParams) => string): string {
  const notes = String(state.notes || "").trim();
  if (notes) {
    return notes;
  }
  if (state.latest_version) {
    return t("login.updateAvailable", {
      packageLabel: appPackageLabel(state.platform),
      version: state.latest_version,
    });
  }
  return "";
}

export function Login({ onOpenNode, repository }: LoginProps): ReactElement {
  const { t } = useI18n();
  const [nodes, setNodes] = useState<LauncherNode[]>(() => repository ? [] : sortNodes(getStoredLauncherNodes()));
  const [busy, setBusy] = useState(!!repository);
  const [loaded, setLoaded] = useState(!repository);
  const [storageError, setStorageError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (!repository) return;
    let cancelled = false;
    setBusy(true);
    setStorageError("");
    void repository.load().then((items) => {
      if (!cancelled) { setNodes(sortNodes(items)); setLoaded(true); }
    }).catch((error) => {
      if (!cancelled) setStorageError(String(error instanceof Error ? error.message : error));
    }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [repository, loadAttempt]);
  const [composerOpen, setComposerOpen] = useState(false);
  const [nodeName, setNodeName] = useState("");
  const [nodeURL, setNodeURL] = useState("");
  const [formError, setFormError] = useState("");
  const [editingNodeID, setEditingNodeID] = useState("");
  const [editingNodeName, setEditingNodeName] = useState("");
  const [appUpdateState, setAppUpdateState] =
    useState<AppUpdateState>(() => normalizeAppUpdateState(null));
  const [appUpdateNotesOpen, setAppUpdateNotesOpen] = useState(false);
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);

  async function persistNodes(nextNodes: LauncherNode[]): Promise<boolean> {
    if (busy || !loaded) return false;
    const sorted = sortNodes(nextNodes);
    if (repository) {
      setBusy(true);
      setStorageError("");
      try {
        setNodes(sortNodes(await repository.save(sorted)));
        return true;
      } catch (error) {
        setStorageError(String(error instanceof Error ? error.message : error));
        return false;
      } finally { setBusy(false); }
    }
    setNodes(sorted);
    setStoredLauncherNodes(sorted);
    void setNativeLauncherNodes(sorted);
    return true;
  }

  function openNode(node: LauncherNode): void {
    onOpenNode(node.url);
  }

  function handleDeleteNode(nodeID: string): void {
    if (editingNodeID === nodeID) {
      setEditingNodeID("");
      setEditingNodeName("");
    }
    persistNodes(nodes.filter((item) => item.id !== nodeID));
  }

  function handleStartRename(node: LauncherNode): void {
    setEditingNodeID(node.id);
    setEditingNodeName(node.name);
  }

  function handleCancelRename(): void {
    setEditingNodeID("");
    setEditingNodeName("");
  }

  function handleCommitRename(node: LauncherNode): void {
    const trimmedName = editingNodeName.trim();
    if (!trimmedName) {
      setEditingNodeName(node.name);
      setEditingNodeID("");
      return;
    }
    if (trimmedName === node.name) {
      setEditingNodeID("");
      setEditingNodeName("");
      return;
    }
    persistNodes(
      nodes.map((item) =>
        item.id === node.id ? { ...item, name: trimmedName } : item
      )
    );
    setEditingNodeID("");
    setEditingNodeName("");
  }

  async function handleSaveNode(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmedName = nodeName.trim();
    const normalizedURL = normalizeNodeURL(nodeURL);
    if (!trimmedName) {
      setFormError("Node name is required.");
      return;
    }
    if (!normalizedURL) {
      setFormError("Enter a valid http:// or https:// node URL.");
      return;
    }
    if (nodes.some((item) => item.url === normalizedURL)) {
      setFormError("This node URL already exists.");
      return;
    }
    const createdAt = new Date().toISOString();
    const nextNode: LauncherNode = {
      id: buildNodeID(),
      name: trimmedName,
      url: normalizedURL,
      createdAt,
    };
    if (!await persistNodes([nextNode, ...nodes])) return;
    setNodeName("");
    setNodeURL("");
    setFormError("");
    setComposerOpen(false);
  }

  async function handleDownloadAppUpdate(): Promise<void> {
    const next = normalizeAppUpdateState(appUpdateState);
    const packageLabel = appPackageLabel(next.platform);
    if (!next.download_url || appUpdateBusy) {
      return;
    }
    setAppUpdateBusy(true);
    setAppUpdateState((prev) =>
      normalizeAppUpdateState({
        ...prev,
        status: "downloading",
        message: t("login.downloadingPackage", { packageLabel }),
      }),
    );
    try {
      await downloadURL(next.download_url, next.filename || "");
      setAppUpdateState((prev) =>
        normalizeAppUpdateState({
          ...prev,
          status: "downloaded",
          message: t("login.packageDownloadStarted"),
        }),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : t("login.packageDownloadFailed", { packageLabel });
      setAppUpdateState((prev) =>
        normalizeAppUpdateState({
          ...prev,
          status: "failed",
          message,
        }),
      );
    } finally {
      setAppUpdateBusy(false);
    }
  }

  useEffect(() => {
    if (repository) return;
    let cancelled = false;
    const timers: number[] = [];

    const syncLauncherNodes = async (): Promise<void> => {
      const [nativeNodes, pendingNodes] = await Promise.all([
        getNativeLauncherNodes(),
        consumePendingRelayNodes(),
      ]);
      if (cancelled) {
        return;
      }

      const existingNodes = getStoredLauncherNodes();
      const restoredNodes = mergeLauncherNodes(existingNodes, nativeNodes);
      const existingURLSet = new Set(
        restoredNodes.map((item) => normalizeNodeURL(item.url)).filter(Boolean),
      );
      const createdAt = new Date().toISOString();
      const importedNodes: LauncherNode[] = [];

      for (const item of pendingNodes) {
        const name = String(item?.name || "").trim();
        const url = normalizeNodeURL(String(item?.url || ""));
        if (!name || !url || existingURLSet.has(url)) {
          continue;
        }
        existingURLSet.add(url);
        importedNodes.push({
          id: buildNodeID(),
          name,
          url,
          createdAt,
        });
      }

      const nextNodes = mergeLauncherNodes(importedNodes, restoredNodes);
      if (nextNodes.length === existingNodes.length && importedNodes.length === 0) {
        return;
      }

      setStoredLauncherNodes(nextNodes);
      void setNativeLauncherNodes(nextNodes);
      if (!cancelled) {
        setNodes(nextNodes);
      }
    };

    const handleLauncherNodesUpdated = (): void => {
      void syncLauncherNodes();
    };

    void syncLauncherNodes();
    timers.push(window.setTimeout(() => void syncLauncherNodes(), 1200));
    timers.push(window.setTimeout(() => void syncLauncherNodes(), 3200));
    window.addEventListener("mindfs:launcher-nodes-updated", handleLauncherNodesUpdated);

    return () => {
      cancelled = true;
      window.removeEventListener("mindfs:launcher-nodes-updated", handleLauncherNodesUpdated);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [repository]);

  useEffect(() => {
    if (!isUpdatableNativeRuntime() || nodes.length === 0) {
      setAppUpdateState(normalizeAppUpdateState(null));
      return;
    }

    let cancelled = false;
    void fetchAppUpdateState()
      .then((state) => {
        if (!cancelled) {
          setAppUpdateState(state);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("[app-update] launcher check failed", error);
          setAppUpdateState(normalizeAppUpdateState(null));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nodes.length]);

  const showAppUpdate = shouldShowAppUpdate(appUpdateState);
  const appUpdateStatus = (appUpdateState.status || "idle").toLowerCase();
  const appUpdateDisabled =
    appUpdateBusy ||
    appUpdateStatus === "downloading" ||
    appUpdateStatus === "downloaded";
  const appUpdateText =
    appUpdateStatus === "downloading"
      ? t("login.updateDownloading")
      : appUpdateStatus === "downloaded"
        ? t("login.updateDownloaded")
        : t("login.updateApp");
  const appUpdateHelp =
    appUpdateState.message ||
    (appUpdateState.latest_version
      ? t("login.updateVersionHelp", {
          current: appUpdateState.current_version || t("login.unknownVersion"),
          latest: appUpdateState.latest_version,
        })
      : "");
  const appUpdateNotes = appUpdateSummary(appUpdateState, t);

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "var(--mindfs-system-bar-bg)",
        color: TEXT,
        padding:
          "calc(var(--mindfs-safe-area-top, env(safe-area-inset-top, 0px)) + 20px) 16px calc(var(--mindfs-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + 24px)",
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: `var(--mindfs-launcher-bg, ${LAUNCHER_BG})`,
          pointerEvents: "none",
          zIndex: 0,
        }}
      />
      <fieldset
        disabled={busy || !loaded}
        aria-busy={busy}
        style={{
          position: "relative",
          border: 0,
          padding: 0,
          margin: 0,
          minWidth: 0,
          zIndex: 1,
          width: "100%",
          maxWidth: "640px",
          minHeight:
            "calc(100dvh - var(--mindfs-safe-area-top, env(safe-area-inset-top, 0px)) - var(--mindfs-safe-area-bottom, env(safe-area-inset-bottom, 0px)) - 44px)",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        {busy ? <div role="status">{t("common.loading")}</div> : null}
        {storageError ? <div role="alert" style={{ color: "var(--mindfs-launcher-error-text)" }}>
          {storageError}
        </div> : null}
        {!loaded && !busy ? <a href="#" onClick={(event) => { event.preventDefault(); setLoadAttempt((value) => value + 1); }}>{t("nodes.retry")}</a> : null}
        {repository && loaded && nodes.length === 0 ? <p>{t("nodes.empty")}</p> : null}
        {!repository ? (
        <button
          type="button"
          onClick={() => onOpenNode(RELAY_URL)}
          style={{
            width: "100%",
            textAlign: "left",
            border: `1px solid ${BORDER}`,
            borderRadius: "20px",
            background: SURFACE_STRONG,
            padding: "18px",
            fontSize: "18px",
            fontWeight: 500,
            color: TEXT,
            cursor: "pointer",
            boxShadow: SHADOW,
            backdropFilter: "blur(20px)",
          }}
        >
          <div style={{ minWidth: 0, display: "grid", gap: "4px" }}>
            <div
              style={{
                fontSize: "18px",
                fontWeight: 500,
                color: TEXT,
                lineHeight: 1.2,
              }}
            >
              mindfs relayer
            </div>
            <div
              style={{
                fontSize: "12px",
                lineHeight: 1.5,
                color: MUTED,
                wordBreak: "break-word",
              }}
            >
              {RELAY_URL}
            </div>
          </div>
        </button>
        ) : null}

        {nodes.map((node) => (
          <div
            key={node.id}
            style={{
              width: "100%",
              borderRadius: "20px",
              border: `1px solid ${BORDER}`,
              background: SURFACE,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "16px",
              boxShadow: SHADOW,
              backdropFilter: "blur(20px)",
            }}
          >
            <div
              role={editingNodeID === node.id ? undefined : "link"}
              tabIndex={editingNodeID === node.id ? undefined : 0}
              onKeyDown={(event) => {
                if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ") && !busy) {
                  event.preventDefault(); openNode(node);
                }
              }}
              onClick={() => {
                if (!busy && editingNodeID !== node.id) {
                  openNode(node);
                }
              }}
              style={{
                flex: 1,
                minWidth: 0,
                textAlign: "left",
                padding: "16px 0 16px 18px",
                cursor: editingNodeID === node.id ? "default" : "pointer",
              }}
            >
              <div style={{ minWidth: 0, display: "grid", gap: "4px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    minWidth: 0,
                  }}
                >
                  {editingNodeID === node.id ? (
                    <input
                      type="text"
                      value={editingNodeName}
                      autoFocus
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setEditingNodeName(event.target.value)}
                      onBlur={() => handleCommitRename(node)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          handleCommitRename(node);
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          handleCancelRename();
                        }
                      }}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        borderRadius: "10px",
                        border: `1px solid ${BORDER_STRONG}`,
                        background: "var(--mindfs-launcher-input-bg)",
                        padding: "6px 10px",
                        fontSize: "17px",
                        fontWeight: 500,
                        color: TEXT,
                        lineHeight: 1.2,
                        outline: "none",
                      }}
                    />
                  ) : (
                    <>
                      <div
                        style={{
                          fontSize: "17px",
                          fontWeight: 500,
                          color: TEXT,
                          lineHeight: 1.2,
                          wordBreak: "break-word",
                        }}
                      >
                        {node.name}
                      </div>
                      <button
                        type="button"
                        aria-label={t("login.renameNode", { name: node.name })}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleStartRename(node);
                        }}
                        style={{
                          border: "none",
                          background: "transparent",
                          color: MUTED,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: "22px",
                          height: "22px",
                          padding: 0,
                          cursor: "pointer",
                          flex: "0 0 auto",
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
                <div
                  style={{
                    fontSize: "12px",
                    lineHeight: 1.5,
                    color: MUTED,
                    wordBreak: "break-word",
                  }}
                >
                  {node.url}
                </div>
              </div>
            </div>
            <button
              type="button"
              aria-label={t("login.deleteNode", { name: node.name })}
              onClick={(event) => {
                event.stopPropagation();
                handleDeleteNode(node.id);
              }}
              style={{
                border: "none",
                background: "transparent",
                color: ACCENT,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "48px",
                height: "100%",
                minHeight: "72px",
                padding: "0 14px 0 0",
                cursor: "pointer",
                flex: "0 0 auto",
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6h18" />
                <path d="M8 6V4h8v2" />
                <path d="M19 6l-1 14H6L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
              </svg>
            </button>
          </div>
        ))}

        {showAppUpdate ? (
          <div
            style={{
              border: `1px solid ${BORDER}`,
              borderRadius: "20px",
              background: SURFACE_STRONG,
              padding: "14px",
              boxShadow: SHADOW,
              backdropFilter: "blur(20px)",
              display: "grid",
              gap: "10px",
              marginTop: "auto",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
              }}
            >
              <div style={{ minWidth: 0, display: "grid", gap: "3px" }}>
                <div
                  style={{
                    fontSize: "15px",
                    fontWeight: 600,
                    color: TEXT,
                    lineHeight: 1.25,
                  }}
                >
                  {t("update.newVersion")}
                </div>
                {appUpdateHelp ? (
                  <div
                    style={{
                      fontSize: "12px",
                      color: MUTED,
                      lineHeight: 1.45,
                      wordBreak: "break-word",
                    }}
                  >
                    {appUpdateHelp}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                disabled={appUpdateDisabled}
                onClick={() => {
                  void handleDownloadAppUpdate();
                }}
                style={{
                  border: "none",
                  borderRadius: "14px",
                  background: appUpdateDisabled ? "rgba(148, 163, 184, 0.35)" : ACCENT,
                  color: appUpdateDisabled ? MUTED : "#fff8f2",
                  padding: "10px 14px",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: appUpdateDisabled ? "not-allowed" : "pointer",
                  flexShrink: 0,
                  minWidth: "86px",
                }}
              >
                {appUpdateText}
              </button>
            </div>
            {appUpdateNotes ? (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    flexWrap: "wrap",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setAppUpdateNotesOpen((open) => !open)}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: ACCENT,
                      padding: 0,
                      justifySelf: "start",
                      fontSize: "12px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {appUpdateNotesOpen ? t("login.hideUpdateNotes") : t("login.showUpdateNotes")}
                  </button>
                  <span
                    style={{
                      color: "#dc2626",
                      fontSize: "12px",
                      fontWeight: 700,
                      lineHeight: 1.35,
                    }}
                  >
                    {t("login.backendUpgradeRequired")}
                  </span>
                </div>
                {appUpdateNotesOpen ? (
                  <div
                    style={{
                      borderTop: `1px solid ${BORDER}`,
                      paddingTop: "10px",
                      color: MUTED,
                      fontSize: "12px",
                      lineHeight: 1.55,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      maxHeight: "180px",
                      overflow: "auto",
                    }}
                  >
                    {appUpdateNotes}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => {
            setComposerOpen(true);
            setFormError("");
          }}
          style={{
            width: "100%",
            textAlign: "center",
            border: `1px dashed ${BORDER_STRONG}`,
            borderRadius: "20px",
            background: "var(--mindfs-launcher-surface-soft)",
            padding: "18px",
            fontSize: "24px",
            fontWeight: 500,
            color: MUTED,
            cursor: "pointer",
            boxShadow: SHADOW,
            backdropFilter: "blur(20px)",
            marginTop: showAppUpdate ? 0 : "auto",
          }}
        >
          +
        </button>
      </fieldset>

      {composerOpen ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(17, 24, 39, 0.18)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
            zIndex: 40,
          }}
        >
          <form
            onSubmit={handleSaveNode}
            style={{
              width: "100%",
              maxWidth: "420px",
              borderRadius: "22px",
              background: SURFACE_STRONG,
              border: `1px solid var(--mindfs-launcher-modal-border)`,
              boxShadow: SHADOW,
              padding: "18px",
              backdropFilter: "blur(20px)",
              display: "grid",
              gap: "12px",
            }}
          >
            {formError ? <div role="alert" style={{ color: "var(--mindfs-launcher-error-text)" }}>{formError}</div> : null}
            <input
              type="text"
              value={nodeName}
              onChange={(event) => setNodeName(event.target.value)}
              placeholder={t("login.nodeNamePlaceholder")}
              autoFocus
              style={{
                width: "100%",
                borderRadius: "14px",
                border: `1px solid ${formError ? "var(--mindfs-launcher-error-text)" : BORDER_STRONG}`,
                background: "var(--mindfs-launcher-input-bg)",
                padding: "14px 15px",
                fontSize: "15px",
                color: TEXT,
                outline: "none",
                boxSizing: "border-box",
              }}
            />
            {storageError ? <div role="alert" style={{ color: "var(--mindfs-launcher-error-text)" }}>{storageError}</div> : null}

            <input
              type="text"
              value={nodeURL}
              onChange={(event) => setNodeURL(event.target.value)}
              placeholder={t("login.nodeUrlPlaceholder")}
              spellCheck={false}
              style={{
                width: "100%",
                borderRadius: "14px",
                border: `1px solid ${formError ? "var(--mindfs-launcher-error-text)" : BORDER_STRONG}`,
                background: "var(--mindfs-launcher-input-bg)",
                padding: "14px 15px",
                fontSize: "15px",
                color: TEXT,
                outline: "none",
                boxSizing: "border-box",
              }}
            />

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "10px",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setComposerOpen(false);
                  setFormError("");
                }}
                style={{
                  border: `1px solid ${BORDER_STRONG}`,
                  borderRadius: "14px",
                  padding: "12px 16px",
                  background: "transparent",
                  color: MUTED,
                  fontSize: "14px",
                  fontWeight: 500,
                  cursor: "pointer",
                  width: "100%",
                }}
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                disabled={busy || !loaded}
                style={{
                  border: "none",
                  borderRadius: "14px",
                  padding: "12px 16px",
                  background: ACCENT,
                  color: "#fff8f2",
                  fontSize: "14px",
                  fontWeight: 500,
                  cursor: "pointer",
                  width: "100%",
                }}
              >
                {t("common.save")}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
