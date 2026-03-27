import React from "react";
import {
  DIRECTORY_SORT_OPTIONS,
  type DirectorySortMode,
  type FileEntry,
  sortDirectoryEntries,
} from "../services/directorySort";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const PWA_INSTALL_STATE_KEY = "mindfs-pwa-installed";

type FileMeta = {
  source_session?: string;
  session_name?: string;
};

type FileTreeProps = {
  entries: FileEntry[];
  childrenByPath: Record<string, FileEntry[]>;
  expanded: string[];
  sortMode: DirectorySortMode;
  showHiddenFiles?: boolean;
  selectedDirKey?: string | null;
  selectedPath?: string | null;
  rootId?: string | null;
  fileMetas?: Record<string, FileMeta>;
  activeSessionKey?: string | null;
  onSortModeChange?: (mode: DirectorySortMode) => void;
  onShowHiddenFilesChange?: (show: boolean) => void;
  onSelectFile?: (entry: FileEntry, rootId: string) => void;
  onToggleDir?: (entry: FileEntry, rootId: string) => void;
  creatingRootName?: string | null;
  creatingRootBusy?: boolean;
  onCreateRootStart?: () => void;
  onCreateRootNameChange?: (name: string) => void;
  onCreateRootSubmit?: () => void;
  onCreateRootCancel?: () => void;
};

const ChevronRight = ({ isOpen }: { isOpen: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{
      transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
      transition: "transform 0.15s cubic-bezier(0.4, 0, 0.2, 1)",
      color: isOpen ? "var(--text-primary)" : "#9ca3af",
    }}
  >
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

const getFileIcon = (filename: string) => {
  const ext = filename.split('.').pop()?.toLowerCase();
  
  // 核心文件类型使用极简 SVG
  if (['js', 'ts', 'jsx', 'tsx', 'go', 'py', 'java', 'c', 'cpp'].includes(ext!)) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.8 }}>
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
    );
  }
  if (['md', 'txt'].includes(ext!)) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
      </svg>
    );
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(ext!)) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
      </svg>
    );
  }
  
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>
    </svg>
  );
};

export function FileTree({
  entries,
  childrenByPath,
  expanded,
  sortMode,
  showHiddenFiles = false,
  selectedDirKey,
  selectedPath,
  rootId,
  fileMetas = {},
  activeSessionKey,
  onSortModeChange,
  onShowHiddenFilesChange,
  onSelectFile,
  onToggleDir,
  creatingRootName = null,
  creatingRootBusy = false,
  onCreateRootStart,
  onCreateRootNameChange,
  onCreateRootSubmit,
  onCreateRootCancel,
}: FileTreeProps) {
  const expandedSet = new Set(expanded);
  const [isMenuOpen, setIsMenuOpen] = React.useState(false);
  const [deferredInstallPrompt, setDeferredInstallPrompt] = React.useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = React.useState(false);
  const [isInstallCapable, setIsInstallCapable] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const createInputRef = React.useRef<HTMLInputElement | null>(null);
  const previousCreatingRootNameRef = React.useRef<string | null>(null);

  const isIOS = React.useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }
    const ua = window.navigator.userAgent;
    return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Mac") && "ontouchend" in document);
  }, []);

  const isMacSafari = React.useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }
    const ua = window.navigator.userAgent;
    const isMac = ua.includes("Macintosh");
    const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|CriOS|FxiOS/.test(ua);
    return isMac && isSafari;
  }, []);

  const isAndroidChrome = React.useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }
    const ua = window.navigator.userAgent;
    const isAndroid = /Android/i.test(ua);
    const isChrome = /Chrome|Chromium/i.test(ua);
    const isExcluded = /EdgA|OPR|SamsungBrowser|Firefox|QQBrowser|MQQBrowser|UCBrowser|HuaweiBrowser|MiuiBrowser|VivoBrowser|HeyTapBrowser/i.test(ua);
    return isAndroid && isChrome && !isExcluded;
  }, []);

  const isStandaloneDisplay = React.useCallback(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.matchMedia("(display-mode: standalone)").matches
      || window.matchMedia("(display-mode: fullscreen)").matches
      || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  }, []);

  const hasPersistedInstallState = React.useCallback(() => {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      return window.localStorage.getItem(PWA_INSTALL_STATE_KEY) === "true";
    } catch {
      return false;
    }
  }, []);

  const persistInstallState = React.useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(PWA_INSTALL_STATE_KEY, "true");
    } catch {
    }
  }, []);

  React.useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const updateInstallState = () => {
      const installed = isStandaloneDisplay() || hasPersistedInstallState();
      setIsInstalled(installed);
      setIsInstallCapable(installed || isIOS || "serviceWorker" in navigator);
    };

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredInstallPrompt(event as BeforeInstallPromptEvent);
      setIsInstallCapable(true);
    };

    const handleInstalled = () => {
      persistInstallState();
      setIsInstalled(true);
      setDeferredInstallPrompt(null);
    };

    updateInstallState();
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, [hasPersistedInstallState, isIOS, isStandaloneDisplay, persistInstallState]);

  const installLabel = isInstalled
    ? "已安装"
    : isIOS
      ? "添加到主屏幕"
      : isMacSafari
        ? "添加到 Dock"
      : isAndroidChrome && !deferredInstallPrompt
        ? "从菜单安装"
      : deferredInstallPrompt
        ? "安装应用"
        : "安装说明";

  const installHelp = isInstalled
    ? "当前已作为应用打开"
    : isIOS
      ? "在 Safari 中用分享菜单安装"
      : isMacSafari
        ? "请用 Safari 菜单 File > Add to Dock"
      : isAndroidChrome && !deferredInstallPrompt
        ? "请在浏览器菜单中选择“添加到主屏幕”或“安装应用”"
      : deferredInstallPrompt
        ? "安装后可从桌面独立启动"
        : "当前浏览器未提供安装弹窗";

  const shouldShowInstallButton = !isInstalled && !(isAndroidChrome && !deferredInstallPrompt);
  const shouldShowInstallHelp = isInstalled || isIOS || isMacSafari || deferredInstallPrompt !== null || (isAndroidChrome && !deferredInstallPrompt);

  const handleInstall = React.useCallback(async () => {
    if (isInstalled) {
      return;
    }
    if (deferredInstallPrompt) {
      await deferredInstallPrompt.prompt();
      try {
        const choice = await deferredInstallPrompt.userChoice;
        if (choice.outcome === "accepted") {
          persistInstallState();
          setIsInstalled(true);
        }
      } finally {
        setDeferredInstallPrompt(null);
      }
      return;
    }
    if (isIOS && typeof window !== "undefined") {
      window.alert("请在 Safari 中点击“分享”按钮，然后选择“添加到主屏幕”。");
      return;
    }
    if (isMacSafari && typeof window !== "undefined") {
      window.alert("请在 Safari 菜单中选择 File > Add to Dock。该浏览器不会从网页按钮直接弹出安装窗口。");
      return;
    }
    if (isAndroidChrome && typeof window !== "undefined") {
      window.alert("请在 Chrome 菜单中选择“添加到主屏幕”或“安装应用”。某些移动端场景下，Chrome 不会把安装弹窗权限直接暴露给网页按钮。");
      return;
    }
    if (typeof window !== "undefined") {
      window.alert("当前浏览器没有提供 PWA 安装弹窗。请改用 Safari、Chrome 或 Edge 打开。");
    }
  }, [deferredInstallPrompt, isAndroidChrome, isIOS, isInstalled, isMacSafari, persistInstallState]);

  React.useEffect(() => {
    if (!creatingRootName) {
      previousCreatingRootNameRef.current = creatingRootName;
      return;
    }
    const enteredCreateMode = previousCreatingRootNameRef.current === null;
    createInputRef.current?.focus();
    if (enteredCreateMode) {
      createInputRef.current?.select();
    }
    previousCreatingRootNameRef.current = creatingRootName;
  }, [creatingRootName]);

  React.useEffect(() => {
    if (!isMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isMenuOpen]);

  const childKeyFor = (entry: FileEntry, entryRoot: string) => {
    if (entry.is_root) return `${entry.path}:.`;
    return `${entryRoot}:${entry.path}`;
  };

  const visibleEntries = React.useCallback((items: FileEntry[]) => {
    if (showHiddenFiles) {
      return items;
    }
    return items.filter((entry) => !entry.name.startsWith("."));
  }, [showHiddenFiles]);

  const renderEntries = (items: FileEntry[], depth: number, branchRoot: string) => (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {depth === 0 && creatingRootName !== null ? (
        <li key="__draft_root__">
          <div
            style={{
              padding: "6px 8px",
              paddingLeft: 8,
              display: "flex",
              alignItems: "center",
              gap: "8px",
              width: "100%",
              color: "var(--accent-color)",
              fontSize: "13px",
              borderRadius: "6px",
              background: "var(--selection-bg)",
              boxSizing: "border-box",
            }}
          >
            <div style={{ width: 20, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <ChevronRight isOpen={false} />
            </div>
            <input
              ref={createInputRef}
              value={creatingRootName}
              disabled={creatingRootBusy}
              onChange={(event) => onCreateRootNameChange?.(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onCreateRootSubmit?.();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  onCreateRootCancel?.();
                }
              }}
              onBlur={() => {
                if (!creatingRootBusy) {
                  onCreateRootSubmit?.();
                }
              }}
              style={{
                flex: 1,
                minWidth: 0,
                border: "none",
                background: "transparent",
                color: "var(--text-primary)",
                fontSize: "13px",
                fontWeight: 600,
                outline: "none",
                padding: 0,
              }}
            />
          </div>
        </li>
      ) : null}
      {sortDirectoryEntries(visibleEntries(items), sortMode).map((entry) => {
        const isManagedRootNode = entry.is_root === true;
        const entryRoot = isManagedRootNode ? entry.path : branchRoot;
        const expandedKey = isManagedRootNode ? entry.path : `${entryRoot}:${entry.path}`;
        const isOpen = expandedSet.has(expandedKey);

        const cKey = childKeyFor(entry, entryRoot);
        const children = childrenByPath[cKey] ?? [];
        
        // 关键修复：增加 rootId 匹配校验，防止不同 root 下同名目录同时高亮
        const isSelected =
          entry.is_dir
            ? selectedDirKey === expandedKey
            : entry.path === selectedPath && entryRoot === rootId;

        const meta = fileMetas[entry.path];
        const hasSessionLink = !entry.is_dir && meta?.source_session;
        const isFromActiveSession = hasSessionLink && meta.source_session === activeSessionKey;

        return (
          <li key={expandedKey}>
            <button
              type="button"
              onClick={() => entry.is_dir ? onToggleDir?.(entry, entryRoot) : onSelectFile?.(entry, entryRoot)}
              style={{
                border: "none",
                background: isSelected ? "var(--selection-bg)" : "transparent",
                cursor: "pointer",
                padding: "6px 8px",
                paddingLeft: 8 + depth * 16,
                display: "flex",
                alignItems: "center",
                gap: "4px",
                width: "100%",
                textAlign: "left",
                color: isSelected ? "var(--accent-color)" : "var(--text-primary)",
                fontSize: "13px",
                borderRadius: "6px",
                transition: "all 0.1s",
                fontWeight: isSelected ? 600 : 400,
                outline: "none",
              }}
              onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "rgba(0,0,0,0.04)"; }}
              onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
            >
              <div style={{ width: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                 {entry.is_dir ? <ChevronRight isOpen={isOpen} /> : getFileIcon(entry.name)}
              </div>
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, marginLeft: "4px" }}>
                {entry.name}
              </span>
              {hasSessionLink && (
                <span style={{ fontSize: "10px", color: isFromActiveSession ? "#3b82f6" : "#9ca3af" }}>
                  {isFromActiveSession ? "◆" : "◇"}
                </span>
              )}
            </button>
            {entry.is_dir && isOpen && children.length > 0 ? renderEntries(children, depth + 1, entryRoot) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ height: "36px", padding: "0 3px 0 16px", borderBottom: "1px solid var(--border-color)", display: "flex", justifyContent: "space-between", alignItems: "center", boxSizing: "border-box", flexShrink: 0, gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: "11px", fontWeight: 600, color: "var(--text-secondary)", letterSpacing: "0.5px", textTransform: "uppercase" }}>Project</h3>
        <div ref={menuRef} style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => setIsMenuOpen((open) => !open)}
            aria-label="打开文件树菜单"
            style={{
              width: "28px",
              height: "28px",
              borderRadius: "8px",
              border: "none",
              background: isMenuOpen ? "rgba(0, 0, 0, 0.06)" : "transparent",
              color: "var(--text-secondary)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              outline: "none",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="12" cy="5" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="12" cy="19" r="1.8" />
            </svg>
          </button>
          {isMenuOpen ? (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                right: 0,
                minWidth: "164px",
                padding: "6px",
                borderRadius: "10px",
                border: "1px solid var(--border-color)",
                background: "var(--menu-bg)",
                boxShadow: "0 12px 30px rgba(15, 23, 42, 0.14)",
                zIndex: 20,
              }}
            >
                <div style={{ padding: "4px 8px", fontSize: "11px", color: "var(--text-secondary)" }}>全局排序</div>
                <button
                  type="button"
                  onClick={() => {
                    onCreateRootStart?.();
                    setIsMenuOpen(false);
                  }}
                  style={{
                    width: "100%",
                    border: "none",
                    background: "transparent",
                    color: "var(--text-primary)",
                    borderRadius: "8px",
                    padding: "8px 10px",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    textAlign: "left",
                    cursor: "pointer",
                    fontSize: "12px",
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                  <span>新建项目</span>
                </button>
                <div style={{ height: "1px", background: "var(--border-color)", margin: "6px 4px" }} />
                {DIRECTORY_SORT_OPTIONS.map((option) => {
                const active = option.value === sortMode;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      onSortModeChange?.(option.value as DirectorySortMode);
                      setIsMenuOpen(false);
                    }}
                    style={{
                      width: "100%",
                      border: "none",
                      background: active ? "var(--selection-bg)" : "transparent",
                      color: active ? "var(--accent-color)" : "var(--text-primary)",
                      borderRadius: "8px",
                      padding: "8px 10px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      textAlign: "left",
                      cursor: "pointer",
                      fontSize: "12px",
                    }}
                  >
                    <span>{option.label}</span>
                    <span style={{ fontSize: "11px", opacity: active ? 1 : 0 }}>✓</span>
                  </button>
                );
              })}
              <div style={{ height: "1px", background: "var(--border-color)", margin: "6px 4px" }} />
              <button
                type="button"
                onClick={() => onShowHiddenFilesChange?.(!showHiddenFiles)}
                style={{
                  width: "100%",
                  border: "none",
                  background: showHiddenFiles ? "var(--selection-bg)" : "transparent",
                  color: showHiddenFiles ? "var(--accent-color)" : "var(--text-primary)",
                  borderRadius: "8px",
                  padding: "8px 10px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  textAlign: "left",
                  cursor: "pointer",
                  fontSize: "12px",
                }}
              >
                <span>显示隐藏文件</span>
                <span style={{ fontSize: "11px", opacity: showHiddenFiles ? 1 : 0 }}>✓</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div style={{ padding: "8px", flex: 1, minHeight: 0, overflow: "auto" }}>
        {renderEntries(entries, 0, rootId || "")}
      </div>
      <div
        style={{
          padding: "10px 12px 12px",
          borderTop: "1px solid var(--border-color)",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          flexShrink: 0,
        }}
      >
        {shouldShowInstallButton ? (
          <button
            type="button"
            onClick={() => { void handleInstall(); }}
            style={{
              width: "100%",
              border: "1px solid var(--border-color)",
              background: "var(--text-primary)",
              color: "var(--sidebar-bg)",
              borderRadius: "10px",
              padding: "10px 12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
              cursor: "pointer",
              fontSize: "12px",
              fontWeight: 600,
              transition: "all 0.15s ease",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 16V4" />
              <path d="m7 9 5-5 5 5" />
              <path d="M20 16.5v1.5A2 2 0 0 1 18 20H6a2 2 0 0 1-2-2v-1.5" />
            </svg>
            <span>{installLabel}</span>
          </button>
        ) : null}
        {shouldShowInstallHelp ? (
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", lineHeight: 1.5, textAlign: "center" }}>
            {installHelp}
          </div>
        ) : null}
      </div>
    </div>
  );
}
