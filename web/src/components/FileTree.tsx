import React from "react";
import { rootBadgeStyle } from "./rootBadgeStyle";
import { openExternalURL } from "../services/platformNavigation";
import { isNativeShellRuntime, shouldEnablePWAInstall } from "../services/runtime";
import {
  DIRECTORY_SORT_OPTIONS,
  type DirectorySortMode,
  type FileEntry,
  sortDirectoryEntries,
} from "../services/directorySort";
import { appPath } from "../services/base";
import { protectedJSON } from "../services/api";
import { bootstrapService } from "../services/bootstrap";
import {
  APPEARANCE_CHANGE_EVENT,
  getAppearanceMode,
  setAppearanceMode,
  type AppearanceMode,
} from "../services/appearance";
import { useI18n, type Locale, type MessageKey } from "../i18n";
import { AgentMenuList } from "./AgentMenuList";
import { AgentIcon } from "./AgentIcon";
import { SymlinkBadge } from "./SymlinkBadge";
import { RelayLocalServicesDialog } from "./RelayLocalServicesDialog";
import { fetchAgentCatalog, fetchAgents, type AgentStatus } from "../services/agents";
import {
  createAgentAPIProvider,
  createAgentConfigBackup,
  deleteAgentAPIProvider,
  deleteAgentConfigBackup,
  fetchAgentAPIProviders,
  fetchAgentConfigBackups,
  fetchAgentConfigDefaults,
  switchAgentAPIProvider,
  switchAgentConfig,
  type AgentAPIProvider,
  type AgentConfigBackup,
} from "../services/agentConfig";
import {
  getWebPushStatus,
  sendWebPushTest,
  subscribeWebPush,
  unsubscribeWebPush,
  webPushReasonLabel,
  type WebPushStatus,
} from "../services/webPush";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const PWA_INSTALL_STATE_KEY = "mindfs-pwa-installed";
const RELAYER_AD_DISMISS_STORAGE_KEY = "mindfs-relayer-ad-dismissed";

const APPEARANCE_OPTIONS: Array<{ value: AppearanceMode; labelKey: MessageKey }> = [
  { value: "dark", labelKey: "appearance.dark" },
  { value: "light", labelKey: "appearance.light" },
  { value: "meadow", labelKey: "appearance.meadow" },
  { value: "moss", labelKey: "appearance.moss" },
  { value: "system", labelKey: "appearance.system" },
];

const LOCALE_OPTIONS: Array<{ value: Locale; labelKey: MessageKey }> = [
  { value: "zh-CN", labelKey: "locale.zhCN" },
  { value: "en-US", labelKey: "locale.enUS" },
];

const DIRECTORY_SORT_LABEL_KEYS: Partial<Record<DirectorySortMode, MessageKey>> = {
  "name-asc": "sort.nameAsc",
  "name-desc": "sort.nameDesc",
  "mtime-desc": "sort.mtimeDesc",
  "mtime-asc": "sort.mtimeAsc",
  "size-desc": "sort.sizeDesc",
  "size-asc": "sort.sizeAsc",
};

type RelayTip = {
  id: string;
  badge?: string;
  eyebrow?: string;
  title: string;
  description?: string;
  cta_label?: string;
  href?: string;
  target?: "_blank" | "_self";
  dismissible?: boolean;
};

type FileMeta = {
  source_session?: string;
  session_name?: string;
};

type RootSessionIndicator = {
  bound?: boolean;
  pending?: boolean;
};

type ProjectTreeTab = "files" | "git" | "worktrees" | "related";
export type AgentConfigSwitchRequest = {
  nonce: number;
  providerIDs?: string[];
};

const PROJECT_TREE_TAB_STORAGE_KEY = "mindfs-project-tree-tab";
const PROJECT_TREE_ROOT_PADDING_LEFT = 0;
const PROJECT_TREE_INDENT = 16;

function isProjectTreeTab(value: unknown): value is ProjectTreeTab {
  return value === "files" || value === "git" || value === "worktrees" || value === "related";
}

type FileTreeProps = {
  entries: FileEntry[];
  childrenByPath: Record<string, FileEntry[]>;
  expanded: string[];
  sortMode: DirectorySortMode;
  showHiddenFiles?: boolean;
  selectedDirKey?: string | null;
  selectedPath?: string | null;
  rootId?: string | null;
  rootSessionIndicators?: Record<string, RootSessionIndicator>;
  fileMetas?: Record<string, FileMeta>;
  activeSessionKey?: string | null;
  onSortModeChange?: (mode: DirectorySortMode) => void;
  onShowHiddenFilesChange?: (show: boolean) => void;
  onSelectFile?: (entry: FileEntry, rootId: string) => void;
  onSelectRoot?: (entry: FileEntry, rootId: string) => void;
  onToggleDir?: (entry: FileEntry, rootId: string) => void;
  renderRootExtraContent?: (rootId: string) => React.ReactNode;
  renderRootWorktreeContent?: (rootId: string) => React.ReactNode;
  renderRootRelatedContent?: (rootId: string) => React.ReactNode;
  projectTreeTabRequest?: { tab: ProjectTreeTab; nonce: number } | null;
  agentConfigSwitchRequest?: AgentConfigSwitchRequest | null;
  onProjectTreeTabChange?: (tab: ProjectTreeTab) => void;
  creatingRootName?: string | null;
  creatingRootBusy?: boolean;
  creatingRootExtraContent?: React.ReactNode;
  creatingRootSubmitOnBlur?: boolean;
  onCreateRootStart?: () => void;
  onOpenProjectAdd?: () => void;
  onStartOnboarding?: () => void;
  onCreateRootNameChange?: (name: string) => void;
  onCreateRootSubmit?: () => void;
  onCreateRootCancel?: () => void;
  projectAddOverlay?: React.ReactNode;
  relayActionLabel?: string | null;
  relayActionDisabled?: boolean;
  relayActionHelp?: string | null;
  onRelayAction?: () => void;
  relayNodeId?: string;
  relayBaseURL?: string;
  relayNoRelayer?: boolean;
  updateActionLabel?: string | null;
  updateActionDisabled?: boolean;
  updateActionHelp?: string | null;
  updateActionBusy?: boolean;
  updateActionSummary?: string | null;
  onUpdateAction?: () => void;
  showEnterKeySendOption?: boolean;
  enterKeySends?: boolean;
  onEnterKeySendsChange?: (enabled: boolean) => void;
  sidebarsSwapped?: boolean;
  onSidebarsSwappedChange?: (enabled: boolean) => void;
  gitDiffSideBySide?: boolean;
  onGitDiffSideBySideChange?: (enabled: boolean) => void;
  multiProjectSessionsEnabled?: boolean;
  onMultiProjectSessionsChange?: (enabled: boolean) => void;
  onRunAgentLifecycleCommand?: (agentName: string, action: AgentLifecycleCommandAction, commands: string[]) => void | Promise<void>;
  onRestartAgent?: (agentName: string) => void | Promise<void>;
  onGoHome?: () => void;
  footerTopContent?: React.ReactNode;
};

type AgentConfigFlow = "backup" | "switch";
type AgentConfigStep = "agent" | "details" | "confirm";
type AgentConfigAddTab = "backup" | "api";
type AgentConfigSwitchTab = "backup" | "api_provider";
type AgentConfigSwitchSelection = { type: "backup" | "api_provider"; id: string };
type AgentLifecycleCommandAction = "install" | "update";

function isAgentConfigBackupConflict(error: unknown): boolean {
  const maybeError = error as { status?: unknown; message?: unknown; payload?: { error?: unknown; message?: unknown } } | null;
  if (!maybeError) {
    return false;
  }
  const status = typeof maybeError.status === "number" ? maybeError.status : 0;
  const message = String(maybeError.payload?.error || maybeError.payload?.message || maybeError.message || "");
  return status === 409 || message === "backup already exists";
}

const fileTreeMenuButtonStyle: React.CSSProperties = {
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
};

function NotificationIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 48 48" aria-hidden="true">
      <path d="M0 0h48v48H0z" fill="none" />
      <g fill="none">
        <path stroke="currentColor" strokeLinejoin="round" strokeWidth="4" d="M24 44a19.94 19.94 0 0 0 14.142-5.858A19.94 19.94 0 0 0 44 24a19.94 19.94 0 0 0-5.858-14.142A19.94 19.94 0 0 0 24 4A19.94 19.94 0 0 0 9.858 9.858A19.94 19.94 0 0 0 4 24a19.94 19.94 0 0 0 5.858 14.142A19.94 19.94 0 0 0 24 44Z" />
        <path fill="currentColor" fillRule="evenodd" d="M24 11a2.5 2.5 0 1 1 0 5a2.5 2.5 0 0 1 0-5" clipRule="evenodd" />
        <path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" d="M24.5 34V20h-2M21 34h7" />
      </g>
    </svg>
  );
}

function WebPushMenuItem() {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<WebPushStatus | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      setStatus(await getWebPushStatus());
    } catch (error) {
      setStatus(null);
      setMessage(error instanceof Error ? error.message : t("fileTree.notificationStatusFailed"));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (action: "subscribe" | "unsubscribe" | "test") => {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (action === "subscribe") {
        setStatus(await subscribeWebPush());
      } else if (action === "unsubscribe") {
        setStatus(await unsubscribeWebPush());
      } else {
        await sendWebPushTest();
        setMessage(t("fileTree.notificationSent"));
        await refresh();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("fileTree.notificationActionFailed"));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const disabledReason = webPushReasonLabel(status?.reason);
  const enabled = Boolean(status?.enabled && status.supported);
  const subscribed = Boolean(status?.subscribed);
  const label = subscribed ? t("fileTree.notificationEnabled") : t("fileTree.enableNotification");
  const subscriptionCount = status?.subscription_count || 0;
  const currentDeviceDetail = subscribed && subscriptionCount > 0
    ? t("fileTree.notificationSubscribedDevices", { count: subscriptionCount })
    : subscribed
      ? t("fileTree.notificationDetailSubscribed")
      : t("fileTree.notificationDetailIOS");
  const detail = message || disabledReason || currentDeviceDetail;

  return (
    <div>
      <div
        style={{
          ...fileTreeMenuButtonStyle,
          color: subscribed ? "var(--accent-color)" : "var(--text-primary)",
          opacity: busy || !enabled ? 0.55 : 1,
          cursor: "default",
          minWidth: 0,
          whiteSpace: "nowrap",
        }}
      >
        <button
          type="button"
          disabled={busy || !enabled}
          onClick={() => void run(subscribed ? "unsubscribe" : "subscribe")}
          style={{
            minWidth: 0,
            border: "none",
            background: "transparent",
            color: "inherit",
            padding: 0,
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            flex: "0 1 auto",
            cursor: busy || !enabled ? "not-allowed" : "pointer",
            font: "inherit",
            textAlign: "left",
            whiteSpace: "nowrap",
          }}
        >
          <NotificationIcon />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{busy ? t("fileTree.notificationBusy") : label}</span>
        </button>
        <button
          type="button"
          aria-label={t("fileTree.notificationInfo")}
          title={t("fileTree.notificationInfo")}
          onClick={() => setExpanded((value) => !value)}
          style={{
            border: "none",
            background: "transparent",
            color: expanded ? "var(--accent-color)" : "var(--text-secondary)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            flexShrink: 0,
            padding: 0,
            marginLeft: "-4px",
          }}
        >
          <InfoIcon />
        </button>
        <span style={{ marginLeft: "auto", fontSize: "11px", opacity: subscribed ? 1 : 0, flexShrink: 0 }}>✓</span>
      </div>
      {expanded ? (
        <>
          <div style={{ padding: "0 10px 6px 32px", color: "var(--text-secondary)", fontSize: "11px", lineHeight: 1.35 }}>
            {detail}
          </div>
          {subscribed ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run("test")}
              style={{
                ...fileTreeMenuButtonStyle,
                paddingLeft: "32px",
                color: "var(--text-secondary)",
                opacity: busy ? 0.55 : 1,
                cursor: busy ? "not-allowed" : "pointer",
              }}
            >
              <span>{t("fileTree.sendTestNotification")}</span>
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

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

function RestartSpinner() {
  return (
    <span
      aria-label="restarting"
      style={{
        width: "12px",
        height: "12px",
        border: "1.5px solid currentColor",
        borderTopColor: "transparent",
        borderRadius: "50%",
        animation: "mindfs-update-spin 0.8s linear infinite",
        display: "inline-block",
        boxSizing: "border-box",
      }}
    />
  );
}

function DirectoryIconSlot({ entry, isOpen }: { entry: FileEntry; isOpen: boolean }) {
  const showSymlinkBadge = entry.is_dir && entry.is_symlink;

  return (
    <div style={{ position: "relative", width: 20, height: 18, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      {entry.is_dir ? <ChevronRight isOpen={isOpen} /> : getFileIcon(entry.name)}
      {showSymlinkBadge ? (
        <SymlinkBadge offset="-1px" />
      ) : null}
    </div>
  );
}

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

function ConfigArchiveIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 512 512" aria-hidden="true">
      <path d="M0 0h512v512H0z" fill="none" />
      <path fill="currentColor" fillRule="evenodd" d="M352 168.296c64.802 0 117.334 29.715 117.334 66.37q0 1.34-.093 2.665l.028-.294h.065v165.925c0 36.656-52.532 66.37-117.334 66.37c-63.361 0-114.992-28.408-117.256-63.936l-.077-2.434V237.037h.073a38 38 0 0 1-.073-2.37c0-36.656 52.532-66.371 117.333-66.371m0 218.074c-28.365 0-54.38-5.694-74.667-15.171v22.317l.018 1.196c.684 12.202 32.466 31.954 74.657 31.954c23.075 0 44.362-5.789 59.26-15.367c10.256-6.594 14.782-12.873 15.34-16.01l.059-.623V371.2c-20.286 9.477-46.3 15.17-74.667 15.17m0-85.333c-28.361 0-54.373-5.693-74.658-15.167l-.002 35.906l1.446-.01c1.73 1.73 5.179 4.59 11.254 8.027c15.143 8.566 37.48 13.91 61.96 13.91s46.818-5.344 61.96-13.91c7.501-4.242 11-7.608 12.2-9.05l.507-.003l.003-34.875c-20.287 9.477-46.303 15.172-74.67 15.172m0-90.075c-41.237 0-74.666 10.984-74.666 24.534s33.43 24.533 74.666 24.533c41.238 0 74.667-10.984 74.667-24.533s-33.43-24.534-74.667-24.534M101.72 51.61l30.173 30.173C109.67 104.807 96 136.14 96 170.666c0 42.82 21.026 80.728 53.316 103.965l.018-82.632H192v149.334H42.667v-42.667l68.446.001c-35.432-31.272-57.78-77.027-57.78-128c0-46.309 18.444-88.31 48.386-119.057" />
    </svg>
  );
}

function ConfigSwitchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 7h11" />
      <path d="m15 4 3 3-3 3" />
      <path d="M17 17H6" />
      <path d="m9 14-3 3 3 3" />
    </svg>
  );
}

function AgentInstallIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M0 0h48v48H0z" fill="none" />
      <path fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" d="M24 26v16.5m0-37V15m14.932 5.35L42.5 25.5l-14.932 5.65L24 26zm0 0L33 18" />
      <path fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" d="M38.932 26.85v8a2.895 2.895 0 0 1-1.87 2.708L23.998 42.5l-13.062-4.942a2.895 2.895 0 0 1-1.87-2.708v-8m20.184-10.1l5.5-5.5" />
      <path fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" d="M9.068 20.35L5.5 25.5l14.932 5.65L24 26Zm0 0L15 18m3.75-1.25l-5.5-5.5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v5" />
      <path d="M14 11v5" />
    </svg>
  );
}

function OnboardingGuideIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 2048 2048" aria-hidden="true">
      <path d="M0 0h2048v2048H0z" fill="none" />
      <path fill="currentColor" d="M2048 512v1536H0V512h517q-2-16-3-32t-2-32q0-93 35-174t96-143t142-96T960 0q93 0 174 35t143 96t96 142t35 175q0 16-1 32t-4 32zM960 128q-66 0-124 25t-102 69t-69 102t-25 124t25 124t68 102t102 69t125 25t124-25t101-68t69-102t26-125t-25-124t-69-101t-102-69t-124-26m960 512h-555q-25 52-62 97t-85 77q103 40 186 106t140 152t89 188t31 212v64h-128v-64q0-123-44-228t-121-183t-182-121t-229-44q-111 0-210 38t-176 107t-126 162t-61 205h648l-230-230l91-90l384 384l-384 384l-91-90l230-230H256v-64q0-110 31-211t90-187t141-152t185-107q-98-69-148-175H128v1280h1792z" />
    </svg>
  );
}

function AgentConfigLineEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const refs = React.useRef<Array<HTMLTextAreaElement | null>>([]);
  const lines = value.length > 0 ? value.split("\n") : [""];

  const emitLines = React.useCallback((nextLines: string[]) => {
    onChange(nextLines.join("\n"));
  }, [onChange]);

  React.useLayoutEffect(() => {
    for (const node of refs.current) {
      if (!node) {
        continue;
      }
      node.style.height = "auto";
      node.style.height = `${node.scrollHeight}px`;
    }
  }, [lines]);

  return (
    <div style={agentConfigLineEditorStyle}>
      {lines.map((line, index) => (
        <textarea
          key={index}
          ref={(node) => {
            refs.current[index] = node;
          }}
          value={line}
          onChange={(event) => {
            const nextValue = event.target.value;
            const nextLines = [...lines];
            if (nextValue.includes("\n")) {
              nextLines.splice(index, 1, ...nextValue.split(/\r?\n/));
            } else {
              nextLines[index] = nextValue;
            }
            emitLines(nextLines);
          }}
          onKeyDown={(event) => {
            const target = event.currentTarget;
            if (event.key === "Enter") {
              event.preventDefault();
              const before = line.slice(0, target.selectionStart);
              const after = line.slice(target.selectionEnd);
              const nextLines = [...lines];
              nextLines.splice(index, 1, before, after);
              emitLines(nextLines);
              window.setTimeout(() => refs.current[index + 1]?.focus(), 0);
              return;
            }
            if (event.key === "Backspace" && target.selectionStart === 0 && target.selectionEnd === 0 && index > 0) {
              event.preventDefault();
              const previous = lines[index - 1] || "";
              const nextLines = [...lines];
              nextLines.splice(index - 1, 2, previous + line);
              emitLines(nextLines);
              window.setTimeout(() => {
                const previousNode = refs.current[index - 1];
                previousNode?.focus();
                previousNode?.setSelectionRange(previous.length, previous.length);
              }, 0);
              return;
            }
            if (event.key === "Delete" && target.selectionStart === line.length && target.selectionEnd === line.length && index < lines.length - 1) {
              event.preventDefault();
              const nextLines = [...lines];
              nextLines.splice(index, 2, line + (lines[index + 1] || ""));
              emitLines(nextLines);
              window.setTimeout(() => {
                const node = refs.current[index];
                node?.focus();
                node?.setSelectionRange(line.length, line.length);
              }, 0);
            }
          }}
          placeholder={lines.length === 1 && !line ? placeholder : ""}
          rows={1}
          style={agentConfigLineTextAreaStyle}
        />
      ))}
    </div>
  );
}

function AgentConfigPopover({
  flow,
  step,
  agents,
  selectedAgent,
  addTab,
  switchTab,
  backupName,
  fileSourcesBody,
  envBody,
  apiProviderName,
  apiProviderBaseURL,
  apiProviderAPIKey,
  backups,
  apiProviders,
  selectedBackupID,
  selectedAPIProviderID,
  confirmMessage,
  busy,
  restartingAgent,
  error,
  onChooseAgent,
  onAddTabChange,
  onSwitchTabChange,
  onBackupNameChange,
  onFileSourcesChange,
  onEnvBodyChange,
  onAPIProviderNameChange,
  onAPIProviderBaseURLChange,
  onAPIProviderAPIKeyChange,
  onSelectedBackupChange,
  onSelectedAPIProviderChange,
  onDeleteBackup,
  onDeleteAPIProvider,
  onSave,
  onSwitch,
  onRestartAgent,
  onConfirm,
  onCancel,
}: {
  flow: AgentConfigFlow;
  step: AgentConfigStep;
  agents: AgentStatus[];
  selectedAgent: string;
  addTab: AgentConfigAddTab;
  switchTab: AgentConfigSwitchTab;
  backupName: string;
  fileSourcesBody: string;
  envBody: string;
  apiProviderName: string;
  apiProviderBaseURL: string;
  apiProviderAPIKey: string;
  backups: AgentConfigBackup[];
  apiProviders: AgentAPIProvider[];
  selectedBackupID: string;
  selectedAPIProviderID: string;
  confirmMessage: string;
  busy: boolean;
  restartingAgent: string;
  error: string;
  onChooseAgent: (name: string) => void;
  onAddTabChange: (tab: AgentConfigAddTab) => void;
  onSwitchTabChange: (tab: AgentConfigSwitchTab) => void;
  onBackupNameChange: (value: string) => void;
  onFileSourcesChange: (value: string) => void;
  onEnvBodyChange: (value: string) => void;
  onAPIProviderNameChange: (value: string) => void;
  onAPIProviderBaseURLChange: (value: string) => void;
  onAPIProviderAPIKeyChange: (value: string) => void;
  onSelectedBackupChange: (value: string) => void;
  onSelectedAPIProviderChange: (value: string) => void;
  onDeleteBackup: (id: string) => void;
  onDeleteAPIProvider: (id: string) => void;
  onSave: () => void;
  onSwitch: () => void;
  onRestartAgent?: (agentName: string) => void | Promise<void>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const agentTitle = flow === "backup"
    ? t("agentConfig.chooseBackupAgent")
    : t("agentConfig.chooseSwitchAgent");
  const confirmButtonLabel = flow === "backup" ? t("agentConfig.continueBackup") : t("agentConfig.continueSwitch");
  const selectedAgentStatus = agents.find((item) => item.name === selectedAgent);
  const supportsAPIProvider = Boolean(selectedAgentStatus?.supports_api_provider_switch);
  const addTabs: AgentConfigAddTab[] = supportsAPIProvider ? ["backup", "api"] : ["backup"];
  const switchTabs: AgentConfigSwitchTab[] = supportsAPIProvider ? ["backup", "api_provider"] : ["backup"];
  const effectiveAddTab: AgentConfigAddTab = supportsAPIProvider ? addTab : "backup";
  const effectiveSwitchTab: AgentConfigSwitchTab = supportsAPIProvider ? switchTab : "backup";
  return (
    <div
      style={{
        width: "100%",
        padding: "10px",
        borderRadius: "12px",
        border: "1px solid var(--border-color)",
        background: "var(--menu-bg)",
        boxShadow: "0 12px 30px rgba(15, 23, 42, 0.14)",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      }}
    >
      {step === "agent" ? (
        <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-primary)" }}>
          {agentTitle}
        </div>
      ) : null}
      {step === "agent" ? (
        <>
          {busy ? (
            <div style={agentConfigHintStyle}>{t("agentConfig.loading")}</div>
          ) : agents.length === 0 ? (
            <div style={agentConfigHintStyle}>{t("agentConfig.noInstalledAgents")}</div>
          ) : (
            <AgentMenuList
              agents={agents}
              selectedAgent={selectedAgent}
              maxHeight="220px"
              renderEnd={(agent) => {
                const name = String(agent.last_config_selection?.name || "").trim();
                const restarting = agent.name === restartingAgent;
                if (flow !== "switch" || !onRestartAgent) {
                  if (!name) {
                    return null;
                  }
                  return (
                    <span
                      title={t("agentConfig.lastSelected", { name })}
                      style={{
                        maxWidth: "120px",
                        minWidth: 0,
                        flexShrink: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: "11px",
                        color: agent.name === selectedAgent ? "var(--accent-color)" : "var(--text-secondary)",
                      }}
                    >
                      {name}
                    </span>
                  );
                }
                return (
                  <>
                    {name ? (
                      <span
                        title={t("agentConfig.lastSelected", { name })}
                        style={{
                          maxWidth: "86px",
                          minWidth: 0,
                          flexShrink: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontSize: "11px",
                          color: agent.name === selectedAgent ? "var(--accent-color)" : "var(--text-secondary)",
                        }}
                      >
                        {name}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      disabled={busy || restartingAgent !== ""}
                      onClick={(event) => {
                        event.stopPropagation();
                        void onRestartAgent(agent.name);
                      }}
                      style={{
                        ...agentConfigSecondaryButtonStyle(busy || restartingAgent !== ""),
                        padding: "2px 6px",
                        minWidth: "36px",
                        height: "18px",
                        lineHeight: "12px",
                        fontSize: "11px",
                        borderRadius: "5px",
                        flexShrink: 0,
                      }}
                    >
                      {restarting ? <RestartSpinner /> : t("agentConfig.restart")}
                    </button>
                  </>
                );
              }}
              onSelect={onChooseAgent}
            />
          )}
        </>
      ) : step === "confirm" ? (
        <>
          <div style={{ ...agentConfigHintStyle, color: "#dc2626" }}>
            {confirmMessage || t("agentConfig.targetExists")}
          </div>
          <div style={agentConfigActionRowStyle}>
            <button type="button" disabled={busy} onClick={onCancel} style={agentConfigSecondaryButtonStyle(busy)}>
              {t("common.cancel")}
            </button>
            <button type="button" disabled={busy} onClick={onConfirm} style={agentConfigPrimaryButtonStyle(busy)}>
              {confirmButtonLabel}
            </button>
          </div>
        </>
      ) : flow === "backup" ? (
        <>
          {addTabs.length > 1 ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
              {addTabs.map((tab) => {
                const active = effectiveAddTab === tab;
                return (
                  <button
                    key={tab}
                    type="button"
                    disabled={busy}
                    onClick={() => onAddTabChange(tab)}
                    style={{
                      border: "1px solid var(--border-color)",
                      background: active ? "var(--selection-bg)" : "transparent",
                      color: active ? "var(--accent-color)" : "var(--text-primary)",
                      borderRadius: "8px",
                      padding: "7px 8px",
                      fontSize: "12px",
                      fontWeight: 700,
                      cursor: busy ? "default" : "pointer",
                    }}
                  >
                    {tab === "backup" ? t("agentConfig.backup") : t("agentConfig.apiProvider")}
                  </button>
                );
              })}
            </div>
          ) : null}
          {effectiveAddTab === "backup" ? (
            <>
              <div style={agentConfigFieldStyle}>
                <label style={agentConfigLabelStyle}>{t("agentConfig.backupName")}</label>
                <input
                  value={backupName}
                  onChange={(event) => onBackupNameChange(event.target.value)}
                  placeholder="work"
                  style={agentConfigInputStyle}
                />
              </div>
              <div style={agentConfigFieldStyle}>
                <label style={agentConfigLabelStyle}>{t("agentConfig.fileSources")}</label>
                <AgentConfigLineEditor
                  value={fileSourcesBody}
                  onChange={onFileSourcesChange}
                  placeholder={t("agentConfig.fileSourcePlaceholder")}
                />
              </div>
              <div style={agentConfigFieldStyle}>
                <label style={agentConfigLabelStyle}>{t("agentConfig.env")}</label>
                <AgentConfigLineEditor
                  value={envBody}
                  onChange={onEnvBodyChange}
                  placeholder={t("agentConfig.envPlaceholder")}
                />
              </div>
            </>
          ) : (
            <>
              <div style={agentConfigFieldStyle}>
                <label style={agentConfigLabelStyle}>{t("agentConfig.providerName")}</label>
                <input
                  value={apiProviderName}
                  onChange={(event) => onAPIProviderNameChange(event.target.value)}
                  style={agentConfigInputStyle}
                />
              </div>
              <div style={agentConfigFieldStyle}>
                <label style={agentConfigLabelStyle}>Base URL</label>
                <input
                  value={apiProviderBaseURL}
                  onChange={(event) => onAPIProviderBaseURLChange(event.target.value)}
                  style={agentConfigInputStyle}
                />
              </div>
              <div style={agentConfigFieldStyle}>
                <label style={agentConfigLabelStyle}>API Key</label>
                <input
                  value={apiProviderAPIKey}
                  type="password"
                  onChange={(event) => onAPIProviderAPIKeyChange(event.target.value)}
                  placeholder="sk-..."
                  style={agentConfigInputStyle}
                />
              </div>
            </>
          )}
          <div style={agentConfigActionRowStyle}>
            <button type="button" disabled={busy} onClick={onCancel} style={agentConfigSecondaryButtonStyle(busy)}>
              {t("common.cancel")}
            </button>
            <button type="button" disabled={busy} onClick={onSave} style={agentConfigPrimaryButtonStyle(busy)}>
              {effectiveAddTab === "backup" ? t("common.save") : t("agentConfig.validateAndSave")}
            </button>
          </div>
        </>
      ) : (
        <>
          {switchTabs.length > 1 ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
              {switchTabs.map((tab) => {
                const active = effectiveSwitchTab === tab;
                return (
                  <button
                    key={tab}
                    type="button"
                    disabled={busy}
                    onClick={() => onSwitchTabChange(tab)}
                    style={{
                      border: "1px solid var(--border-color)",
                      background: active ? "var(--selection-bg)" : "transparent",
                      color: active ? "var(--accent-color)" : "var(--text-primary)",
                      borderRadius: "8px",
                      padding: "7px 8px",
                      fontSize: "12px",
                      fontWeight: 700,
                      cursor: busy ? "default" : "pointer",
                    }}
                  >
                    {tab === "backup" ? t("agentConfig.backup") : t("agentConfig.apiProvider")}
                  </button>
                );
              })}
            </div>
          ) : null}
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "260px", overflow: "auto" }}>
            {busy ? (
              <div style={agentConfigHintStyle}>{t("agentConfig.loading")}</div>
            ) : backups.length === 0 && (supportsAPIProvider ? apiProviders.length === 0 : true) ? (
              <div style={agentConfigHintStyle}>{t("agentConfig.noSwitchableConfig")}</div>
            ) : effectiveSwitchTab === "backup" ? (
              backups.length === 0 ? (
                <div style={agentConfigHintStyle}>{t("agentConfig.noBackups")}</div>
              ) : backups.map((item) => {
                const selected = item.id === selectedBackupID;
                return (
                  <div
                    key={item.id}
                    onClick={() => onSelectedBackupChange(item.id)}
                    style={{
                      border: "1px solid var(--border-color)",
                      background: selected ? "var(--selection-bg)" : "transparent",
                      color: selected ? "var(--accent-color)" : "var(--text-primary)",
                      borderRadius: "8px",
                      padding: "8px 10px",
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <div style={{ minWidth: 0, flex: 1, fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</div>
                      <button
                        type="button"
                        aria-label={t("agentConfig.deleteConfig", { name: item.name })}
                        title={t("common.delete")}
                        disabled={busy}
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteBackup(item.id);
                        }}
                        style={agentConfigIconButtonStyle(busy)}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                );
              })
            ) : (
	              apiProviders.length === 0 ? (
	                <div style={agentConfigHintStyle}>{t("agentConfig.noAPIProviders")}</div>
              ) : apiProviders.map((item) => {
                const selected = item.id === selectedAPIProviderID;
                const summary = (item.modelFamilies || []).join(", ");
                return (
                  <div
                    key={item.id}
                    onClick={() => onSelectedAPIProviderChange(item.id)}
                    style={{
                      border: "1px solid var(--border-color)",
                      background: selected ? "var(--selection-bg)" : "transparent",
                      color: selected ? "var(--accent-color)" : "var(--text-primary)",
                      borderRadius: "8px",
                      padding: "8px 10px",
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</div>
                        <div style={{ marginTop: "4px", fontSize: "11px", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</div>
                      </div>
                      <button
                        type="button"
                        aria-label={t("agentConfig.deleteAPIProvider", { name: item.name })}
                        title={t("common.delete")}
                        disabled={busy}
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteAPIProvider(item.id);
                        }}
                        style={agentConfigIconButtonStyle(busy)}
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div style={agentConfigActionRowStyle}>
            <button type="button" disabled={busy} onClick={onCancel} style={agentConfigSecondaryButtonStyle(busy)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={busy || (effectiveSwitchTab === "backup" ? !selectedBackupID : !selectedAPIProviderID)}
              onClick={onSwitch}
              style={agentConfigPrimaryButtonStyle(busy || (effectiveSwitchTab === "backup" ? !selectedBackupID : !selectedAPIProviderID))}
            >
              {t("agentConfig.switch")}
            </button>
          </div>
        </>
      )}
      {error ? <div style={{ ...agentConfigHintStyle, color: "#dc2626" }}>{error}</div> : null}
    </div>
  );
}

function AgentLifecyclePopover({
  agents,
  busy,
  runningAgent,
  error,
  onRun,
}: {
  agents: AgentStatus[];
  busy: boolean;
  runningAgent: string;
  error: string;
  onRun: (agent: AgentStatus, action: "install" | "update") => void;
}) {
  const { t } = useI18n();
  const [expandedDescriptions, setExpandedDescriptions] = React.useState<Set<string>>(() => new Set());

  return (
    <div
      style={{
        width: "100%",
        padding: "10px",
        borderRadius: "12px",
        border: "1px solid var(--border-color)",
        background: "var(--menu-bg)",
        boxShadow: "0 12px 30px rgba(15, 23, 42, 0.14)",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      }}
    >
      <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-primary)" }}>
        {t("agentConfig.lifecycleTitle")}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "320px", overflow: "auto" }}>
        {busy && agents.length === 0 ? (
          <div style={agentConfigHintStyle}>{t("agentConfig.loading")}</div>
        ) : agents.length === 0 ? (
          <div style={agentConfigHintStyle}>{t("agentConfig.noAgents")}</div>
        ) : (
          agents.map((item) => {
            const action = item.installed ? "update" : "install";
            const commands = action === "install" ? item.install_commands || [] : item.update_commands || [];
            const disabled = busy || commands.length === 0;
            const actionLabel = item.installed ? t("agentConfig.update") : t("agentConfig.install");
            const description = item.brief || t("agentConfig.noDescription");
            const descriptionExpanded = expandedDescriptions.has(item.name);
            return (
              <div
                key={item.name}
                style={{
                  border: "1px solid var(--border-color)",
                  background: "transparent",
                  color: "var(--text-primary)",
                  borderRadius: "8px",
                  padding: "8px 10px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
                  <AgentIcon
                    agentName={item.name}
                    style={{ width: "15px", height: "15px", display: "block", flexShrink: 0 }}
                  />
                  <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ fontSize: "12px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {item.name}
                    </span>
                    <button
                      type="button"
                      disabled={disabled}
                      title={commands.length > 0 ? actionLabel : t("agentConfig.noCommand")}
                      onClick={() => onRun(item, action)}
                      style={{
                        ...agentConfigPrimaryButtonStyle(disabled),
                        marginLeft: "auto",
                        padding: "2px 6px",
                        minWidth: "36px",
                        height: "18px",
                        lineHeight: "12px",
                        fontSize: "11px",
                        borderRadius: "5px",
                        flexShrink: 0,
                      }}
                    >
                      {runningAgent === item.name ? t("agentConfig.starting") : actionLabel}
                    </button>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: descriptionExpanded ? "flex-start" : "center", gap: "4px", minWidth: 0 }}>
                  <div
                    title={description}
                    style={{
                      fontSize: "11px",
                      color: "var(--text-secondary)",
                      overflow: descriptionExpanded ? "visible" : "hidden",
                      textOverflow: descriptionExpanded ? "clip" : "ellipsis",
                      whiteSpace: descriptionExpanded ? "normal" : "nowrap",
                      width: "100%",
                      lineHeight: "16px",
                      wordBreak: "break-word",
                    }}
                  >
                    {description}
                  </div>
                  <button
                    type="button"
                    aria-label={descriptionExpanded ? t("agentConfig.collapseDescription") : t("agentConfig.expandDescription")}
                    title={descriptionExpanded ? t("common.collapse") : t("common.expand")}
                    onClick={() => {
                      setExpandedDescriptions((current) => {
                        const next = new Set(current);
                        if (next.has(item.name)) {
                          next.delete(item.name);
                        } else {
                          next.add(item.name);
                        }
                        return next;
                      });
                    }}
                    style={{
                      width: "16px",
                      height: "16px",
                      border: "none",
                      background: "transparent",
                      color: "var(--text-secondary)",
                      padding: 0,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                      flexShrink: 0,
                      marginTop: descriptionExpanded ? "0" : undefined,
                    }}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      style={{ transform: descriptionExpanded ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s ease" }}
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      {error ? <div style={{ ...agentConfigHintStyle, color: "#dc2626" }}>{error}</div> : null}
    </div>
  );
}

const agentConfigFieldStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "6px",
};

const agentConfigLabelStyle: React.CSSProperties = {
  fontSize: "11px",
  fontWeight: 600,
  color: "var(--text-secondary)",
};

const agentConfigInputStyle: React.CSSProperties = {
  width: "100%",
  borderRadius: "8px",
  border: "1px solid var(--border-color)",
  background: "transparent",
  color: "var(--text-primary)",
  fontSize: "12px",
  padding: "8px 10px",
  outline: "none",
  boxSizing: "border-box",
};

const agentConfigLineEditorStyle: React.CSSProperties = {
  ...agentConfigInputStyle,
  minHeight: "42px",
  maxHeight: "260px",
  overflow: "auto",
  padding: "6px",
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};

const agentConfigLineTextAreaStyle: React.CSSProperties = {
  width: "100%",
  border: "none",
  borderRadius: "6px",
  background: "rgba(148, 163, 184, 0.16)",
  color: "var(--text-primary)",
  fontSize: "12px",
  padding: "4px 8px",
  outline: "none",
  boxSizing: "border-box",
  minHeight: "28px",
  resize: "none",
  lineHeight: "20px",
  overflow: "hidden",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
};

const agentConfigHintStyle: React.CSSProperties = {
  borderRadius: "8px",
  padding: "8px 10px",
  fontSize: "12px",
  color: "var(--text-secondary)",
  background: "rgba(148, 163, 184, 0.10)",
  lineHeight: 1.45,
  wordBreak: "break-word",
};

const agentConfigActionRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "8px",
};

const agentConfigPrimaryButtonStyle = (disabled: boolean): React.CSSProperties => ({
  border: "none",
  background: "var(--accent-color)",
  color: "#fff",
  borderRadius: "8px",
  padding: "8px 10px",
  fontSize: "12px",
  fontWeight: 600,
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.6 : 1,
});

const agentConfigSecondaryButtonStyle = (disabled: boolean): React.CSSProperties => ({
  border: "1px solid var(--border-color)",
  background: "transparent",
  color: "var(--text-secondary)",
  borderRadius: "8px",
  padding: "8px 10px",
  fontSize: "12px",
  fontWeight: 600,
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.6 : 1,
});

const agentConfigIconButtonStyle = (disabled: boolean): React.CSSProperties => ({
  width: "28px",
  height: "28px",
  border: "none",
  borderRadius: "8px",
  background: "transparent",
  color: "#dc2626",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.5 : 0.9,
  flexShrink: 0,
});

export function FileTree({
  entries,
  childrenByPath,
  expanded,
  sortMode,
  showHiddenFiles = false,
  selectedDirKey,
  selectedPath,
  rootId,
  rootSessionIndicators = {},
  fileMetas = {},
  activeSessionKey,
  onSortModeChange,
  onShowHiddenFilesChange,
  onSelectFile,
  onSelectRoot,
  onToggleDir,
  renderRootExtraContent,
  renderRootWorktreeContent,
  renderRootRelatedContent,
  projectTreeTabRequest = null,
  agentConfigSwitchRequest = null,
  onProjectTreeTabChange,
  creatingRootName = null,
  creatingRootBusy = false,
  creatingRootExtraContent = null,
  creatingRootSubmitOnBlur = true,
  onCreateRootStart,
  onOpenProjectAdd,
  onStartOnboarding,
  onCreateRootNameChange,
  onCreateRootSubmit,
  onCreateRootCancel,
  projectAddOverlay,
  relayActionLabel = null,
  relayActionDisabled = false,
  relayActionHelp = null,
  onRelayAction,
  relayNodeId = "",
  relayBaseURL = "",
  relayNoRelayer = false,
  updateActionLabel = null,
  updateActionDisabled = false,
  updateActionHelp = null,
  updateActionBusy = false,
  updateActionSummary = null,
  onUpdateAction,
  showEnterKeySendOption = false,
  enterKeySends = false,
  onEnterKeySendsChange,
  sidebarsSwapped = false,
  onSidebarsSwappedChange,
  gitDiffSideBySide = false,
  onGitDiffSideBySideChange,
  multiProjectSessionsEnabled = false,
  onMultiProjectSessionsChange,
  onRunAgentLifecycleCommand,
  onRestartAgent,
  onGoHome,
  footerTopContent,
}: FileTreeProps) {
  const { locale, setLocale, t } = useI18n();
  const sortLabel = React.useCallback((mode: DirectorySortMode): string => {
    const key = DIRECTORY_SORT_LABEL_KEYS[mode];
    return key ? t(key) : t("directory.defaultSort");
  }, [t]);
  const expandedSet = new Set(expanded);
  const [isMenuOpen, setIsMenuOpen] = React.useState(false);
  const [projectTreeTab, setProjectTreeTab] = React.useState<ProjectTreeTab>(() => {
    if (typeof window === "undefined") {
      return "files";
    }
    try {
      const saved = window.localStorage.getItem(PROJECT_TREE_TAB_STORAGE_KEY);
      return isProjectTreeTab(saved) ? saved : "files";
    } catch {
      return "files";
    }
  });
  const [isAppearanceMenuOpen, setIsAppearanceMenuOpen] = React.useState(false);
  const [isLocaleMenuOpen, setIsLocaleMenuOpen] = React.useState(false);
  const [isSortMenuOpen, setIsSortMenuOpen] = React.useState(false);
  const [appearanceMode, setAppearanceModeState] = React.useState<AppearanceMode>(() => getAppearanceMode());
  const [isUpdateNotesOpen, setIsUpdateNotesOpen] = React.useState(false);
  const [deferredInstallPrompt, setDeferredInstallPrompt] = React.useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = React.useState(false);
  const [isInstallCapable, setIsInstallCapable] = React.useState(false);
  const [relayTips, setRelayTips] = React.useState<RelayTip[]>([]);
  const [protectedAPIReady, setProtectedAPIReady] = React.useState(() =>
    bootstrapService.canUseProtectedAPI(),
  );
  const [activeRelayTipIndex, setActiveRelayTipIndex] = React.useState(0);
  const [agentConfigFlow, setAgentConfigFlow] = React.useState<AgentConfigFlow | null>(null);
  const [agentConfigStep, setAgentConfigStep] = React.useState<AgentConfigStep>("agent");
  const [agentConfigAgents, setAgentConfigAgents] = React.useState<AgentStatus[]>([]);
  const [agentConfigAgent, setAgentConfigAgent] = React.useState("");
  const [agentConfigAddTab, setAgentConfigAddTab] = React.useState<AgentConfigAddTab>("backup");
  const [agentConfigSwitchTab, setAgentConfigSwitchTab] = React.useState<AgentConfigSwitchTab>("backup");
  const [agentConfigName, setAgentConfigName] = React.useState("");
  const [agentConfigFileSourcesBody, setAgentConfigFileSourcesBody] = React.useState("");
  const [agentConfigEnvBody, setAgentConfigEnvBody] = React.useState("");
  const [agentAPIProviderName, setAgentAPIProviderName] = React.useState("");
  const [agentAPIProviderBaseURL, setAgentAPIProviderBaseURL] = React.useState("");
  const [agentAPIProviderAPIKey, setAgentAPIProviderAPIKey] = React.useState("");
  const [agentConfigBackups, setAgentConfigBackups] = React.useState<AgentConfigBackup[]>([]);
  const [agentAPIProviders, setAgentAPIProviders] = React.useState<AgentAPIProvider[]>([]);
  const [selectedAgentConfigID, setSelectedAgentConfigID] = React.useState("");
  const [selectedAgentAPIProviderID, setSelectedAgentAPIProviderID] = React.useState("");
  const [agentConfigSwitchSelection, setAgentConfigSwitchSelection] = React.useState<AgentConfigSwitchSelection | null>(null);
  const [agentConfigPreferredProviderIDs, setAgentConfigPreferredProviderIDs] = React.useState<string[]>([]);
  const [agentConfigConfirmMessage, setAgentConfigConfirmMessage] = React.useState("");
  const [agentConfigBusy, setAgentConfigBusy] = React.useState(false);
  const [agentConfigRestartingAgent, setAgentConfigRestartingAgent] = React.useState("");
  const [agentConfigError, setAgentConfigError] = React.useState("");
  const [agentLifecycleOpen, setAgentLifecycleOpen] = React.useState(false);
  const [relayServicesOpen, setRelayServicesOpen] = React.useState(false);
  const [relayServicesEditing, setRelayServicesEditing] = React.useState(false);
  const [agentLifecycleAgents, setAgentLifecycleAgents] = React.useState<AgentStatus[]>([]);
  const [agentLifecycleBusy, setAgentLifecycleBusy] = React.useState(false);
  const [agentLifecycleRunningAgent, setAgentLifecycleRunningAgent] = React.useState("");
  const [agentLifecycleError, setAgentLifecycleError] = React.useState("");
  const [dismissedRelayTipIds, setDismissedRelayTipIds] = React.useState<string[]>(() => {
    if (typeof window === "undefined") {
      return [];
    }
    try {
      const raw = window.localStorage.getItem(RELAYER_AD_DISMISS_STORAGE_KEY);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      }
      return typeof parsed === "string" && parsed.trim().length > 0 ? [parsed] : [];
    } catch {
      try {
        const legacy = window.localStorage.getItem(RELAYER_AD_DISMISS_STORAGE_KEY);
        return legacy && legacy.trim().length > 0 ? [legacy] : [];
      } catch {
        return [];
      }
    }
  });
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const agentConfigPopoverRef = React.useRef<HTMLDivElement | null>(null);
  const agentLifecyclePopoverRef = React.useRef<HTMLDivElement | null>(null);
  const relayServicesPopoverRef = React.useRef<HTMLDivElement | null>(null);
  const updateNotesRef = React.useRef<HTMLDivElement | null>(null);
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

  const [isNativeApp, setIsNativeApp] = React.useState(() => isNativeShellRuntime());

  React.useEffect(() => {
    if (!projectTreeTabRequest || !isProjectTreeTab(projectTreeTabRequest.tab)) {
      return;
    }
    setProjectTreeTab(projectTreeTabRequest.tab);
  }, [projectTreeTabRequest?.nonce, projectTreeTabRequest?.tab]);

  React.useEffect(() => {
    onProjectTreeTabChange?.(projectTreeTab);
  }, [onProjectTreeTabChange, projectTreeTab]);

  React.useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      window.localStorage.setItem(PROJECT_TREE_TAB_STORAGE_KEY, projectTreeTab);
    } catch {
    }
  }, [projectTreeTab]);

  React.useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const syncAppearanceMode = () => {
      setAppearanceModeState(getAppearanceMode());
    };
    window.addEventListener(APPEARANCE_CHANGE_EVENT, syncAppearanceMode);
    window.addEventListener("storage", syncAppearanceMode);
    return () => {
      window.removeEventListener(APPEARANCE_CHANGE_EVENT, syncAppearanceMode);
      window.removeEventListener("storage", syncAppearanceMode);
    };
  }, []);

  React.useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const refreshNativeRuntime = () => {
      setIsNativeApp(isNativeShellRuntime());
    };
    refreshNativeRuntime();
    const timers = [250, 1000, 2000].map((delay) => window.setTimeout(refreshNativeRuntime, delay));
    window.addEventListener("mindfs:native-bridge-ready", refreshNativeRuntime);
    window.addEventListener("pageshow", refreshNativeRuntime);
    window.addEventListener("focus", refreshNativeRuntime);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("mindfs:native-bridge-ready", refreshNativeRuntime);
      window.removeEventListener("pageshow", refreshNativeRuntime);
      window.removeEventListener("focus", refreshNativeRuntime);
    };
  }, []);

  const isDesktopChromium = React.useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }
    const ua = window.navigator.userAgent;
    const isDesktop = !/Android|iPhone|iPad|iPod/i.test(ua);
    const isChromium = /Chrome|Chromium|Edg/i.test(ua);
    const isExcluded = /OPR/i.test(ua);
    return isDesktop && isChromium && !isExcluded;
  }, []);

  const isStandaloneDisplay = React.useCallback(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.matchMedia("(display-mode: standalone)").matches
      || window.matchMedia("(display-mode: window-controls-overlay)").matches
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
    if (typeof window === "undefined" || !shouldEnablePWAInstall()) {
      setDeferredInstallPrompt(null);
      setIsInstalled(false);
      setIsInstallCapable(false);
      return;
    }

    const updateInstallState = () => {
      const installed = isStandaloneDisplay();
      const knownInstall = installed || hasPersistedInstallState();
      setIsInstalled(installed);
      setIsInstallCapable(knownInstall || isIOS || "serviceWorker" in navigator);
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
    window.addEventListener("pageshow", updateInstallState);
    document.addEventListener("visibilitychange", updateInstallState);

    const standaloneQuery = window.matchMedia("(display-mode: standalone)");
    const overlayQuery = window.matchMedia("(display-mode: window-controls-overlay)");
    const fullscreenQuery = window.matchMedia("(display-mode: fullscreen)");
    standaloneQuery.addEventListener?.("change", updateInstallState);
    overlayQuery.addEventListener?.("change", updateInstallState);
    fullscreenQuery.addEventListener?.("change", updateInstallState);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleInstalled);
      window.removeEventListener("pageshow", updateInstallState);
      document.removeEventListener("visibilitychange", updateInstallState);
      standaloneQuery.removeEventListener?.("change", updateInstallState);
      overlayQuery.removeEventListener?.("change", updateInstallState);
      fullscreenQuery.removeEventListener?.("change", updateInstallState);
    };
  }, [hasPersistedInstallState, isIOS, isStandaloneDisplay, persistInstallState]);

  const isKnownInstalled = isInstalled || hasPersistedInstallState();

  const installLabel = isKnownInstalled
    ? t("pwa.installed")
    : isIOS
      ? t("pwa.addToHomeScreen")
      : isMacSafari
        ? t("pwa.addToDock")
      : isDesktopChromium && isInstallCapable
        ? t("pwa.installApp")
      : isAndroidChrome && !deferredInstallPrompt
        ? t("pwa.installFromMenu")
      : deferredInstallPrompt
        ? t("pwa.installApp")
        : t("pwa.installInstructions");

  const installHelp = isInstalled
    ? ""
    : isKnownInstalled
      ? t("pwa.helpInstalled")
      : isIOS
      ? t("pwa.helpIOS")
      : isMacSafari
        ? t("pwa.helpMacSafari")
      : isDesktopChromium && isInstallCapable
        ? t("pwa.helpDesktopChromium")
      : isAndroidChrome && !deferredInstallPrompt
        ? t("pwa.helpAndroidChrome")
      : deferredInstallPrompt
        ? t("pwa.helpDeferred")
        : t("pwa.helpUnavailable");

  const shouldShowInstallButton = !isNativeApp && !isKnownInstalled && !(isAndroidChrome && !deferredInstallPrompt);
  const shouldShowInstallHelp = !isNativeApp && (!!installHelp) && (isKnownInstalled || isIOS || isMacSafari || isDesktopChromium || deferredInstallPrompt !== null || (isAndroidChrome && !deferredInstallPrompt));
  const visibleRelayTips = React.useMemo(
    () => relayTips.filter((tip) => tip.id && tip.title && !dismissedRelayTipIds.includes(tip.id)),
    [dismissedRelayTipIds, relayTips],
  );
  const relayTip = visibleRelayTips.length > 0
    ? visibleRelayTips[((activeRelayTipIndex % visibleRelayTips.length) + visibleRelayTips.length) % visibleRelayTips.length]
    : null;
  const shouldShowRelayTip = Boolean(relayTip);
  const shouldShowNextRelayTip = visibleRelayTips.length > 1;
  const hasFooterContent =
    !!updateActionLabel ||
    !!updateActionHelp ||
    !!footerTopContent ||
    !!relayActionLabel ||
    !!relayActionHelp ||
    shouldShowRelayTip ||
    (isNativeApp && !!onGoHome) ||
    shouldShowInstallButton ||
    shouldShowInstallHelp;

  const dismissRelayTip = React.useCallback(() => {
    if (!relayTip?.id) {
      return;
    }
    setDismissedRelayTipIds((current) => {
      if (current.includes(relayTip.id)) {
        return current;
      }
      const next = [...current, relayTip.id];
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(RELAYER_AD_DISMISS_STORAGE_KEY, JSON.stringify(next));
        } catch {
        }
      }
      return next;
    });
    setActiveRelayTipIndex((current) => {
      if (visibleRelayTips.length <= 1) {
        return 0;
      }
      return current % (visibleRelayTips.length - 1);
    });
  }, [relayTip, visibleRelayTips.length]);

  const openRelayTip = React.useCallback(() => {
    if (typeof window === "undefined" || !relayTip?.href) {
      return;
    }
    if (relayTip.target === "_self") {
      window.location.assign(relayTip.href);
      return;
    }
    openExternalURL(relayTip.href);
  }, [relayTip]);

  const handleInstall = React.useCallback(async () => {
    if (isKnownInstalled) {
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
      window.alert(t("pwa.alertIOS"));
      return;
    }
    if (isMacSafari && typeof window !== "undefined") {
      window.alert(t("pwa.alertMacSafari"));
      return;
    }
    if (isDesktopChromium && typeof window !== "undefined") {
      window.alert(t("pwa.alertDesktopChromium"));
      return;
    }
    if (isAndroidChrome && typeof window !== "undefined") {
      window.alert(t("pwa.alertAndroidChrome"));
      return;
    }
    if (typeof window !== "undefined") {
      window.alert(t("pwa.alertUnavailable"));
    }
  }, [deferredInstallPrompt, isAndroidChrome, isDesktopChromium, isIOS, isKnownInstalled, isMacSafari, persistInstallState, t]);

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
    return bootstrapService.subscribe(() => {
      setProtectedAPIReady(bootstrapService.canUseProtectedAPI());
    });
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const loadRelayTip = async () => {
      if (!protectedAPIReady) {
        setRelayTips([]);
        return;
      }
      try {
        const payload = await protectedJSON<RelayTip | RelayTip[] | null>(appPath("/api/relay/tips"), { signal: controller.signal });
        if (!cancelled) {
          const nextTips = Array.isArray(payload)
            ? payload.filter((tip): tip is RelayTip => Boolean(tip?.id && tip?.title))
            : payload && payload.id && payload.title
              ? [payload]
              : [];
          setRelayTips(nextTips);
        }
      } catch {
        if (!cancelled) {
          setRelayTips([]);
        }
      }
    };

    loadRelayTip();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [protectedAPIReady]);

  React.useEffect(() => {
    if (!isUpdateNotesOpen || typeof document === "undefined") {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (updateNotesRef.current && !updateNotesRef.current.contains(event.target as Node)) {
        setIsUpdateNotesOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isUpdateNotesOpen]);

  React.useEffect(() => {
    if (!updateActionLabel || !updateActionSummary) {
      setIsUpdateNotesOpen(false);
    }
  }, [updateActionLabel, updateActionSummary]);

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

  const openAgentConfigFlow = React.useCallback((flow: AgentConfigFlow) => {
    setAgentLifecycleOpen(false);
    setAgentConfigFlow(flow);
    setAgentConfigStep("agent");
    setAgentConfigAgent("");
    setAgentConfigAddTab("backup");
    setAgentConfigSwitchTab("backup");
    setAgentConfigName("");
    setAgentConfigFileSourcesBody("");
    setAgentConfigEnvBody("");
    setAgentAPIProviderName("");
    setAgentAPIProviderBaseURL("");
    setAgentAPIProviderAPIKey("");
    setAgentConfigBackups([]);
    setAgentAPIProviders([]);
    setSelectedAgentConfigID("");
    setSelectedAgentAPIProviderID("");
    setAgentConfigSwitchSelection(null);
    setAgentConfigPreferredProviderIDs([]);
    setAgentConfigConfirmMessage("");
    setAgentConfigError("");
    setAgentConfigRestartingAgent("");
    setIsMenuOpen(false);
    setAgentConfigBusy(true);
    fetchAgents(true)
      .then((items) => {
        setAgentConfigAgents(items.filter((item) => item.installed));
      })
      .catch((error) => {
        setAgentConfigError(error instanceof Error ? error.message : t("agentConfig.loadAgentFailed"));
      })
      .finally(() => setAgentConfigBusy(false));
  }, [t]);

  React.useEffect(() => {
    if (!agentConfigSwitchRequest) {
      return;
    }
    const providerIDs = (agentConfigSwitchRequest.providerIDs || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    setAgentLifecycleOpen(false);
    setAgentConfigFlow("switch");
    setAgentConfigStep("agent");
    setAgentConfigAgent("");
    setAgentConfigAddTab("backup");
    setAgentConfigSwitchTab("api_provider");
    setAgentConfigName("");
    setAgentConfigFileSourcesBody("");
    setAgentConfigEnvBody("");
    setAgentAPIProviderName("");
    setAgentAPIProviderBaseURL("");
    setAgentAPIProviderAPIKey("");
    setAgentConfigBackups([]);
    setAgentAPIProviders([]);
    setSelectedAgentConfigID("");
    setSelectedAgentAPIProviderID("");
    setAgentConfigSwitchSelection(null);
    setAgentConfigPreferredProviderIDs(providerIDs);
    setAgentConfigConfirmMessage("");
    setAgentConfigError("");
    setAgentConfigRestartingAgent("");
    setIsMenuOpen(false);
    setAgentConfigBusy(true);
    fetchAgents(true)
      .then((items) => {
        setAgentConfigAgents(items.filter((item) => item.installed));
      })
      .catch((error) => {
        setAgentConfigError(error instanceof Error ? error.message : t("agentConfig.loadAgentFailed"));
      })
      .finally(() => setAgentConfigBusy(false));
  }, [agentConfigSwitchRequest?.nonce, t]);

  const closeAgentConfigFlow = React.useCallback(() => {
    setAgentConfigFlow(null);
    setAgentConfigStep("agent");
    setAgentConfigError("");
    setAgentConfigConfirmMessage("");
    setAgentConfigSwitchSelection(null);
    setAgentConfigSwitchTab("backup");
    setAgentConfigRestartingAgent("");
  }, []);

  const openAgentLifecycleFlow = React.useCallback(() => {
    setAgentConfigFlow(null);
    setAgentLifecycleOpen(true);
    setIsMenuOpen(false);
    setAgentLifecycleError("");
    setAgentLifecycleBusy(true);
    fetchAgentCatalog(true)
      .then((items) => {
        setAgentLifecycleAgents(items);
      })
      .catch((error) => {
        setAgentLifecycleError(error instanceof Error ? error.message : t("agentConfig.loadAgentFailed"));
      })
      .finally(() => setAgentLifecycleBusy(false));
  }, [t]);

  const closeAgentLifecycleFlow = React.useCallback(() => {
    setAgentLifecycleOpen(false);
    setAgentLifecycleError("");
    setAgentLifecycleRunningAgent("");
  }, []);

  React.useEffect(() => {
    if (!agentConfigFlow || agentConfigStep !== "agent") {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!agentConfigPopoverRef.current?.contains(event.target as Node)) {
        closeAgentConfigFlow();
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [agentConfigFlow, agentConfigStep, closeAgentConfigFlow]);

  React.useEffect(() => {
    if (!agentLifecycleOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!agentLifecyclePopoverRef.current?.contains(event.target as Node)) {
        closeAgentLifecycleFlow();
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [agentLifecycleOpen, closeAgentLifecycleFlow]);

  React.useEffect(() => {
    if (!relayServicesOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (relayServicesEditing) {
        return;
      }
      if (!relayServicesPopoverRef.current?.contains(event.target as Node)) {
        setRelayServicesOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [relayServicesEditing, relayServicesOpen]);

  const closeRelayServices = React.useCallback(() => {
    setRelayServicesOpen(false);
    setRelayServicesEditing(false);
  }, []);

  const runAgentLifecycleCommand = React.useCallback(async (agent: AgentStatus, action: AgentLifecycleCommandAction) => {
    const commands = action === "install" ? agent.install_commands || [] : agent.update_commands || [];
    if (commands.length === 0) {
      setAgentLifecycleError(t("agentConfig.noCommand"));
      return;
    }
    setAgentLifecycleBusy(true);
    setAgentLifecycleRunningAgent(agent.name);
    setAgentLifecycleError("");
    try {
      await onRunAgentLifecycleCommand?.(agent.name, action, commands);
      closeAgentLifecycleFlow();
    } catch (error) {
      setAgentLifecycleError(error instanceof Error ? error.message : t("agentConfig.commandStartFailed"));
    } finally {
      setAgentLifecycleBusy(false);
      setAgentLifecycleRunningAgent("");
    }
  }, [closeAgentLifecycleFlow, onRunAgentLifecycleCommand, t]);

  const restartAgentFromConfigList = React.useCallback(async (agentName: string) => {
    if (!agentName || !onRestartAgent || agentConfigRestartingAgent) {
      return;
    }
    setAgentConfigRestartingAgent(agentName);
    setAgentConfigError("");
    try {
      await onRestartAgent(agentName);
    } catch (error) {
      setAgentConfigError(error instanceof Error ? error.message : t("agentConfig.restartFailed"));
    } finally {
      setAgentConfigRestartingAgent("");
    }
  }, [agentConfigRestartingAgent, onRestartAgent, t]);

  const chooseAgentForConfig = React.useCallback(async (agentName: string) => {
    setAgentConfigAgent(agentName);
    setAgentConfigError("");
    setAgentConfigBusy(true);
    try {
      const selectedAgent = agentConfigAgents.find((item) => item.name === agentName);
      const supportsAPIProvider = Boolean(selectedAgent?.supports_api_provider_switch);
      if (agentConfigFlow === "backup") {
        const defaults = await fetchAgentConfigDefaults(agentName);
        setAgentConfigName("");
        setAgentConfigFileSourcesBody((defaults.file_sources || []).join("\n"));
        setAgentConfigEnvBody((defaults.env_keys || []).map((key) => `${key}=`).join("\n"));
        setAgentAPIProviderName("");
        setAgentAPIProviderBaseURL("");
        setAgentAPIProviderAPIKey("");
        setAgentConfigAddTab("backup");
        setAgentConfigStep("details");
      } else {
        const [backups, providers] = await Promise.all([
          fetchAgentConfigBackups(agentName),
          supportsAPIProvider ? fetchAgentAPIProviders(agentName) : Promise.resolve([]),
        ]);
        setAgentConfigBackups(backups);
        setAgentAPIProviders(providers);
        setSelectedAgentConfigID("");
        const preferredProvider = providers.find((provider) => agentConfigPreferredProviderIDs.includes(provider.id));
        setSelectedAgentAPIProviderID(preferredProvider?.id || "");
        setAgentConfigSwitchSelection(preferredProvider ? { type: "api_provider", id: preferredProvider.id } : null);
        setAgentConfigSwitchTab(supportsAPIProvider && selectedAgent?.last_config_selection?.type === "api_provider" ? "api_provider" : "backup");
        if (supportsAPIProvider && agentConfigPreferredProviderIDs.length > 0) {
          setAgentConfigSwitchTab("api_provider");
        }
        setAgentConfigStep("details");
      }
    } catch (error) {
      setAgentConfigError(error instanceof Error ? error.message : t("agentConfig.loadConfigFailed"));
    } finally {
      setAgentConfigBusy(false);
    }
  }, [agentConfigAgents, agentConfigFlow, agentConfigPreferredProviderIDs, t]);

  const saveAgentConfigBackup = React.useCallback(async (overwrite = false) => {
    if (!agentConfigName.trim()) {
      setAgentConfigError(t("agentConfig.backupNameRequired"));
      return;
    }
    const fileSources = agentConfigFileSourcesBody.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const envLines = agentConfigEnvBody.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    setAgentConfigBusy(true);
    setAgentConfigError("");
    try {
      await createAgentConfigBackup({
        agent: agentConfigAgent,
        name: agentConfigName.trim(),
        fileSources,
        envLines,
        overwrite,
      });
      closeAgentConfigFlow();
    } catch (error) {
      if (isAgentConfigBackupConflict(error) && !overwrite) {
        setAgentConfigConfirmMessage(t("agentConfig.backupExistsOverwrite"));
        setAgentConfigStep("confirm");
        return;
      }
      setAgentConfigError(error instanceof Error ? error.message : t("agentConfig.saveBackupFailed"));
    } finally {
      setAgentConfigBusy(false);
    }
  }, [agentConfigAgent, agentConfigEnvBody, agentConfigFileSourcesBody, agentConfigName, closeAgentConfigFlow, t]);

  const saveAgentAPIProvider = React.useCallback(async () => {
    if (!agentAPIProviderName.trim()) {
      setAgentConfigError(t("agentConfig.providerNameRequired"));
      return;
    }
    if (!agentAPIProviderBaseURL.trim()) {
      setAgentConfigError(t("agentConfig.baseURLRequired"));
      return;
    }
    if (!agentAPIProviderAPIKey.trim()) {
      setAgentConfigError(t("agentConfig.apiKeyRequired"));
      return;
    }
    setAgentConfigBusy(true);
    setAgentConfigError("");
    try {
      await createAgentAPIProvider({
        name: agentAPIProviderName.trim(),
        baseUrl: agentAPIProviderBaseURL.trim(),
        apiKey: agentAPIProviderAPIKey.trim(),
      });
      closeAgentConfigFlow();
    } catch (error) {
      setAgentConfigError(error instanceof Error ? error.message : t("agentConfig.saveProviderFailed"));
    } finally {
      setAgentConfigBusy(false);
    }
  }, [agentAPIProviderAPIKey, agentAPIProviderBaseURL, agentAPIProviderName, closeAgentConfigFlow, t]);

  const runAgentConfigSwitch = React.useCallback(async (confirmOverwrite = false) => {
    if (!agentConfigSwitchSelection) {
      setAgentConfigError(t("agentConfig.selectConfig"));
      return;
    }
    setAgentConfigBusy(true);
    setAgentConfigError("");
    try {
      if (agentConfigSwitchSelection.type === "api_provider") {
        await switchAgentAPIProvider({ agent: agentConfigAgent, providerID: agentConfigSwitchSelection.id });
        closeAgentConfigFlow();
        return;
      }
      const result = await switchAgentConfig({ id: agentConfigSwitchSelection.id, confirmOverwrite });
      if (result.needs_confirm) {
        setAgentConfigConfirmMessage(result.message || t("agentConfig.targetExists"));
        setAgentConfigStep("confirm");
        return;
      }
      closeAgentConfigFlow();
    } catch (error) {
      setAgentConfigError(error instanceof Error ? error.message : t("agentConfig.switchFailed"));
    } finally {
      setAgentConfigBusy(false);
    }
  }, [agentConfigAgent, agentConfigSwitchSelection, closeAgentConfigFlow, t]);

  const deleteSelectedAgentConfigBackup = React.useCallback(async (id: string) => {
    const trimmedID = String(id || "").trim();
    if (!trimmedID) {
      return;
    }
    setAgentConfigBusy(true);
    setAgentConfigError("");
    try {
      const result = await deleteAgentConfigBackup(trimmedID);
      const nextBackups = (result.backups || agentConfigBackups)
        .filter((item) => item.agent === agentConfigAgent && item.id !== trimmedID);
      setAgentConfigBackups(nextBackups);
      if (selectedAgentConfigID === trimmedID) {
        setSelectedAgentConfigID("");
        setAgentConfigSwitchSelection(null);
      }
    } catch (error) {
      setAgentConfigError(error instanceof Error ? error.message : t("agentConfig.deleteConfigFailed"));
    } finally {
      setAgentConfigBusy(false);
    }
  }, [agentConfigAgent, agentConfigBackups, selectedAgentConfigID, t]);

  const deleteSelectedAgentAPIProvider = React.useCallback(async (id: string) => {
    const trimmedID = String(id || "").trim();
    if (!trimmedID) {
      return;
    }
    setAgentConfigBusy(true);
    setAgentConfigError("");
    try {
      const result = await deleteAgentAPIProvider(trimmedID);
      const nextProviders = (result.providers || agentAPIProviders)
        .filter((item) => item.id !== trimmedID);
      setAgentAPIProviders(nextProviders);
      if (selectedAgentAPIProviderID === trimmedID) {
        setSelectedAgentAPIProviderID("");
        setAgentConfigSwitchSelection(null);
      }
    } catch (error) {
      setAgentConfigError(error instanceof Error ? error.message : t("agentConfig.deleteProviderFailed"));
    } finally {
      setAgentConfigBusy(false);
    }
  }, [agentAPIProviders, selectedAgentAPIProviderID, t]);

  const selectAgentConfigBackup = React.useCallback((id: string) => {
    setSelectedAgentConfigID(id);
    setSelectedAgentAPIProviderID("");
    setAgentConfigSwitchSelection(id ? { type: "backup", id } : null);
  }, []);

  const selectAgentAPIProvider = React.useCallback((id: string) => {
    setSelectedAgentAPIProviderID(id);
    setSelectedAgentConfigID("");
    setAgentConfigSwitchSelection(id ? { type: "api_provider", id } : null);
  }, []);

  React.useEffect(() => {
    if (visibleRelayTips.length === 0) {
      setActiveRelayTipIndex(0);
      return;
    }
    setActiveRelayTipIndex((current) => current % visibleRelayTips.length);
  }, [visibleRelayTips.length]);

  const showNextRelayTip = React.useCallback(() => {
    if (visibleRelayTips.length <= 1) {
      return;
    }
    setActiveRelayTipIndex((current) => (current + 1) % visibleRelayTips.length);
  }, [visibleRelayTips.length]);

  const childKeyFor = (entry: FileEntry, entryRoot: string) => {
    if (entry.is_root) return `${entry.path}:.`;
    return `${entryRoot}:${entry.path}`;
  };

  const visibleEntries = React.useCallback((items: FileEntry[], depth = 0) => {
    const hiddenFiltered = showHiddenFiles
      ? items
      : items.filter((entry) => !entry.name.startsWith("."));
    if (projectTreeTab !== "related" || depth !== 0) {
      return hiddenFiltered;
    }
    return hiddenFiltered.filter((entry) => !!rootId && entry.path === rootId);
  }, [projectTreeTab, rootId, showHiddenFiles]);

  const renderEntries = (items: FileEntry[], depth: number, branchRoot: string) => (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {depth === 0 && creatingRootName !== null ? (
        <li key="__draft_root__">
          <div
            style={{
              padding: "6px 8px",
              paddingLeft: PROJECT_TREE_ROOT_PADDING_LEFT,
              display: "flex",
              alignItems: creatingRootExtraContent ? "flex-start" : "center",
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
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "8px" }}>
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
                  if (!creatingRootBusy && creatingRootSubmitOnBlur) {
                    onCreateRootSubmit?.();
                  }
                }}
                style={{
                  width: "100%",
                  border: "none",
                  background: "transparent",
                  color: "var(--text-primary)",
                  fontSize: "13px",
                  fontWeight: 600,
                  outline: "none",
                  padding: 0,
                }}
              />
              {creatingRootExtraContent}
            </div>
            {!creatingRootExtraContent ? null : (
              <div style={{ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
                <button
                  type="button"
                  disabled={creatingRootBusy}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onCreateRootSubmit?.()}
                  style={{
                    border: "none",
                    background: "var(--accent-color)",
                    color: "#fff",
                    borderRadius: "6px",
                    padding: "4px 7px",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: creatingRootBusy ? "not-allowed" : "pointer",
                    opacity: creatingRootBusy ? 0.6 : 1,
                  }}
                >
                  {t("fileTree.create")}
                </button>
                <button
                  type="button"
                  disabled={creatingRootBusy}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onCreateRootCancel?.()}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "var(--text-secondary)",
                    borderRadius: "6px",
                    padding: "4px 6px",
                    fontSize: "11px",
                    cursor: creatingRootBusy ? "not-allowed" : "pointer",
                    opacity: creatingRootBusy ? 0.6 : 1,
                  }}
                >
                  {t("common.cancel")}
                </button>
              </div>
            )}
          </div>
        </li>
      ) : null}
      {sortDirectoryEntries(visibleEntries(items, depth), sortMode).map((entry) => {
        const isManagedRootNode = entry.is_root === true;
        const entryRoot = isManagedRootNode ? entry.path : branchRoot;
        const expandedKey = isManagedRootNode ? entry.path : `${entryRoot}:${entry.path}`;
        const isOpen = expandedSet.has(expandedKey);

        const cKey = childKeyFor(entry, entryRoot);
        const children = childrenByPath[cKey] ?? [];

        const isCurrentRootNode = isManagedRootNode && entry.path === rootId;
        // 普通目录沿用 selectedDirKey；当前 managed root 永远跟随 current root 高亮。
        const isSelected =
          entry.is_dir
            ? isCurrentRootNode || selectedDirKey === expandedKey
            : entry.path === selectedPath && entryRoot === rootId;

        const meta = fileMetas[entry.path];
        const hasSessionLink = !entry.is_dir && meta?.source_session;
        const isFromActiveSession = hasSessionLink && meta.source_session === activeSessionKey;
        const rootIndicator = isManagedRootNode
          ? rootSessionIndicators[entry.path] || {}
          : null;
        const showRootIndicator = !!rootIndicator?.bound;
        const isRootPending = !!rootIndicator?.pending;
        const handleEntryClick = () => {
          if (entry.is_dir) {
            if (isManagedRootNode) {
              (onSelectRoot || onToggleDir)?.(entry, entryRoot);
              return;
            }
            onToggleDir?.(entry, entryRoot);
            return;
          }
          onSelectFile?.(entry, entryRoot);
        };
        const handleDirectoryIconClick = (event: React.MouseEvent<HTMLSpanElement>) => {
          if (!entry.is_dir) {
            return;
          }
          event.stopPropagation();
          onToggleDir?.(entry, entryRoot);
        };

        const rootExtraContent = isManagedRootNode
          ? projectTreeTab === "git"
            ? renderRootExtraContent?.(entry.path)
            : projectTreeTab === "worktrees"
              ? renderRootWorktreeContent?.(entry.path)
            : projectTreeTab === "related"
              ? renderRootRelatedContent?.(entry.path)
              : null
          : null;
        const shouldRenderChildren = projectTreeTab === "files" || !isManagedRootNode;

        return (
          <li key={expandedKey}>
            <button
              type="button"
              onClick={handleEntryClick}
              style={{
                border: "none",
                background: isSelected ? "var(--selection-bg)" : "transparent",
                cursor: "pointer",
                padding: "6px 8px",
                paddingLeft: PROJECT_TREE_ROOT_PADDING_LEFT + depth * PROJECT_TREE_INDENT,
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
              <span
                onClick={handleDirectoryIconClick}
                title={entry.is_dir ? (isOpen ? t("common.collapse") : t("common.expand")) : undefined}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: "4px",
                  cursor: entry.is_dir ? "pointer" : "default",
                }}
              >
                <DirectoryIconSlot entry={entry} isOpen={isOpen} />
              </span>
              <span
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  flex: 1,
                  marginLeft: "4px",
                }}
              >
                <span
                  style={{
                    ...(isManagedRootNode ? rootBadgeStyle : {}),
                    maxWidth: "100%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {entry.name}
                </span>
              </span>
              {showRootIndicator ? (
                <span
                  aria-label={isRootPending ? t("fileTree.boundSessionReplying") : t("fileTree.boundSession")}
                  title={isRootPending ? t("fileTree.boundSessionReplying") : t("fileTree.boundSession")}
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "999px",
                    flexShrink: 0,
                    boxSizing: "border-box",
                    border: "1.5px solid #2563eb",
                    background: isRootPending ? "#2563eb" : "transparent",
                    animation: isRootPending ? "mindfs-bound-pulse 2.2s ease-in-out infinite" : "none",
                    boxShadow: isRootPending
                      ? "0 0 0 1.5px rgba(37,99,235,0.14)"
                      : "0 0 0 1px rgba(37,99,235,0.10)",
                  }}
                />
              ) : null}
              {hasSessionLink && (
                <span style={{ fontSize: "10px", color: isFromActiveSession ? "#3b82f6" : "#9ca3af" }}>
                  {isFromActiveSession ? "◆" : "◇"}
                </span>
              )}
            </button>
            {entry.is_dir && isOpen && shouldRenderChildren && children.length > 0 ? renderEntries(children, depth + 1, entryRoot) : null}
            {entry.is_dir && isOpen && rootExtraContent ? (
              <div style={{ padding: `2px 4px 8px ${PROJECT_TREE_INDENT}px` }}>
                {rootExtraContent}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ position: "relative", height: "36px", padding: "0 3px", borderBottom: "1px solid var(--border-color)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--mindfs-topbar-bg, transparent)", boxSizing: "border-box", flexShrink: 0, gap: 6, overflow: "visible" }}>
        <div style={{ display: "flex", alignItems: "center", minWidth: 0, flex: "1 1 auto", maxWidth: "calc(100% - 34px)" }}>
          <div
            role="tablist"
            data-onboarding="project-tabs"
            aria-label={t("fileTree.projectTabs")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 0,
              padding: "2px",
              borderRadius: "8px",
              border: "1px solid rgba(100, 116, 139, 0.36)",
              background: "rgba(148, 163, 184, 0.10)",
              minWidth: 0,
              width: "100%",
            }}
          >
            {([
              ["files", t("fileTree.files")],
              ["git", "git"],
              ["worktrees", t("fileTree.worktrees")],
              ["related", t("fileTree.relatedFiles")],
            ] as const).map(([value, label], index) => {
              const active = projectTreeTab === value;
              const flexGrow = value === "related" ? 1.45 : value === "worktrees" ? 1.15 : 0.85;
              return (
                <React.Fragment key={value}>
                  {index > 0 ? (
                    <span
                      aria-hidden="true"
                      style={{
                        width: "1px",
                        height: "16px",
                        background: "rgba(100, 116, 139, 0.32)",
                        margin: "0 1px",
                        flexShrink: 0,
                      }}
                    />
                  ) : null}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setProjectTreeTab(value)}
                    style={{
                      border: "none",
                      borderRadius: "6px",
                      background: active ? "var(--accent-color)" : "transparent",
                      color: active ? "#fff" : "var(--text-secondary)",
                      padding: "3px 5px",
                      fontSize: "11px",
                      fontWeight: 700,
                      lineHeight: "14px",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      minWidth: 0,
                      flex: `${flexGrow} 1 auto`,
                      boxShadow: active ? "0 1px 3px rgba(37, 99, 235, 0.28)" : "none",
                    }}
                  >
                    {label}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        </div>
        <div ref={menuRef} style={{ position: "relative", flexShrink: 0 }}>
          <button
            type="button"
            data-onboarding="sidebar-menu"
            onClick={() => {
              setIsMenuOpen((open) => {
                const nextOpen = !open;
                if (nextOpen) {
                  setIsAppearanceMenuOpen(false);
                  setIsLocaleMenuOpen(false);
                  setIsSortMenuOpen(false);
                }
                return nextOpen;
              });
            }}
            aria-label={t("fileTree.menu.open")}
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
                <button
                  type="button"
                  onClick={() => {
                    if (onOpenProjectAdd) {
                      onOpenProjectAdd();
                    } else {
                      onCreateRootStart?.();
                    }
                    setIsMenuOpen(false);
                    setIsAppearanceMenuOpen(false);
                    setIsLocaleMenuOpen(false);
                    setIsSortMenuOpen(false);
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
                  <span>{t("fileTree.addProject")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => openAgentConfigFlow("backup")}
                  style={fileTreeMenuButtonStyle}
                >
                  <ConfigArchiveIcon />
                  <span>{t("fileTree.addAgentConfig")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => openAgentConfigFlow("switch")}
                  style={fileTreeMenuButtonStyle}
                >
                  <ConfigSwitchIcon />
                  <span>{t("fileTree.switchAgentConfig")}</span>
                </button>
                <button
                  type="button"
                  onClick={openAgentLifecycleFlow}
                  style={fileTreeMenuButtonStyle}
                >
                  <AgentInstallIcon />
                  <span>{t("fileTree.agentInstallUpdate")}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRelayServicesOpen(true);
                    setRelayServicesEditing(false);
                    closeAgentConfigFlow();
                    setAgentLifecycleOpen(false);
                    setIsMenuOpen(false);
                    setIsAppearanceMenuOpen(false);
                    setIsLocaleMenuOpen(false);
                    setIsSortMenuOpen(false);
                  }}
                  style={fileTreeMenuButtonStyle}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 17V7a2 2 0 0 1 2-2h6" />
                    <path d="M8 21h8a2 2 0 0 0 2-2v-6" />
                    <path d="M14 3h7v7" />
                    <path d="m21 3-9 9" />
                  </svg>
                  <span>{t("fileTree.relayLocalServices")}</span>
                </button>
                {!isNativeApp ? <WebPushMenuItem /> : null}
                <div style={{ height: "1px", background: "var(--border-color)", margin: "6px 4px" }} />
                <button
                  type="button"
                  onClick={() => {
                    setIsAppearanceMenuOpen((open) => !open);
                    setIsLocaleMenuOpen(false);
                    setIsSortMenuOpen(false);
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
                  aria-expanded={isAppearanceMenuOpen}
                >
                  <span style={{ flex: 1 }}>{t("appearance.title")}</span>
                  <span style={{ color: "var(--text-secondary)", fontSize: "11px" }}>
                    {t(APPEARANCE_OPTIONS.find((option) => option.value === appearanceMode)?.labelKey || "appearance.system")}
                  </span>
                  <ChevronRight isOpen={isAppearanceMenuOpen} />
                </button>
                {isAppearanceMenuOpen ? APPEARANCE_OPTIONS.map((option) => {
                  const active = option.value === appearanceMode;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        setAppearanceMode(option.value);
                        setAppearanceModeState(option.value);
                        setIsMenuOpen(false);
                        setIsAppearanceMenuOpen(false);
                        setIsLocaleMenuOpen(false);
                        setIsSortMenuOpen(false);
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
                      <span>{t(option.labelKey)}</span>
                      <span style={{ fontSize: "11px", opacity: active ? 1 : 0 }}>✓</span>
                    </button>
                  );
                }) : null}
                <button
                  type="button"
                  onClick={() => {
                    setIsLocaleMenuOpen((open) => !open);
                    setIsAppearanceMenuOpen(false);
                    setIsSortMenuOpen(false);
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
                  aria-expanded={isLocaleMenuOpen}
                >
                  <span style={{ flex: 1 }}>{t("locale.language")}</span>
                  <span style={{ color: "var(--text-secondary)", fontSize: "11px" }}>
                    {t(LOCALE_OPTIONS.find((option) => option.value === locale)?.labelKey || "locale.zhCN")}
                  </span>
                  <ChevronRight isOpen={isLocaleMenuOpen} />
                </button>
                {isLocaleMenuOpen ? LOCALE_OPTIONS.map((option) => {
                  const active = option.value === locale;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => {
                        setLocale(option.value);
                        setIsMenuOpen(false);
                        setIsAppearanceMenuOpen(false);
                        setIsLocaleMenuOpen(false);
                        setIsSortMenuOpen(false);
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
                      <span>{t(option.labelKey)}</span>
                      <span style={{ fontSize: "11px", opacity: active ? 1 : 0 }}>✓</span>
                    </button>
                  );
                }) : null}
                <div style={{ height: "1px", background: "var(--border-color)", margin: "6px 4px" }} />
                <button
                  type="button"
                  onClick={() => {
                    setIsSortMenuOpen((open) => !open);
                    setIsAppearanceMenuOpen(false);
                    setIsLocaleMenuOpen(false);
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
                  aria-expanded={isSortMenuOpen}
                >
                  <span style={{ flex: 1 }}>{t("fileTree.globalSort")}</span>
                  <span style={{ color: "var(--text-secondary)", fontSize: "11px" }}>
                    {sortLabel(sortMode)}
                  </span>
                  <ChevronRight isOpen={isSortMenuOpen} />
                </button>
                {isSortMenuOpen ? DIRECTORY_SORT_OPTIONS.map((option) => {
                const active = option.value === sortMode;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      onSortModeChange?.(option.value as DirectorySortMode);
                      setIsMenuOpen(false);
                      setIsAppearanceMenuOpen(false);
                      setIsLocaleMenuOpen(false);
                      setIsSortMenuOpen(false);
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
                    <span>{sortLabel(option.value as DirectorySortMode)}</span>
                    <span style={{ fontSize: "11px", opacity: active ? 1 : 0 }}>✓</span>
                  </button>
                );
              }) : null}
              <div style={{ height: "1px", background: "var(--border-color)", margin: "6px 4px" }} />
              {onStartOnboarding ? (
                <button
                  type="button"
                  onClick={() => {
                    onStartOnboarding();
                    setIsMenuOpen(false);
                    setIsAppearanceMenuOpen(false);
                    setIsLocaleMenuOpen(false);
                    setIsSortMenuOpen(false);
                  }}
                  style={fileTreeMenuButtonStyle}
                >
                  <OnboardingGuideIcon />
                  <span>{t("onboarding.menu")}</span>
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  onShowHiddenFilesChange?.(!showHiddenFiles);
                  setIsAppearanceMenuOpen(false);
                  setIsSortMenuOpen(false);
                }}
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
                <span>{t("fileTree.showHiddenFiles")}</span>
                <span style={{ fontSize: "11px", opacity: showHiddenFiles ? 1 : 0 }}>✓</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onMultiProjectSessionsChange?.(!multiProjectSessionsEnabled);
                  setIsAppearanceMenuOpen(false);
                  setIsSortMenuOpen(false);
                }}
                style={{
                  width: "100%",
                  border: "none",
                  background: multiProjectSessionsEnabled ? "var(--selection-bg)" : "transparent",
                  color: multiProjectSessionsEnabled ? "var(--accent-color)" : "var(--text-primary)",
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
                <span>{t("fileTree.multiProjectSessions")}</span>
                <span style={{ fontSize: "11px", opacity: multiProjectSessionsEnabled ? 1 : 0 }}>✓</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onSidebarsSwappedChange?.(!sidebarsSwapped);
                  setIsAppearanceMenuOpen(false);
                  setIsSortMenuOpen(false);
                }}
                style={{
                  width: "100%",
                  border: "none",
                  background: sidebarsSwapped ? "var(--selection-bg)" : "transparent",
                  color: sidebarsSwapped ? "var(--accent-color)" : "var(--text-primary)",
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
                <span>{t("fileTree.swapSidebars")}</span>
                <span style={{ fontSize: "11px", opacity: sidebarsSwapped ? 1 : 0 }}>✓</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onGitDiffSideBySideChange?.(!gitDiffSideBySide);
                  setIsAppearanceMenuOpen(false);
                  setIsSortMenuOpen(false);
                }}
                style={{
                  width: "100%",
                  border: "none",
                  background: gitDiffSideBySide ? "var(--selection-bg)" : "transparent",
                  color: gitDiffSideBySide ? "var(--accent-color)" : "var(--text-primary)",
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
                <span>{t("fileTree.sideBySideDiff")}</span>
                <span style={{ fontSize: "11px", opacity: gitDiffSideBySide ? 1 : 0 }}>✓</span>
              </button>
              {showEnterKeySendOption ? (
                <button
                  type="button"
                  onClick={() => {
                    onEnterKeySendsChange?.(!enterKeySends);
                    setIsAppearanceMenuOpen(false);
                    setIsSortMenuOpen(false);
                  }}
                  style={{
                    width: "100%",
                    border: "none",
                    background: enterKeySends ? "var(--selection-bg)" : "transparent",
                    color: enterKeySends ? "var(--accent-color)" : "var(--text-primary)",
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
                  <span>{t("fileTree.enterKeySend")}</span>
                  <span style={{ fontSize: "11px", opacity: enterKeySends ? 1 : 0 }}>✓</span>
                </button>
              ) : null}
            </div>
          ) : null}
          {projectAddOverlay ? (
            <div
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                right: 0,
                zIndex: 30,
              }}
            >
              {projectAddOverlay}
            </div>
          ) : null}
        </div>
        {agentConfigFlow ? (
          <div
            ref={agentConfigPopoverRef}
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              left: "8px",
              right: "3px",
              zIndex: 35,
            }}
          >
            <AgentConfigPopover
              flow={agentConfigFlow}
              step={agentConfigStep}
              agents={agentConfigAgents}
              selectedAgent={agentConfigAgent}
              addTab={agentConfigAddTab}
              switchTab={agentConfigSwitchTab}
              backupName={agentConfigName}
              fileSourcesBody={agentConfigFileSourcesBody}
              envBody={agentConfigEnvBody}
              apiProviderName={agentAPIProviderName}
              apiProviderBaseURL={agentAPIProviderBaseURL}
              apiProviderAPIKey={agentAPIProviderAPIKey}
              backups={agentConfigBackups}
              apiProviders={agentAPIProviders}
              selectedBackupID={selectedAgentConfigID}
              selectedAPIProviderID={selectedAgentAPIProviderID}
              confirmMessage={agentConfigConfirmMessage}
              busy={agentConfigBusy}
              restartingAgent={agentConfigRestartingAgent}
              error={agentConfigError}
              onChooseAgent={(name) => {
                void chooseAgentForConfig(name);
              }}
              onAddTabChange={setAgentConfigAddTab}
              onSwitchTabChange={setAgentConfigSwitchTab}
              onBackupNameChange={setAgentConfigName}
              onFileSourcesChange={setAgentConfigFileSourcesBody}
              onEnvBodyChange={setAgentConfigEnvBody}
              onAPIProviderNameChange={setAgentAPIProviderName}
              onAPIProviderBaseURLChange={setAgentAPIProviderBaseURL}
              onAPIProviderAPIKeyChange={setAgentAPIProviderAPIKey}
              onSelectedBackupChange={selectAgentConfigBackup}
              onSelectedAPIProviderChange={selectAgentAPIProvider}
              onDeleteBackup={(id) => {
                void deleteSelectedAgentConfigBackup(id);
              }}
              onDeleteAPIProvider={(id) => {
                void deleteSelectedAgentAPIProvider(id);
              }}
              onSave={() => {
                if (agentConfigAddTab === "api") {
                  void saveAgentAPIProvider();
                  return;
                }
                void saveAgentConfigBackup();
              }}
              onSwitch={() => {
                void runAgentConfigSwitch(false);
              }}
              onRestartAgent={agentConfigFlow === "switch" ? restartAgentFromConfigList : undefined}
              onConfirm={() => {
                if (agentConfigFlow === "backup") {
                  void saveAgentConfigBackup(true);
                  return;
                }
                void runAgentConfigSwitch(true);
              }}
              onCancel={closeAgentConfigFlow}
            />
          </div>
        ) : null}
        {relayServicesOpen ? (
          <div
            ref={relayServicesPopoverRef}
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              left: "8px",
              right: "3px",
              zIndex: 35,
            }}
          >
            <RelayLocalServicesDialog
              open={relayServicesOpen}
              nodeId={relayNodeId}
              relayBaseURL={relayBaseURL}
              noRelayer={relayNoRelayer}
              onCancel={closeRelayServices}
              onEditingChange={setRelayServicesEditing}
            />
          </div>
        ) : null}
        {agentLifecycleOpen ? (
          <div
            ref={agentLifecyclePopoverRef}
            style={{
              position: "absolute",
              top: "calc(100% + 6px)",
              left: "8px",
              right: "3px",
              zIndex: 35,
            }}
          >
            <AgentLifecyclePopover
              agents={agentLifecycleAgents}
              busy={agentLifecycleBusy}
              runningAgent={agentLifecycleRunningAgent}
              error={agentLifecycleError}
              onRun={(agent, action) => {
                void runAgentLifecycleCommand(agent, action);
              }}
            />
          </div>
        ) : null}
      </div>
      <div style={{ padding: "8px", flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
        {entries.length === 0 && creatingRootName === null ? (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "20px",
              textAlign: "center",
              color: "var(--text-secondary)",
              fontSize: "13px",
              fontWeight: 800,
              lineHeight: 1.5,
            }}
          >
            {t("fileTree.emptyProjectHint")}
          </div>
        ) : (
          renderEntries(entries, 0, rootId || "")
        )}
      </div>
      <div
        data-mindfs-filetree-footer="1"
        style={{
          padding: hasFooterContent ? "10px 12px 12px" : "0",
          borderTop: hasFooterContent ? "1px solid var(--border-color)" : "none",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
          flexShrink: 0,
        }}
      >
        {updateActionLabel ? (
          <div ref={updateNotesRef} style={{ position: "relative" }}>
            {isUpdateNotesOpen && updateActionSummary ? (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: "calc(100% + 8px)",
                  border: "1px solid var(--border-color)",
                  background: "var(--panel-bg)",
                  borderRadius: "12px",
                  padding: "12px",
                  boxShadow: "0 18px 36px rgba(15, 23, 42, 0.18)",
                  fontSize: "11px",
                  color: "var(--text-secondary)",
                  lineHeight: 1.55,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: "220px",
                  overflow: "auto",
                  zIndex: 10,
                }}
              >
                {updateActionSummary}
              </div>
            ) : null}
            <div
              style={{
                display: "flex",
                alignItems: "stretch",
                width: "100%",
                border: "1px solid var(--border-color)",
                background: updateActionDisabled ? "rgba(148, 163, 184, 0.2)" : "var(--accent-color)",
                color: updateActionDisabled ? "var(--text-secondary)" : "#fff",
                borderRadius: "10px",
                overflow: "hidden",
              }}
            >
              <button
                type="button"
                disabled={updateActionDisabled}
                onClick={() => onUpdateAction?.()}
                title={updateActionHelp || undefined}
                style={{
                  flex: 1,
                  border: "none",
                  background: "transparent",
                  color: "inherit",
                  padding: "10px 12px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                  cursor: updateActionDisabled ? "not-allowed" : "pointer",
                  fontSize: "12px",
                  fontWeight: 600,
                }}
              >
                {updateActionBusy ? (
                  <span
                    style={{
                      width: "12px",
                      height: "12px",
                      borderRadius: "50%",
                      border: "2px solid currentColor",
                      borderRightColor: "transparent",
                      display: "inline-block",
                      animation: "mindfs-update-spin 0.9s linear infinite",
                    }}
                  />
                ) : null}
                <span>{updateActionLabel}</span>
              </button>
              {updateActionSummary ? (
                <button
                  type="button"
                  aria-label={isUpdateNotesOpen ? t("fileTree.hideUpdateNotes") : t("fileTree.showUpdateNotes")}
                  aria-expanded={isUpdateNotesOpen}
                  onClick={() => setIsUpdateNotesOpen((open) => !open)}
                  style={{
                    width: "34px",
                    border: "none",
                    background: "transparent",
                    color: "inherit",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                      transform: isUpdateNotesOpen ? "rotate(180deg)" : "rotate(0deg)",
                      transition: "transform 0.15s ease",
                    }}
                  >
                    <polyline points="6 15 12 9 18 15" />
                  </svg>
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {updateActionHelp && !updateActionLabel ? (
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", lineHeight: 1.5, textAlign: "center" }}>
            {updateActionHelp}
          </div>
        ) : null}
        {shouldShowRelayTip && relayTip ? (
          <div
            style={{
              position: "relative",
              border:
                "1px solid color-mix(in srgb, var(--accent-color) 18%, var(--border-color))",
              background:
                "linear-gradient(180deg, color-mix(in srgb, var(--sidebar-bg) 94%, var(--accent-color) 6%), color-mix(in srgb, var(--sidebar-bg) 88%, var(--accent-color) 12%))",
              boxShadow:
                "0 8px 24px color-mix(in srgb, var(--accent-color) 10%, transparent)",
              borderRadius: "8px",
              padding: "10px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "10px" }}>
              <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: "4px", flex: 1, paddingRight: relayTip.dismissible !== false ? "14px" : 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", minWidth: 0, flex: 1 }}>
                    {relayTip.badge ? (
                      <span
                        style={{
                          padding: "2px 6px",
                          borderRadius: "999px",
                          background:
                            "color-mix(in srgb, var(--accent-color) 14%, transparent)",
                          color: "var(--accent-color)",
                          fontSize: "10px",
                          fontWeight: 700,
                          lineHeight: 1.4,
                        }}
                      >
                        {relayTip.badge}
                      </span>
                    ) : null}
                    {relayTip.eyebrow ? (
                      <span style={{ fontSize: "10px", fontWeight: 700, color: "var(--text-secondary)", lineHeight: 1.4 }}>
                        {relayTip.eyebrow}
                      </span>
                    ) : null}
                </div>
                <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.35 }}>
                  {relayTip.title}
                </div>
                {relayTip.description ? (
                  <div style={{ fontSize: "11px", color: "var(--text-secondary)", lineHeight: 1.45 }}>
                    {relayTip.description}
                  </div>
                ) : null}
              </div>
              {relayTip.dismissible !== false ? (
                <button
                  type="button"
                  aria-label={t("fileTree.closeAd")}
                  onClick={dismissRelayTip}
                  style={{
                    position: "absolute",
                    top: "6px",
                    right: "6px",
                    border: "none",
                    background: "transparent",
                    color: "var(--text-secondary)",
                    width: "20px",
                    height: "20px",
                    borderRadius: "6px",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    flexShrink: 0,
                    padding: 0,
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
            {(relayTip.href && relayTip.cta_label) || shouldShowNextRelayTip ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" }}>
                <div>
                  {relayTip.href && relayTip.cta_label ? (
                    <button
                      type="button"
                      onClick={openRelayTip}
                      style={{
                        alignSelf: "flex-start",
                        border: "none",
                        background: "transparent",
                        color: "var(--accent-color)",
                        borderRadius: "6px",
                        padding: "0",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: "4px",
                        cursor: "pointer",
                        fontSize: "11px",
                        fontWeight: 600,
                        lineHeight: 1,
                      }}
                    >
                      <span>{relayTip.cta_label}</span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M5 12h14" />
                        <path d="m13 5 7 7-7 7" />
                      </svg>
                    </button>
                  ) : null}
                </div>
                {shouldShowNextRelayTip ? (
                  <button
                    type="button"
                    aria-label={t("fileTree.nextTip")}
                    onClick={showNextRelayTip}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: "var(--accent-color)",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "4px",
                      cursor: "pointer",
                      flexShrink: 0,
                      padding: 0,
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12h14" />
                      <path d="m13 5 7 7-7 7" />
                    </svg>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {footerTopContent ? (
          <div style={{ width: "100%" }}>{footerTopContent}</div>
        ) : null}
        {shouldShowInstallButton ? (
          relayActionLabel ? (
            <button
              type="button"
              disabled={relayActionDisabled}
              onClick={() => onRelayAction?.()}
              style={{
                width: "100%",
                border: "1px solid var(--border-color)",
                background: relayActionDisabled ? "rgba(148, 163, 184, 0.2)" : "var(--accent-color)",
                color: relayActionDisabled ? "var(--text-secondary)" : "#fff",
                borderRadius: "10px",
                padding: "10px 12px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                cursor: relayActionDisabled ? "not-allowed" : "pointer",
                fontSize: "12px",
                fontWeight: 600,
              }}
            >
              <span>{relayActionLabel}</span>
            </button>
          ) : null
        ) : relayActionLabel ? (
          <button
            type="button"
            disabled={relayActionDisabled}
            onClick={() => onRelayAction?.()}
            style={{
              width: "100%",
              border: "1px solid var(--border-color)",
              background: relayActionDisabled ? "rgba(148, 163, 184, 0.2)" : "var(--accent-color)",
              color: relayActionDisabled ? "var(--text-secondary)" : "#fff",
              borderRadius: "10px",
              padding: "10px 12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
              cursor: relayActionDisabled ? "not-allowed" : "pointer",
              fontSize: "12px",
              fontWeight: 600,
            }}
          >
            <span>{relayActionLabel}</span>
          </button>
        ) : null}
        {relayActionHelp ? (
          <div style={{ fontSize: "11px", color: "var(--text-secondary)", lineHeight: 1.5, textAlign: "center" }}>
            {relayActionHelp}
          </div>
        ) : null}
        {isNativeApp && onGoHome ? (
          <button
            type="button"
            onClick={() => onGoHome()}
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
            }}
          >
            <span>{t("fileTree.goHome")}</span>
          </button>
        ) : null}
        {shouldShowInstallButton ? (
          <button
            type="button"
            onClick={() => { void handleInstall(); }}
            style={{
              width: "100%",
              border:
                "1px solid color-mix(in srgb, var(--accent-color) 72%, var(--border-color))",
              background: "var(--accent-color)",
              color: "#fff",
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
      <style>{`
        @keyframes mindfs-update-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes mindfs-bound-pulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 1.5px rgba(37,99,235,0.14); }
          50% { opacity: 0.18; box-shadow: 0 0 0 4px rgba(37,99,235,0.08); }
        }
      `}</style>
    </div>
  );
}
