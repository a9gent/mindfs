import { common, Want } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import preferences from '@ohos.data.preferences';
import { hilog } from '@kit.PerformanceAnalysisKit';
import bundleManager from '@ohos.bundle.bundleManager';
import cryptoFramework from '@ohos.security.cryptoFramework';
import environment from '@ohos.file.environment';
import fileIo from '@ohos.file.fs';
import http from '@ohos.net.http';
import notificationManager from '@ohos.notificationManager';
import pasteboard from '@ohos.pasteboard';
import util from '@ohos.util';
import vibrator from '@ohos.vibrator';
import wantAgent from '@ohos.wantAgent';
import type { WantAgent } from '@ohos.wantAgent';

interface LauncherNode {
  id: string;
  name: string;
  url: string;
  createdAt: string;
  lastOpenedAt?: string;
}

interface DownloadInput {
  url?: string;
  filename?: string;
  dataBase64?: string;
  mimeType?: string;
}

interface ReplyPollerConfig {
  apiBaseUrl?: string;
  token?: string;
  e2eeRequired?: boolean;
  e2eeNodeId?: string;
  e2eeClientId?: string;
  e2eeTransportKey?: string;
}

interface AppInfoOutput {
  version: string;
  build: string;
}

interface ScheduledOutput {
  scheduled: boolean;
}

interface NodesOutput {
  nodes: Array<LauncherNode>;
  count: number;
}

interface SetNodesInput {
  nodes?: Array<LauncherNode>;
}

interface StoredOutput {
  stored: boolean;
  count: number;
}

interface SafeAreaOutput {
  top: number;
  bottom: number;
}

interface ErrorWithCode {
  name?: string;
  message?: string;
  code?: number | string;
}

interface ReplyState {
  sessionKey: string;
  rootId: string;
  rootTitle: string;
  sessionTitle: string;
  summary: string;
  updatedAt: string;
  status: 'replying' | 'completed';
}

interface ReplyingSessionsResponse {
  sessions?: Array<ReplyState>;
}

interface CipherEnvelope {
  nonce?: string;
  ciphertext?: string;
}

interface PendingReplySession {
  rootId: string;
  sessionKey: string;
}

const KEY_PENDING_RELAY_NODES = 'pendingRelayNodes';
const KEY_LAUNCHER_NODES = 'launcherNodes';
const KEY_CLEAR_WEBVIEW_CACHE = 'clearWebViewCacheOnNextLaunch';
const KEY_REPLY_POLLER_CONFIG = 'replyPollerConfig';
const DOMAIN = 0x4d46;
const REPLY_ALERT_SOUND_RAWFILE = 'mindfs_reply_alert.wav';
const PREFERENCES_NAME = 'mindfs_native_bridge';
const E2EE_HEADER = 'X-MindFS-E2EE';
const CLIENT_ID_HEADER = 'X-MindFS-Client-ID';
const PROOF_HEADER = 'X-MindFS-Proof';
const TS_HEADER = 'X-MindFS-TS';

export class MindFSNativeBridge {
  private static activeBridge?: MindFSNativeBridge;
  private static appForeground: boolean = true;
  private static safeAreaTop: number = 0;
  private static safeAreaBottom: number = 0;
  private static pendingReplySession?: PendingReplySession;
  private static pendingReplySessionCreatedAt: number = 0;
  private static pendingReplySessionDispatcher?: (rawSession: string) => void;
  private static replyPollerConfigSyncer?: (reason: string, done: () => void) => void;

  platform: string = 'harmony';
  private store: Map<string, string> = new Map<string, string>();
  private preferences?: preferences.Preferences;
  private context?: common.UIAbilityContext;
  private nextNotificationId: number = 3000;
  private notificationPermissionRequested: boolean = false;
  private replyPollTimerId: number = -1;
  private replyPollRunning: boolean = false;
  private replyStates: Map<string, ReplyState> = new Map<string, ReplyState>();
  private completedReplyKeys: Set<string> = new Set<string>();
  private publishedNotificationSignatures: Map<number, string> = new Map<number, string>();
  private nodeViewActive: boolean = false;

  constructor() {
    MindFSNativeBridge.activeBridge = this;
  }

  setContext(context: common.UIAbilityContext): void {
    this.context = context;
    MindFSNativeBridge.activeBridge = this;
    this.ensurePreferences();
  }

  static resumeConfiguredReplyPolling(reason: string): void {
    const bridge = MindFSNativeBridge.activeBridge;
    if (!bridge) {
      hilog.warn(DOMAIN, 'MindFS', 'reply poller resume skipped: no active bridge, reason=%{public}s', reason);
      console.warn(`MindFS reply poller resume skipped: no active bridge (${reason})`);
      return;
    }
    const syncer = MindFSNativeBridge.replyPollerConfigSyncer;
    if (syncer) {
      let resumed = false;
      const resume = (): void => {
        if (resumed) {
          return;
        }
        resumed = true;
        bridge.resumeStoredReplyPolling(reason);
      };
      try {
        syncer(reason, resume);
        setTimeout(resume, 500);
        return;
      } catch (error) {
        hilog.warn(DOMAIN, 'MindFS', 'reply poller config sync before resume failed: %{public}s', JSON.stringify(error));
      }
    }
    bridge.resumeStoredReplyPolling(reason);
  }

  static setAppForeground(foreground: boolean): void {
    MindFSNativeBridge.appForeground = foreground;
    const bridge = MindFSNativeBridge.activeBridge;
    if (bridge && foreground) {
      bridge.stopReplyPolling();
      bridge.clearReplyStateAndNotifications('foreground');
    }
  }

  static setSystemSafeArea(top: number, bottom: number): void {
    MindFSNativeBridge.safeAreaTop = Math.max(0, Math.round(top));
    MindFSNativeBridge.safeAreaBottom = Math.max(0, Math.round(bottom));
  }

  static setPendingReplySessionDispatcher(dispatcher?: (rawSession: string) => void): void {
    MindFSNativeBridge.pendingReplySessionDispatcher = dispatcher;
    const pending = MindFSNativeBridge.pendingReplySession;
    if (dispatcher && pending) {
      dispatcher(JSON.stringify(pending));
    }
  }

  static setReplyPollerConfigSyncer(syncer?: (reason: string, done: () => void) => void): void {
    MindFSNativeBridge.replyPollerConfigSyncer = syncer;
  }

  static handleLaunchWant(want?: Want): void {
    const rootId = `${want?.parameters?.['rootId'] ?? ''}`.trim();
    const sessionKey = `${want?.parameters?.['sessionKey'] ?? ''}`.trim();
    if (!rootId || !sessionKey) {
      return;
    }
    MindFSNativeBridge.pendingReplySession = { rootId, sessionKey };
    MindFSNativeBridge.pendingReplySessionCreatedAt = Date.now();
    MindFSNativeBridge.pendingReplySessionDispatcher?.(JSON.stringify(MindFSNativeBridge.pendingReplySession));
  }

  download(rawInput: string): string {
    const input = parseDownloadInput(rawInput);
    const url = `${input.url ?? ''}`.trim();
    const filename = sanitizeFilename(`${input.filename ?? ''}`.trim());
    if (!/^https?:\/\//i.test(url)) {
      return 'download url must be an absolute http/https URL';
    }
    if (!filename) {
      return 'download filename is required';
    }
    if (!this.context) {
      return 'Harmony context is not ready';
    }

    this.startDownload(url, filename);
    return '';
  }

  saveBase64(rawInput: string): string {
    const input = parseDownloadInput(rawInput);
    const dataBase64 = `${input.dataBase64 ?? ''}`.trim();
    const filename = sanitizeFilename(`${input.filename ?? ''}`.trim()) || 'download';
    if (!dataBase64) {
      return 'download content is empty';
    }
    try {
      const data = decodeBase64(dataBase64);
      const targetPath = uniqueDownloadPath(environment.getUserDownloadDir(), filename);
      const file = fileIo.openSync(
        targetPath,
        fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC
      );
      try {
        fileIo.writeSync(file.fd, data.buffer);
        fileIo.fsyncSync(file.fd);
      } finally {
        fileIo.closeSync(file);
      }
      return '';
    } catch (error) {
      return `Failed to save download: ${errorSummary(error)}`;
    }
  }

  openExternalURL(url: string): string {
    const value = `${url ?? ''}`.trim();
    if (!/^https?:\/\//i.test(value)) {
      return 'Only http:// and https:// URLs can be opened externally';
    }
    if (!this.context) {
      return 'Harmony context is not ready';
    }

    this.context.startAbility({
      action: 'ohos.want.action.viewData',
      uri: value
    }).catch((error: Error) => {
      console.warn(`MindFS open external URL failed: ${JSON.stringify(error)}`);
    });
    return '';
  }

  getAppInfo(): string {
    let version = '0.1.0';
    let build = '1';
    try {
      const bundleInfo = bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
      version = bundleInfo.versionName || version;
      build = `${bundleInfo.versionCode}`;
    } catch (error) {
      console.warn(`MindFS get bundle info failed: ${JSON.stringify(error)}`);
    }
    const output: AppInfoOutput = {
      version,
      build
    };
    return JSON.stringify(output);
  }

  configureReplyPoller(rawInput: string): string {
    const input = parseReplyPollerConfig(rawInput);
    const apiBaseUrl = `${input.apiBaseUrl ?? ''}`.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(apiBaseUrl)) {
      hilog.warn(DOMAIN, 'MindFS', 'configureReplyPoller rejected invalid apiBaseUrl=%{public}s', apiBaseUrl);
      console.warn(`MindFS configureReplyPoller rejected invalid apiBaseUrl=${apiBaseUrl}`);
      return 'apiBaseUrl is required';
    }
    const stored: ReplyPollerConfig = {
      apiBaseUrl,
      token: input.token,
      e2eeRequired: input.e2eeRequired,
      e2eeNodeId: input.e2eeNodeId,
      e2eeClientId: input.e2eeClientId,
      e2eeTransportKey: input.e2eeTransportKey
    };
    this.setStoreValue(KEY_REPLY_POLLER_CONFIG, JSON.stringify(stored));
    hilog.info(
      DOMAIN,
      'MindFS',
      'reply poller configured apiBaseUrl=%{public}s e2eeRequired=%{public}s e2eeReady=%{public}s foreground=%{public}s',
      apiBaseUrl,
      `${stored.e2eeRequired === true}`,
      `${hasReplyPollerE2EESession(stored)}`,
      `${MindFSNativeBridge.appForeground}`
    );

    this.ensureNotificationPermission();
    if (MindFSNativeBridge.appForeground) {
      this.stopReplyPolling();
      this.clearReplyNotifications('configure-foreground');
    } else {
      // The background lifecycle resumes polling after syncing the latest page config.
      // Starting here as well sends two immediate /api/replying-sessions requests.
      if (this.replyPollRunning) {
        this.startReplyPolling(stored);
      }
    }
    // Notification taps must eventually run JS:
    // window.dispatchEvent(new CustomEvent('mindfs:open-reply-session', { detail: { rootId, sessionKey } }))
    return '';
  }

  setNodeViewActive(active: boolean): void {
    this.nodeViewActive = active;
    if (active && MindFSNativeBridge.appForeground) {
      this.clearReplyNotifications('node-active');
    }
  }

  setAppVisibility(visibility: string): void {
    const visible = `${visibility ?? ''}` !== 'hidden';
    MindFSNativeBridge.setAppForeground(visible);
  }

  consumePendingReplySession(): string {
    const pending = MindFSNativeBridge.pendingReplySession;
    if (!pending) {
      return '';
    }
    if (Date.now() - MindFSNativeBridge.pendingReplySessionCreatedAt > 30000) {
      hilog.warn(DOMAIN, 'MindFS', 'pending reply session expired rootId=%{public}s sessionKey=%{public}s', pending.rootId, pending.sessionKey);
      MindFSNativeBridge.pendingReplySession = undefined;
      MindFSNativeBridge.pendingReplySessionCreatedAt = 0;
      return '';
    }
    MindFSNativeBridge.pendingReplySession = undefined;
    MindFSNativeBridge.pendingReplySessionCreatedAt = 0;
    this.clearReplyNotifications('consume-pending-reply-session');
    return JSON.stringify(pending);
  }

  markClearWebViewCacheOnNextLaunch(): string {
    this.setStoreValue(KEY_CLEAR_WEBVIEW_CACHE, '1');
    const output: ScheduledOutput = { scheduled: true };
    return JSON.stringify(output);
  }

  clearPendingWebViewCacheClear(): string {
    this.deleteStoreValue(KEY_CLEAR_WEBVIEW_CACHE);
    const output: ScheduledOutput = { scheduled: false };
    return JSON.stringify(output);
  }

  consumeRelayNodes(): string {
    const raw = this.getStoreValue(KEY_PENDING_RELAY_NODES, '[]');
    const nodes = parseLauncherNodes(raw);
    this.deleteStoreValue(KEY_PENDING_RELAY_NODES);
    const output: NodesOutput = {
      nodes,
      count: nodes.length
    };
    return JSON.stringify(output);
  }

  getLauncherNodes(): string {
    const nodes = parseLauncherNodes(this.getStoreValue(KEY_LAUNCHER_NODES, '[]'));
    const output: NodesOutput = {
      nodes,
      count: nodes.length
    };
    return JSON.stringify(output);
  }

  getSystemSafeArea(): string {
    const output: SafeAreaOutput = {
      top: MindFSNativeBridge.safeAreaTop,
      bottom: MindFSNativeBridge.safeAreaBottom
    };
    return JSON.stringify(output);
  }

  setLauncherNodes(rawInput: string): string {
    const input = parseSetNodesInput(rawInput);
    const nodes = input.nodes ?? new Array<LauncherNode>();
    this.setStoreValue(KEY_LAUNCHER_NODES, JSON.stringify(nodes));
    const output: StoredOutput = {
      stored: true,
      count: nodes.length
    };
    return JSON.stringify(output);
  }

  storeRelayNodes(rawInput: string): string {
    const nodes = parseLauncherNodes(rawInput);
    this.setStoreValue(KEY_PENDING_RELAY_NODES, JSON.stringify(nodes));
    const launcherNodes = parseLauncherNodes(this.getStoreValue(KEY_LAUNCHER_NODES, '[]'));
    const mergedNodes = mergeRelayNodesIntoLauncherNodes(launcherNodes, nodes);
    this.setStoreValue(KEY_LAUNCHER_NODES, JSON.stringify(mergedNodes));
    hilog.info(DOMAIN, 'MindFS', 'storeRelayNodes count=%{public}d launcherCount=%{public}d', nodes.length, mergedNodes.length);
    const output: StoredOutput = {
      stored: true,
      count: nodes.length
    };
    return JSON.stringify(output);
  }

  writeClipboardText(text: string): boolean {
    try {
      const data = pasteboard.createPlainTextData(`${text ?? ''}`);
      pasteboard.getSystemPasteboard().setDataSync(data);
      return true;
    } catch (error) {
      console.warn(`MindFS clipboard write failed: ${JSON.stringify(error)}`);
      return false;
    }
  }

  private startDownload(url: string, filename: string): void {
    const notificationId = this.nextNotificationId++;
    void this.startDownloadAsync(url, filename, notificationId);
  }

  private ensurePreferences(): void {
    if (this.preferences || !this.context) {
      return;
    }
    try {
      this.preferences = preferences.getPreferencesSync(this.context, { name: PREFERENCES_NAME });
    } catch (error) {
      console.warn(`MindFS preferences unavailable: ${JSON.stringify(error)}`);
    }
  }

  private getStoreValue(key: string, fallback: string): string {
    this.ensurePreferences();
    try {
      const value = this.preferences?.getSync(key, fallback);
      if (typeof value === 'string') {
        this.store.set(key, value);
        return value;
      }
    } catch (error) {
      console.warn(`MindFS preferences get failed: ${key} ${JSON.stringify(error)}`);
    }
    return this.store.get(key) ?? fallback;
  }

  private setStoreValue(key: string, value: string): void {
    this.store.set(key, value);
    this.ensurePreferences();
    try {
      this.preferences?.putSync(key, value);
      this.preferences?.flushSync();
    } catch (error) {
      console.warn(`MindFS preferences set failed: ${key} ${JSON.stringify(error)}`);
    }
  }

  private deleteStoreValue(key: string): void {
    this.store.delete(key);
    this.ensurePreferences();
    try {
      this.preferences?.deleteSync(key);
      this.preferences?.flushSync();
    } catch (error) {
      console.warn(`MindFS preferences delete failed: ${key} ${JSON.stringify(error)}`);
    }
  }

  private async startDownloadAsync(url: string, filename: string, notificationId: number): Promise<void> {
    const context = this.context;
    if (!context) {
      return;
    }

    await this.ensureNotificationPermission();

    await this.publishBasicNotification(notificationId, '开始下载', filename, true, false);
    const requestTask = http.createHttp();
    let file: fileIo.File | undefined = undefined;
    let targetPath = '';
    try {
      targetPath = uniqueDownloadPath(environment.getUserDownloadDir(), filename);
      const response = await requestTask.request(url, {
        method: http.RequestMethod.GET,
        expectDataType: http.HttpDataType.ARRAY_BUFFER,
        connectTimeout: 10000,
        readTimeout: 120000
      });
      if (response.responseCode < 200 || response.responseCode >= 300) {
        throw new Error(`HTTP ${response.responseCode}`);
      }
      const data = response.result as ArrayBuffer;
      file = fileIo.openSync(
        targetPath,
        fileIo.OpenMode.WRITE_ONLY | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC
      );
      await fileIo.write(file.fd, data);
      await fileIo.fsync(file.fd);
      await this.publishBasicNotification(notificationId, '下载完成', `已保存到：${targetPath}`, false, true);
    } catch (error) {
      const detail = errorSummary(error);
      console.warn(`MindFS start download failed: ${detail}`);
      await this.publishBasicNotification(notificationId, '下载失败', `${filename}，${detail}`, false, true);
    } finally {
      if (file) {
        try {
          fileIo.closeSync(file);
        } catch (error) {
          console.warn(`MindFS close download file failed: ${errorSummary(error)}`);
        }
      }
      requestTask.destroy();
    }
  }

  private async ensureNotificationPermission(): Promise<void> {
    const context = this.context;
    if (!context || this.notificationPermissionRequested) {
      return;
    }
    this.notificationPermissionRequested = true;
    try {
      await notificationManager.requestEnableNotification(context);
    } catch (error) {
      hilog.warn(DOMAIN, 'MindFS', 'request notification permission failed: %{public}s', errorSummary(error));
      console.warn(`MindFS notification permission request failed: ${JSON.stringify(error)}`);
    }
  }

  private async publishBasicNotification(
    id: number,
    title: string,
    text: string,
    ongoing: boolean,
    alert: boolean,
    target?: PendingReplySession
  ): Promise<void> {
    try {
      const slotType = notificationManager.SlotType.SERVICE_INFORMATION;
      const signature = `${title}\n${text}\n${ongoing}\n${alert}\n${target?.rootId ?? ''}\n${target?.sessionKey ?? ''}`;
      if (this.publishedNotificationSignatures.get(id) === signature) {
        return;
      }

      await this.ensureNotificationPermission();
      const launchWantAgent: WantAgent | undefined = await this.createLaunchWantAgent(id, target);
      const notificationRequest: notificationManager.NotificationRequest = {
        id,
        notificationSlotType: slotType,
        isOngoing: ongoing,
        isAlertOnce: !alert,
        isFloatingIcon: true,
        notificationFlags: {
          soundEnabled: alert ? 1 : 2,
          vibrationEnabled: 2,
          bannerEnabled: alert ? 1 : 2
        },
        content: {
          notificationContentType: notificationManager.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
          normal: {
            title,
            text
          }
        }
      };
      if (alert && target) {
        notificationRequest.sound = REPLY_ALERT_SOUND_RAWFILE;
      }
      if (launchWantAgent) {
        notificationRequest.wantAgent = launchWantAgent;
      }
      await notificationManager.publish(notificationRequest);
      this.publishedNotificationSignatures.set(id, signature);
    } catch (error) {
      hilog.warn(DOMAIN, 'MindFS', 'publish notification failed id=%{public}d error=%{public}s', id, errorSummary(error));
      console.warn(`MindFS publish notification failed: ${JSON.stringify(error)}`);
    }
  }

  private async createLaunchWantAgent(requestCode: number, target?: PendingReplySession): Promise<WantAgent | undefined> {
    const context = this.context;
    if (!context) {
      return undefined;
    }
    try {
      let parameters: Record<string, Object> | undefined = undefined;
      if (target) {
        parameters = {};
        parameters['rootId'] = target.rootId;
        parameters['sessionKey'] = target.sessionKey;
      }
      const launchWant: Want = {
        bundleName: context.abilityInfo.bundleName,
        abilityName: context.abilityInfo.name,
        parameters
      };
      return await wantAgent.getWantAgent({
        wants: [launchWant],
        operationType: wantAgent.OperationType.START_ABILITY,
        requestCode,
        wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
      });
    } catch (error) {
      console.warn(`MindFS create notification wantAgent failed: ${errorSummary(error)}`);
      return undefined;
    }
  }

  private startReplyPolling(config: ReplyPollerConfig): void {
    this.stopReplyPolling();
    this.replyPollRunning = true;
    this.scheduleReplyPoll(config, 0);
  }

  private resumeStoredReplyPolling(reason: string): void {
    const raw = this.getStoreValue(KEY_REPLY_POLLER_CONFIG, '');
    if (!raw) {
      hilog.warn(DOMAIN, 'MindFS', 'reply poller resume skipped: no config, reason=%{public}s', reason);
      console.warn(`MindFS reply poller resume skipped: no config (${reason})`);
      return;
    }
    const config = parseReplyPollerConfig(raw);
    const apiBaseUrl = `${config.apiBaseUrl ?? ''}`.trim();
    if (!/^https?:\/\//i.test(apiBaseUrl)) {
      hilog.warn(DOMAIN, 'MindFS', 'reply poller resume skipped: invalid apiBaseUrl=%{public}s reason=%{public}s', apiBaseUrl, reason);
      console.warn(`MindFS reply poller resume skipped: invalid apiBaseUrl (${reason})`);
      return;
    }
    if (MindFSNativeBridge.appForeground) {
      return;
    }
    if (!this.nodeViewActive) {
      hilog.info(DOMAIN, 'MindFS', 'reply poller resume skipped: node view inactive, reason=%{public}s', reason);
      return;
    }
    if (this.replyPollRunning) {
      hilog.info(DOMAIN, 'MindFS', 'reply poller resume skipped: already running, reason=%{public}s', reason);
      return;
    }
    hilog.info(DOMAIN, 'MindFS', 'reply poller resume config apiBaseUrl=%{public}s reason=%{public}s', apiBaseUrl, reason);
    this.replyPollRunning = true;
    void this.pollReplySessions(config);
  }

  private stopReplyPolling(): void {
    this.replyPollRunning = false;
    if (this.replyPollTimerId >= 0) {
      clearTimeout(this.replyPollTimerId);
      this.replyPollTimerId = -1;
    }
  }

  private scheduleReplyPoll(config: ReplyPollerConfig, delayMilliseconds: number): void {
    if (!this.replyPollRunning) {
      hilog.warn(DOMAIN, 'MindFS', 'reply poll schedule skipped: not running');
      return;
    }
    if (this.replyPollTimerId >= 0) {
      clearTimeout(this.replyPollTimerId);
    }
    this.replyPollTimerId = setTimeout(() => {
      void this.pollReplySessions(config);
    }, delayMilliseconds);
  }

  private async pollReplySessions(config: ReplyPollerConfig): Promise<void> {
    if (!this.replyPollRunning) {
      hilog.warn(DOMAIN, 'MindFS', 'reply poll skipped: not running');
      return;
    }
    let nextDelay = 15000;
    try {
      const sessions = await this.fetchReplyingSessions(config);
      nextDelay = this.applyReplyingSessions(sessions) ? 5000 : 15000;
    } catch (error) {
      hilog.warn(DOMAIN, 'MindFS', 'reply poll failed: %{public}s', errorSummary(error));
      console.warn(`MindFS reply poll failed: ${JSON.stringify(error)}`);
      nextDelay = 15000;
    } finally {
      this.scheduleReplyPoll(config, nextDelay);
    }
  }

  private async fetchReplyingSessions(config: ReplyPollerConfig): Promise<Array<ReplyState>> {
    const apiBaseUrl = `${config.apiBaseUrl ?? ''}`.trim().replace(/\/+$/, '');
    const requestUrl = `${apiBaseUrl}/api/replying-sessions`;
    const headers: Record<string, string> = {
      'Accept': 'application/json'
    };
    const token = `${config.token ?? ''}`.trim();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const cookie = replyPollerCookieFor(requestUrl);
    if (cookie) {
      headers['Cookie'] = cookie;
    }
    if (config.e2eeRequired) {
      if (!hasReplyPollerE2EESession(config)) {
        throw new Error('e2ee session missing');
      }
      headers[E2EE_HEADER] = '1';
      const clientId = `${config.e2eeClientId ?? ''}`.trim();
      if (clientId) {
        headers[CLIENT_ID_HEADER] = clientId;
      }
      await addRequestProofHeaders(headers, config, 'GET', requestUrl);
    }
    const requestTask = http.createHttp();
    try {
      const requestOptions: http.HttpRequestOptions = {
        method: http.RequestMethod.GET,
        header: headers,
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 5000,
        readTimeout: 8000
      };
      const localTlsHost = localHttpsHostFromURL(requestUrl);
      if (localTlsHost) {
        requestOptions.remoteValidation = 'skip';
        hilog.info(DOMAIN, 'MindFS', 'reply poll local tls validation skipped host=%{public}s', localTlsHost);
      }
      hilog.info(
        DOMAIN,
        'MindFS',
        'reply poll request url=%{public}s hasCookie=%{public}s e2ee=%{public}s auth=%{public}s clientId=%{public}s ts=%{public}s proof=%{public}s',
        requestUrl,
        `${!!cookie}`,
        `${config.e2eeRequired === true}`,
        `${!!headers['Authorization']}`,
        `${!!headers[CLIENT_ID_HEADER]}`,
        `${!!headers[TS_HEADER]}`,
        `${!!headers[PROOF_HEADER]}`
      );
      const response = await requestTask.request(requestUrl, requestOptions);
      if (response.responseCode < 200 || response.responseCode >= 300) {
        hilog.warn(
          DOMAIN,
          'MindFS',
          'reply poll http=%{public}d url=%{public}s',
          response.responseCode,
          requestUrl
        );
        if (response.responseCode === 401 && config.e2eeRequired) {
          this.clearReplyPollerE2EESession(config);
        }
        throw new Error(`HTTP ${response.responseCode}`);
      }
      let body = `${response.result ?? ''}`;
      if (isProtectedE2EEResponse(response.header)) {
        body = await decryptProtectedBody(config, body);
      }
      const parsed = JSON.parse(body) as ReplyingSessionsResponse;
      hilog.info(DOMAIN, 'MindFS', 'reply poll ok url=%{public}s bodyLength=%{public}d', requestUrl, body.length);
      return (parsed.sessions ?? []).map((item: ReplyState): ReplyState => {
        const sessionKey = `${item.sessionKey ?? ''}`.trim();
        return {
          sessionKey,
          rootId: `${item.rootId ?? ''}`.trim(),
          rootTitle: `${item.rootTitle ?? ''}`.trim(),
          sessionTitle: `${item.sessionTitle ?? ''}`.trim(),
          summary: `${item.summary ?? ''}`.trim(),
          updatedAt: `${item.updatedAt ?? ''}`.trim(),
          status: 'replying'
        };
      }).filter((item: ReplyState): boolean => item.sessionKey.length > 0);
    } finally {
      requestTask.destroy();
    }
  }

  private clearReplyPollerE2EESession(config: ReplyPollerConfig): void {
    config.e2eeClientId = '';
    config.e2eeTransportKey = '';
    this.setStoreValue(KEY_REPLY_POLLER_CONFIG, JSON.stringify(config));
  }

  private applyReplyingSessions(nextSessions: Array<ReplyState>): boolean {
    const currentKeys = new Set<string>();
    for (const incoming of nextSessions) {
      currentKeys.add(incoming.sessionKey);
      const existing = this.replyStates.get(incoming.sessionKey);
      if (!existing) {
        this.replyStates.set(incoming.sessionKey, incoming);
      } else {
        existing.rootId = incoming.rootId;
        existing.rootTitle = incoming.rootTitle;
        existing.sessionTitle = incoming.sessionTitle;
        if (existing.status === 'completed' || incoming.summary) {
          existing.summary = incoming.summary;
        }
        existing.updatedAt = incoming.updatedAt;
        existing.status = 'replying';
      }
      this.completedReplyKeys.delete(incoming.sessionKey);
    }

    for (const state of this.replyStates.values()) {
      if (state.status === 'replying' && !currentKeys.has(state.sessionKey)) {
        state.status = 'completed';
        this.completedReplyKeys.add(state.sessionKey);
      }
    }

    const visibleStates = Array.from(this.replyStates.values())
      .filter((state: ReplyState): boolean => state.status === 'replying' || state.status === 'completed')
      .sort((left: ReplyState, right: ReplyState): number => right.updatedAt.localeCompare(left.updatedAt));
    this.publishReplyNotifications(visibleStates);
    return currentKeys.size > 0;
  }

  private publishReplyNotifications(states: Array<ReplyState>): void {
    if (states.length === 0) {
      return;
    }
    if (states.length > 1) {
      const replyingCount = states.filter((state: ReplyState): boolean => state.status === 'replying').length;
      const title = replyingCount > 0 ? `${replyingCount} 个回复中` : `${states.length} 个回复完成`;
      const text = states.map((state: ReplyState): string => replyNotificationLine(state)).join('\n');
      const target = replyNotificationTarget(states[0]);
      void this.publishBasicNotification(2001, title, text, replyingCount > 0, false, target);
      for (const state of states) {
        const completedNow = state.status === 'completed' && this.completedReplyKeys.has(state.sessionKey);
        if (completedNow) {
          this.playReplyCompletionEffects();
        }
        void this.publishBasicNotification(
          replyNotificationIdFor(state.sessionKey),
          replyNotificationTitle(state),
          state.summary || ' ',
          state.status === 'replying',
          completedNow,
          replyNotificationTarget(state)
        );
        if (completedNow) {
          this.completedReplyKeys.delete(state.sessionKey);
        }
      }
      return;
    }
    const state = states[0];
    const completedNow = state.status === 'completed' && this.completedReplyKeys.has(state.sessionKey);
    if (completedNow) {
      this.playReplyCompletionEffects();
    }
    void this.publishBasicNotification(
      2001,
      replyNotificationTitle(state),
      state.summary || ' ',
      state.status === 'replying',
      completedNow,
      replyNotificationTarget(state)
    );
    if (completedNow) {
      this.completedReplyKeys.delete(state.sessionKey);
    }
  }

  private clearReplyNotifications(reason: string): void {
    const ids = new Set<number>();
    ids.add(2001);
    for (const state of this.replyStates.values()) {
      ids.add(replyNotificationIdFor(state.sessionKey));
    }
    for (const id of this.publishedNotificationSignatures.keys()) {
      ids.add(id);
    }
    this.publishedNotificationSignatures.clear();
    for (const id of ids) {
      notificationManager.cancel(id).catch((error: Error) => {
        hilog.warn(DOMAIN, 'MindFS', 'cancel notification failed id=%{public}d error=%{public}s', id, errorSummary(error));
      });
    }
  }

  private clearReplyStateAndNotifications(reason: string): void {
    this.clearReplyNotifications(reason);
    this.replyStates.clear();
    this.completedReplyKeys.clear();
  }

  private playReplyCompletionEffects(): void {
    void this.vibrateReplyCompletion();
  }

  private async vibrateReplyCompletion(): Promise<void> {
    try {
      const pattern = new vibrator.VibratorPatternBuilder()
        .addContinuousEvent(0, 160)
        .addContinuousEvent(270, 160)
        .build();
      await vibrator.startVibration({
        type: 'pattern',
        pattern
      }, {
        usage: 'notification'
      });
    } catch (error) {
      hilog.warn(DOMAIN, 'MindFS', 'reply completion vibration failed: %{public}s', errorSummary(error));
    }
  }
}

function parseDownloadInput(input: string): DownloadInput {
  if (!input.trim()) {
    return {};
  }
  try {
    return JSON.parse(input) as DownloadInput;
  } catch (_error) {
    return {};
  }
}

function parseReplyPollerConfig(input: string): ReplyPollerConfig {
  if (!input.trim()) {
    return {};
  }
  try {
    return JSON.parse(input) as ReplyPollerConfig;
  } catch (_error) {
    return {};
  }
}

function hasReplyPollerE2EESession(config: ReplyPollerConfig): boolean {
  return `${config.e2eeClientId ?? ''}`.trim().length > 0 &&
    `${config.e2eeTransportKey ?? ''}`.trim().length > 0;
}

function replyPollerCookieFor(requestUrl: string): string {
  try {
    const cookie = webview.WebCookieManager.fetchCookieSync(requestUrl);
    if (cookie.trim()) {
      return cookie;
    }
  } catch (error) {
    hilog.warn(DOMAIN, 'MindFS', 'reply poll cookie unavailable for url=%{public}s error=%{public}s', requestUrl, errorSummary(error));
  }
  const origin = originFromURL(requestUrl);
  if (!origin) {
    return '';
  }
  try {
    return webview.WebCookieManager.fetchCookieSync(origin);
  } catch (error) {
    hilog.warn(DOMAIN, 'MindFS', 'reply poll origin cookie unavailable for origin=%{public}s error=%{public}s', origin, errorSummary(error));
    return '';
  }
}

function originFromURL(rawURL: string): string {
  const match = rawURL.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i);
  return `${match?.[1] ?? ''}`.replace(/\/+$/, '');
}

function localHttpsHostFromURL(rawURL: string): string {
  const match = rawURL.match(/^https:\/\/(\[[^\]]+\]|[^/:?#]+)(?::\d+)?(?:[/?#]|$)/i);
  const host = `${match?.[1] ?? ''}`.trim();
  return isLocalNetworkHost(host) ? host : '';
}

function isLocalNetworkHost(host: string): boolean {
  let normalized = host.trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.substring(1, normalized.length - 1);
  }
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1') {
    return true;
  }
  if (
    normalized.startsWith('10.') ||
    normalized.startsWith('192.168.') ||
    normalized.startsWith('169.254.') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  ) {
    return true;
  }
  const parts = normalized.split('.');
  if (parts.length === 4) {
    const first = Number.parseInt(parts[0], 10);
    const second = Number.parseInt(parts[1], 10);
    if (first === 172 && second >= 16 && second <= 31) {
      return true;
    }
  }
  return normalized.endsWith('.local');
}

async function addRequestProofHeaders(
  headers: Record<string, string>,
  config: ReplyPollerConfig,
  method: string,
  requestUrl: string
): Promise<void> {
  const clientId = `${config.e2eeClientId ?? ''}`.trim();
  const transportKey = decodeBase64(`${config.e2eeTransportKey ?? ''}`.trim());
  const ts = utcTimestamp();
  const proofPath = requestProofPath(requestUrl);
  const proof = await buildRequestProof(transportKey, method, proofPath, ts, clientId);
  headers[TS_HEADER] = ts;
  headers[PROOF_HEADER] = proof;
}

async function decryptProtectedBody(config: ReplyPollerConfig, body: string): Promise<string> {
  if (!hasReplyPollerE2EESession(config)) {
    throw new Error('e2ee session missing');
  }
  const envelope = JSON.parse(body) as CipherEnvelope;
  const keyBytes = decodeBase64(`${config.e2eeTransportKey ?? ''}`.trim());
  const nonce = decodeBase64(`${envelope.nonce ?? ''}`.trim());
  const ciphertextWithTag = decodeBase64(`${envelope.ciphertext ?? ''}`.trim());
  if (ciphertextWithTag.length < 16) {
    throw new Error('e2ee ciphertext invalid');
  }
  const ciphertext = ciphertextWithTag.slice(0, ciphertextWithTag.length - 16);
  const authTag = ciphertextWithTag.slice(ciphertextWithTag.length - 16);
  const key = cryptoFramework.createSymKeyGenerator('AES256').convertKeySync({ data: keyBytes });
  const cipher = cryptoFramework.createCipher('AES256|GCM|NoPadding');
  const params: cryptoFramework.GcmParamsSpec = {
    algName: 'GcmParamsSpec',
    iv: { data: nonce },
    aad: { data: new Uint8Array() },
    authTag: { data: authTag }
  };
  await cipher.init(cryptoFramework.CryptoMode.DECRYPT_MODE, key, params);
  const output = await cipher.doFinal({ data: ciphertext });
  return util.TextDecoder.create('utf-8').decode(output.data);
}

async function buildRequestProof(
  key: Uint8Array,
  method: string,
  path: string,
  ts: string,
  clientId: string
): Promise<string> {
  const digest = await sha256Bytes(['mindfs-request-proof', method, path, ts, clientId].join('\u001f'));
  const macKey = cryptoFramework.createSymKeyGenerator('HMAC').convertKeySync({ data: key });
  const macSpec: cryptoFramework.HmacSpec = { algName: 'HMAC', mdName: 'SHA256' };
  const mac = cryptoFramework.createMac(macSpec);
  await mac.init(macKey);
  await mac.update({ data: digest });
  const signature = await mac.doFinal();
  return encodeBase64(signature.data);
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  const md = cryptoFramework.createMd('SHA256');
  await md.update({ data: utf8Bytes(value) });
  const digest = await md.digest();
  return digest.data;
}

function utcTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function requestProofPath(rawURL: string): string {
  const markerIndex = rawURL.indexOf('://');
  if (markerIndex < 0) {
    return '/';
  }
  const pathStart = rawURL.indexOf('/', markerIndex + 3);
  if (pathStart < 0) {
    return '/';
  }
  let pathAndQuery = rawURL.substring(pathStart);
  const hashIndex = pathAndQuery.indexOf('#');
  if (hashIndex >= 0) {
    pathAndQuery = pathAndQuery.substring(0, hashIndex);
  }
  const queryIndex = pathAndQuery.indexOf('?');
  let path = queryIndex >= 0 ? pathAndQuery.substring(0, queryIndex) : pathAndQuery;
  const query = queryIndex >= 0 ? pathAndQuery.substring(queryIndex) : '';
  path = path.replace(/^\/n\/[^/]+/, '');
  if (!path) {
    path = '/';
  }
  return `${path}${query}`;
}

function isProtectedE2EEResponse(headers: Object): boolean {
  const value = responseHeaderValue(headers, E2EE_HEADER);
  return value === '1';
}

function responseHeaderValue(headers: Object, name: string): string {
  const record = headers as Record<string, Object>;
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== lowerName) {
      continue;
    }
    const value = record[key];
    if (Array.isArray(value)) {
      return value.length > 0 ? `${value[0]}`.trim() : '';
    }
    return `${value ?? ''}`.trim();
  }
  return '';
}

function parseLauncherNodes(input: string): Array<LauncherNode> {
  if (!input.trim()) {
    return new Array<LauncherNode>();
  }
  try {
    const parsed = JSON.parse(input) as Object;
    let items = new Array<LauncherNode>();
    if (Array.isArray(parsed)) {
      items = parsed as Array<LauncherNode>;
    } else {
      const objectValue = parsed as Record<string, Object>;
      const nodes = objectValue['nodes'];
      if (Array.isArray(nodes)) {
        items = nodes as Array<LauncherNode>;
      }
    }
    return normalizeLauncherNodes(items);
  } catch (error) {
    hilog.warn(DOMAIN, 'MindFS', 'parseLauncherNodes failed: %{public}s', errorSummary(error));
    return new Array<LauncherNode>();
  }
}

function normalizeLauncherNodes(items: Array<LauncherNode>): Array<LauncherNode> {
  const createdAt = new Date().toISOString();
  const nodes = new Array<LauncherNode>();
  const seenURLs = new Set<string>();
  for (const item of items) {
    const name = `${item?.name ?? ''}`.trim();
    const url = normalizeNodeURL(`${item?.url ?? ''}`);
    if (!name || !url || seenURLs.has(url)) {
      continue;
    }
    seenURLs.add(url);
    const node: LauncherNode = {
      id: `${item?.id ?? ''}`.trim() || buildLauncherNodeID(),
      name,
      url,
      createdAt: `${item?.createdAt ?? ''}`.trim() || createdAt
    };
    const lastOpenedAt = `${item?.lastOpenedAt ?? ''}`.trim();
    if (lastOpenedAt) {
      node.lastOpenedAt = lastOpenedAt;
    }
    nodes.push(node);
  }
  return nodes;
}

function parseSetNodesInput(input: string): SetNodesInput {
  if (!input.trim()) {
    return {};
  }
  try {
    return JSON.parse(input) as SetNodesInput;
  } catch (_error) {
    return {};
  }
}

function normalizeNodeURL(value: string): string {
  const trimmed = `${value ?? ''}`.trim();
  if (!trimmed) {
    return '';
  }
  let url = trimmed;
  if (!/^[a-z]+:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  const match = url.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)([^?#]*)(\?[^#]*)?/i);
  if (!match) {
    return '';
  }
  const protocol = match[1].split(':')[0].toLowerCase();
  if (protocol !== 'http' && protocol !== 'https') {
    return '';
  }
  let normalized = `${match[1]}${match[2] || ''}${match[3] || ''}`;
  normalized = normalized.replace(/\/+$/, '');
  const path = `${match[2] || ''}`;
  if (/^\/n\/[^/]+\/?$/i.test(path)) {
    normalized = `${normalized}/`;
  }
  return normalized;
}

function buildLauncherNodeID(): string {
  return `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function mergeRelayNodesIntoLauncherNodes(
  launcherNodes: Array<LauncherNode>,
  relayNodes: Array<LauncherNode>
): Array<LauncherNode> {
  const seenURLs = new Set<string>();
  const merged = new Array<LauncherNode>();
  for (const node of launcherNodes) {
    const name = `${node.name ?? ''}`.trim();
    const url = normalizeNodeURL(`${node.url ?? ''}`);
    const createdAt = `${node.createdAt ?? ''}`.trim();
    if (!name || !url || !createdAt || seenURLs.has(url)) {
      continue;
    }
    seenURLs.add(url);
    const mergedNode: LauncherNode = {
      id: `${node.id ?? ''}`.trim() || buildLauncherNodeID(),
      name,
      url,
      createdAt
    };
    if (node.lastOpenedAt) {
      mergedNode.lastOpenedAt = node.lastOpenedAt;
    }
    merged.push(mergedNode);
  }

  const createdAt = new Date().toISOString();
  for (const node of relayNodes) {
    const name = `${node.name ?? ''}`.trim();
    const url = normalizeNodeURL(`${node.url ?? ''}`);
    if (!name || !url || seenURLs.has(url)) {
      continue;
    }
    seenURLs.add(url);
    merged.unshift({
      id: buildLauncherNodeID(),
      name,
      url,
      createdAt
    });
  }
  return merged.sort((left: LauncherNode, right: LauncherNode): number => {
    return right.createdAt.localeCompare(left.createdAt);
  });
}

function sanitizeFilename(filename: string): string {
  return filename
    .trim()
    .replace(/\\/g, '_')
    .replace(/\//g, '_')
    .replace(/:/g, '_')
    .replace(/\*/g, '_')
    .replace(/\?/g, '_')
    .replace(/"/g, '_')
    .replace(/</g, '_')
    .replace(/>/g, '_')
    .replace(/\|/g, '_');
}

function uniqueDownloadPath(directory: string, filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  const baseName = dotIndex > 0 ? filename.substring(0, dotIndex) : filename;
  const extension = dotIndex > 0 ? filename.substring(dotIndex) : '';
  let candidate = `${directory}/${filename}`;
  for (let index = 1; fileExists(candidate); index++) {
    candidate = `${directory}/${baseName} (${index})${extension}`;
  }
  return candidate;
}

function fileExists(path: string): boolean {
  try {
    return fileIo.accessSync(path);
  } catch (_error) {
    return false;
  }
}

function replyNotificationIdFor(sessionKey: string): number {
  return 760000 + Math.abs(hashString(sessionKey) % 100000);
}

function replyNotificationTitle(state: ReplyState): string {
  return `${replyTitlePrefix(state)} · ${state.status === 'completed' ? '完成' : '回复中'}`;
}

function replyNotificationTarget(state: ReplyState): PendingReplySession {
  return {
    rootId: state.rootId,
    sessionKey: state.sessionKey
  };
}

function replyTitlePrefix(state: ReplyState): string {
  const root = state.rootTitle || state.rootId || 'MindFS';
  const title = state.sessionTitle || '会话';
  return `${root} · ${title}`;
}

function replyNotificationLine(state: ReplyState): string {
  const line = replyNotificationTitle(state);
  return state.summary ? `${line}: ${state.summary}` : line;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function utf8Bytes(value: string): Uint8Array {
  return new util.TextEncoder('utf-8').encodeInto(value);
}

function encodeBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triplet = (first << 16) | (second << 8) | third;
    output += alphabet.charAt((triplet >> 18) & 63);
    output += alphabet.charAt((triplet >> 12) & 63);
    output += index + 1 < bytes.length ? alphabet.charAt((triplet >> 6) & 63) : '=';
    output += index + 2 < bytes.length ? alphabet.charAt(triplet & 63) : '=';
  }
  return output;
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized) {
    return new Uint8Array();
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = new Array<number>();
  for (let index = 0; index < normalized.length; index += 4) {
    const first = alphabet.indexOf(normalized[index]);
    const second = alphabet.indexOf(normalized[index + 1]);
    const thirdChar = normalized[index + 2] ?? '=';
    const fourthChar = normalized[index + 3] ?? '=';
    const third = thirdChar === '=' ? 0 : alphabet.indexOf(thirdChar);
    const fourth = fourthChar === '=' ? 0 : alphabet.indexOf(fourthChar);
    if (first < 0 || second < 0 || (thirdChar !== '=' && third < 0) || (fourthChar !== '=' && fourth < 0)) {
      throw new Error('invalid base64');
    }
    const triplet = (first << 18) | (second << 12) | (third << 6) | fourth;
    bytes.push((triplet >> 16) & 255);
    if (thirdChar !== '=') {
      bytes.push((triplet >> 8) & 255);
    }
    if (fourthChar !== '=') {
      bytes.push(triplet & 255);
    }
  }
  return new Uint8Array(bytes);
}

function errorSummary(error: Error): string {
  const maybeBusinessError = error as ErrorWithCode;
  const code = maybeBusinessError.code === undefined ? '' : `${maybeBusinessError.code}`;
  const message = `${maybeBusinessError.message ?? ''}`.trim();
  if (code && message) {
    return `错误码 ${code}: ${message}`;
  }
  return message || code || `${error}`;
}
