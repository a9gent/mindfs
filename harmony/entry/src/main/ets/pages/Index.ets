import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { MindFSNativeBridge } from '../native/MindFSNativeBridge';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private bridge: MindFSNativeBridge = new MindFSNativeBridge();
  private readonly appOrigin: string = 'https://mindfs.local/';
  private activeNodeBaseUrl: string = '';
  private nativeBridgeRegistered: boolean = false;

  aboutToAppear(): void {
    this.bridge.setContext(getContext(this) as common.UIAbilityContext);
    MindFSNativeBridge.setPendingReplySessionDispatcher((rawSession: string): void => {
      this.dispatchPendingReplySession(rawSession);
    });
    MindFSNativeBridge.setReplyPollerConfigSyncer((reason: string, done: () => void): void => {
      this.syncLatestReplyPollerConfigFromPage(reason, done);
    });
  }

  aboutToDisappear(): void {
    this.saveWebCookies();
    MindFSNativeBridge.setPendingReplySessionDispatcher(undefined);
    MindFSNativeBridge.setReplyPollerConfigSyncer(undefined);
    try {
      this.controller.deleteJavaScriptRegister('MindFSNative');
      this.controller.deleteJavaScriptRegister('MindFSHarmony');
      this.controller.deleteJavaScriptRegister('MindFSLauncherNodeSync');
    } catch (error) {
      console.warn(`MindFS delete JS bridge failed: ${JSON.stringify(error)}`);
    }
  }

  private dispatchPendingReplySession(rawSession: string): void {
    const rawLiteral = JSON.stringify(rawSession);
    this.controller.runJavaScript(`
      (function(){
        try {
          var raw = ${rawLiteral};
          var detail = JSON.parse(raw);
          window.__mindfsPendingReplySession = detail;
          var count = 0;
          function dispatch() {
            count += 1;
            window.__mindfsPendingReplySession = detail;
            window.dispatchEvent(new CustomEvent('mindfs:open-reply-session', { detail: detail }));
            if (count < 12) {
              window.setTimeout(dispatch, 250);
            }
          }
          dispatch();
        } catch (error) {
          console.error('[MindFS pending reply session] inject failed ' + String(error && (error.stack || error.message || error)));
        }
      })();
    `).catch((error: Error) => {
      console.warn(`MindFS pending reply session JS inject failed: ${JSON.stringify(error)}`);
    });
  }

  private nativeBridgeMethodList(): Array<string> {
    return [
      'download',
      'saveBase64',
      'openExternalURL',
      'getAppInfo',
      'configureReplyPoller',
      'markClearWebViewCacheOnNextLaunch',
      'clearPendingWebViewCacheClear',
      'consumeRelayNodes',
      'getLauncherNodes',
      'getSystemSafeArea',
      'setLauncherNodes',
      'storeRelayNodes',
      'writeClipboardText',
      'setAppVisibility',
      'consumePendingReplySession'
    ];
  }

  private registerNativeBridge(): boolean {
    if (this.nativeBridgeRegistered) {
      return true;
    }
    const methodList = this.nativeBridgeMethodList();
    try {
      this.controller.registerJavaScriptProxy(this.bridge, 'MindFSNative', methodList);
      this.controller.registerJavaScriptProxy(this.bridge, 'MindFSHarmony', methodList);
      this.controller.registerJavaScriptProxy(this.bridge, 'MindFSLauncherNodeSync', ['storeRelayNodes']);
      this.nativeBridgeRegistered = true;
      return true;
    } catch (error) {
      console.warn(`MindFS register JS bridge failed: ${JSON.stringify(error)}`);
      return false;
    }
  }

  private saveWebCookies(): void {
    try {
      webview.WebCookieManager.saveCookieSync();
    } catch (error) {
      console.warn(`MindFS save cookies failed: ${JSON.stringify(error)}`);
    }
  }

  private resolveRawFilePath(url: string): string {
    if (!url.startsWith(this.appOrigin)) {
      return '';
    }

    const queryIndex = url.indexOf('?');
    const cleanUrl = queryIndex >= 0 ? url.substring(0, queryIndex) : url;
    let relativePath = cleanUrl.substring(this.appOrigin.length);
    if (!relativePath || relativePath === '/') {
      relativePath = 'index.html';
    }

    return `public/${decodeURIComponent(relativePath)}`;
  }

  private mimeTypeForPath(path: string): string {
    if (path.endsWith('.html')) {
      return 'text/html';
    }
    if (path.endsWith('.js')) {
      return 'text/javascript';
    }
    if (path.endsWith('.css')) {
      return 'text/css';
    }
    if (path.endsWith('.svg')) {
      return 'image/svg+xml';
    }
    if (path.endsWith('.png')) {
      return 'image/png';
    }
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) {
      return 'image/jpeg';
    }
    if (path.endsWith('.webp')) {
      return 'image/webp';
    }
    if (path.endsWith('.woff2')) {
      return 'font/woff2';
    }
    return 'application/octet-stream';
  }

  private hostFromUrl(url: string): string {
    const match = url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i);
    return `${match?.[1] ?? ''}`.toLowerCase();
  }

  private originFromUrl(url: string): string {
    const match = url.match(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)/i);
    return `${match?.[1] ?? ''}`.replace(/\/+$/, '');
  }

  private pathFromUrl(url: string): string {
    const match = url.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+([^?#]*)/i);
    return `${match?.[1] ?? '/'}` || '/';
  }

  private shouldSyncRelayNodes(url: string): boolean {
    const origin = this.originFromUrl(url);
    const shellOrigin = this.appOrigin.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(origin) || origin === shellOrigin) {
      return false;
    }
    return (this.pathFromUrl(url).replace(/\/+$/, '') || '/') === '/nodes';
  }

  private shouldPatchRelayNodeShell(url: string): boolean {
    const origin = this.originFromUrl(url);
    const shellOrigin = this.appOrigin.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(origin) || origin === shellOrigin) {
      return false;
    }
    const path = this.pathFromUrl(url);
    return /^\/n\/[^/]+\/?/.test(path);
  }

  private shouldPatchRelayListSafeArea(url: string): boolean {
    const origin = this.originFromUrl(url);
    const shellOrigin = this.appOrigin.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(origin) || origin === shellOrigin) {
      return false;
    }
    const path = this.pathFromUrl(url).replace(/\/+$/, '') || '/';
    return path === '/nodes' || path === '/login';
  }

  private shouldPatchNodeShell(url: string): boolean {
    const origin = this.originFromUrl(url);
    const shellOrigin = this.appOrigin.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(origin) || origin === shellOrigin) {
      return false;
    }
    const path = this.pathFromUrl(url).replace(/\/+$/, '') || '/';
    return path !== '/nodes' && path !== '/login';
  }

  private configureReplyPollerFromPageUrl(url: string): void {
    const apiBaseUrl = this.replyPollerBaseUrlFromPageUrl(url);
    const origin = this.originFromUrl(apiBaseUrl);
    const shellOrigin = this.appOrigin.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(apiBaseUrl) || origin === shellOrigin) {
      this.activeNodeBaseUrl = '';
      this.bridge.setNodeViewActive(false);
      return;
    }
    if (apiBaseUrl === this.activeNodeBaseUrl) {
      return;
    }

    this.activeNodeBaseUrl = apiBaseUrl;
    this.bridge.setNodeViewActive(true);
    const error = this.bridge.configureReplyPoller(JSON.stringify({ apiBaseUrl }));
    if (error) {
      console.warn(`MindFS configure reply poller from page failed: ${error}`);
    }
  }

  private syncLatestReplyPollerConfigFromPage(reason: string, done: () => void): void {
    this.controller.runJavaScript(`
      (function(){
        try {
          var latest = window.__mindfsLatestReplyPollerConfig || null;
          if (!latest) {
            return '';
          }
          return JSON.stringify(latest);
        } catch (_error) {
          return '';
        }
      })();
    `)
      .then((raw: string) => {
        const rawText = `${raw ?? ''}`.trim();
        let configRaw = rawText;
        if (configRaw.startsWith('"')) {
          try {
            const decoded = JSON.parse(configRaw) as string;
            if (typeof decoded === 'string') {
              configRaw = decoded.trim();
            }
          } catch (_error) {
          }
        }
        if (configRaw.startsWith('{')) {
          const error = this.bridge.configureReplyPoller(configRaw);
          if (error) {
            hilog.warn(0x4d46, 'MindFS', 'reply poller page config sync failed reason=%{public}s error=%{public}s', reason, error);
          } else {
            hilog.info(0x4d46, 'MindFS', 'reply poller page config synced reason=%{public}s rawLength=%{public}d', reason, configRaw.length);
          }
        } else {
          hilog.warn(0x4d46, 'MindFS', 'reply poller page config missing reason=%{public}s rawLength=%{public}d', reason, rawText.length);
        }
      })
      .catch((error: Error) => {
        hilog.warn(0x4d46, 'MindFS', 'reply poller page config read failed reason=%{public}s error=%{public}s', reason, JSON.stringify(error));
      })
      .finally(() => {
        done();
      });
  }

  private replyPollerBaseUrlFromPageUrl(url: string): string {
    const origin = this.originFromUrl(url);
    if (!/^https?:\/\//i.test(origin)) {
      return '';
    }
    const path = this.pathFromUrl(url).replace(/\/+$/, '') || '/';
    const match = /^\/n\/[^/]+/.exec(path);
    if (match) {
      return `${origin}${match[0]}`;
    }
    if (path === '/nodes' || path === '/login') {
      return '';
    }
    return origin;
  }

  private isLocalNetworkHost(host: string): boolean {
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

  private createTextResponse(statusCode: number, reason: string, mimeType: string, body: string): WebResourceResponse {
    const response = new WebResourceResponse();
    response.setResponseCode(statusCode);
    response.setReasonMessage(reason);
    response.setResponseMimeType(mimeType);
    response.setResponseEncoding('utf-8');
    response.setResponseHeader([
      { headerKey: 'Access-Control-Allow-Origin', headerValue: this.appOrigin.substring(0, this.appOrigin.length - 1) },
      { headerKey: 'Cache-Control', headerValue: 'no-cache' }
    ]);
    response.setResponseData(body);
    return response;
  }

  private createRawFileResponse(url: string): WebResourceResponse | null {
    const rawFilePath = this.resolveRawFilePath(url);
    if (!rawFilePath) {
      return null;
    }

    if (rawFilePath === 'public/api/relay/status') {
      return this.createTextResponse(200, 'OK', 'application/json', JSON.stringify({ no_relayer: true }));
    }
    if (rawFilePath === 'public/api/relay/tips') {
      return this.createTextResponse(200, 'OK', 'application/json', 'null');
    }
    if (rawFilePath.startsWith('public/api/')) {
      return this.createTextResponse(404, 'Not Found', 'application/json', JSON.stringify({ error: 'not_found' }));
    }

    try {
      const response = new WebResourceResponse();
      const data = getContext(this).resourceManager.getRawFileContentSync(rawFilePath);
      response.setResponseCode(200);
      response.setReasonMessage('OK');
      response.setResponseMimeType(this.mimeTypeForPath(rawFilePath));
      response.setResponseEncoding('utf-8');
      response.setResponseHeader([
        { headerKey: 'Access-Control-Allow-Origin', headerValue: this.appOrigin.substring(0, this.appOrigin.length - 1) },
        { headerKey: 'Cache-Control', headerValue: 'no-cache' }
      ]);
      response.setResponseData(data.buffer as ArrayBuffer);
      return response;
    } catch (error) {
      console.error(`MindFS rawfile response failed: ${rawFilePath} ${JSON.stringify(error)}`);
      return this.createTextResponse(404, 'Not Found', 'text/plain', 'Not Found');
    }
  }

  private injectNativeRuntimeHooks(): void {
    const rawSafeArea = this.bridge.getSystemSafeArea();
    const rawSafeAreaLiteral = JSON.stringify(rawSafeArea);
    this.controller.runJavaScript(`
      (function(){
        try {
          var rawNativeSafeArea = ${rawSafeAreaLiteral};
          window.__MIND_FS_NATIVE_PLATFORM__ = 'harmony';
          if (!window.Capacitor) {
            window.Capacitor = {
              isNativePlatform: function(){ return true; },
              getPlatform: function(){ return 'harmony'; },
              isPluginAvailable: function(){ return false; }
            };
          } else {
            if (typeof window.Capacitor.isNativePlatform !== 'function') {
              window.Capacitor.isNativePlatform = function(){ return true; };
            }
            if (typeof window.Capacitor.getPlatform !== 'function') {
              window.Capacitor.getPlatform = function(){ return 'harmony'; };
            }
          }
          if (window.MindFSNative) {
            window.MindFSNative.platform = 'harmony';
          }
          if (window.MindFSHarmony) {
            window.MindFSHarmony.platform = 'harmony';
          }
          (function(){
            var cap = window.Capacitor = window.Capacitor || {};
            cap.Plugins = cap.Plugins || {};
            cap.PluginHeaders = cap.PluginHeaders || [];
            var hasReplyPoller = false;
            for (var i = 0; i < cap.PluginHeaders.length; i += 1) {
              if (cap.PluginHeaders[i] && cap.PluginHeaders[i].name === 'ReplyPoller') {
                hasReplyPoller = true;
                break;
              }
            }
            if (!hasReplyPoller) {
              cap.PluginHeaders.push({
                name: 'ReplyPoller',
                methods: [{ name: 'configure', rtype: 'promise' }]
              });
            }
            var previousNativePromise = cap.nativePromise;
            cap.nativePromise = function(pluginName, methodName, options) {
              if (pluginName === 'ReplyPoller' && methodName === 'configure') {
                return new Promise(function(resolve, reject) {
                  try {
                    var bridge = window.MindFSNative || window.MindFSHarmony || null;
                    if (!bridge || typeof bridge.configureReplyPoller !== 'function') {
                      reject(new Error('MindFS native bridge unavailable'));
                      return;
                    }
                    var raw = typeof options === 'string' ? options : JSON.stringify(options || {});
                    var error = bridge.configureReplyPoller(raw);
                    if (error) {
                      reject(new Error(String(error)));
                      return;
                    }
                    resolve();
                  } catch (error) {
                    reject(error);
                  }
                });
              }
              if (typeof previousNativePromise === 'function') {
                return previousNativePromise.apply(this, arguments);
              }
              return Promise.reject(new Error('"' + pluginName + '" plugin is not implemented on harmony'));
            };
            window.MindFSReplyPoller = {
              configure: function(payload) {
                var bridge = window.MindFSNative || window.MindFSHarmony || null;
                if (!bridge || typeof bridge.configureReplyPoller !== 'function') {
                  return;
                }
                bridge.configureReplyPoller(typeof payload === 'string' ? payload : JSON.stringify(payload || {}));
              }
            };
            window.dispatchEvent(new CustomEvent('mindfs:native-bridge-ready', { detail: { platform: 'harmony' } }));
            window.setTimeout(function(){
              window.dispatchEvent(new CustomEvent('mindfs:native-bridge-ready', { detail: { platform: 'harmony' } }));
            }, 250);
            window.setTimeout(function(){
              window.dispatchEvent(new CustomEvent('mindfs:native-bridge-ready', { detail: { platform: 'harmony' } }));
            }, 1000);
          })();
          (function(){
            function parseSafeArea(raw) {
              if (!raw) {
                return { top: 0, bottom: 0 };
              }
              try {
                return typeof raw === 'string' ? JSON.parse(raw) : raw;
              } catch (_error) {
                return { top: 0, bottom: 0 };
              }
            }
            function safeArea() {
              return rawNativeSafeArea;
            }
            function applySafeAreaValue(raw) {
              var area = parseSafeArea(raw);
              var top = Math.max(0, Number(area && area.top) || 0);
              var bottom = Math.max(0, Number(area && area.bottom) || 0);
              document.documentElement.style.setProperty('--mindfs-safe-area-top', top + 'px');
              document.documentElement.style.setProperty('--mindfs-safe-area-bottom', bottom + 'px');
              window.dispatchEvent(new CustomEvent('mindfs:safe-area-updated', { detail: { top: top, bottom: bottom } }));
            }
            function applySafeArea() {
              try {
                var raw = safeArea();
                if (!raw) {
                  return false;
                }
                applySafeAreaValue(raw);
                return true;
              } catch (_error) {
                return false;
              }
            }
            applySafeArea();
            window.setTimeout(applySafeArea, 120);
            window.setTimeout(applySafeArea, 500);
            window.setTimeout(applySafeArea, 1200);
            window.setTimeout(applySafeArea, 1800);
          })();
        } catch (_error) {
        }
      })();
    `).catch((error: Error) => {
      console.warn(`MindFS native runtime hook inject failed: ${JSON.stringify(error)}`);
    });
  }

  private refreshNodeFrontendCacheOnce(): void {
    this.controller.runJavaScript(`
      (function(){
        try {
          var key = 'mindfs:harmony-node-cache-refresh:' + window.location.origin;
          if (window.sessionStorage && window.sessionStorage.getItem(key) === '1') {
            return;
          }
          if (window.sessionStorage) {
            window.sessionStorage.setItem(key, '1');
          }
          var tasks = [];
          if (navigator.serviceWorker && typeof navigator.serviceWorker.getRegistrations === 'function') {
            tasks.push(navigator.serviceWorker.getRegistrations().then(function(registrations) {
              return Promise.all(registrations.map(function(registration) {
                return registration.unregister();
              }));
            }));
          }
          if (window.caches && typeof window.caches.keys === 'function') {
            tasks.push(window.caches.keys().then(function(keys) {
              return Promise.all(keys.map(function(cacheKey) {
                return window.caches.delete(cacheKey);
              }));
            }));
          }
          if (tasks.length === 0) {
            return;
          }
          Promise.all(tasks).then(function() {
            window.location.reload();
          }).catch(function(error) {
            console.warn('[MindFS node cache refresh] failed ' + String(error && (error.stack || error.message || error)));
          });
        } catch (error) {
          console.warn('[MindFS node cache refresh] failed ' + String(error && (error.stack || error.message || error)));
        }
      })();
    `).catch((error: Error) => {
      console.warn(`MindFS node cache refresh inject failed: ${JSON.stringify(error)}`);
    });
  }

  private hydrateLauncherNodesFromNative(): void {
    const rawNodes = this.bridge.getLauncherNodes();
    this.injectLauncherNodesFromNative('immediate', rawNodes);
    setTimeout(() => {
      this.injectLauncherNodesFromNative('delayed-1600');
    }, 1600);
    setTimeout(() => {
      this.injectLauncherNodesFromNative('delayed-3200');
    }, 3200);
  }

  private injectLauncherRelayEntryVisibility(): void {
  }

  private injectLauncherNodesFromNative(reason: string, rawNodes?: string): void {
    const nativeNodes = rawNodes ?? this.bridge.getLauncherNodes();
    const rawNodesLiteral = JSON.stringify(nativeNodes);
    const reasonLiteral = JSON.stringify(reason);
    this.controller.runJavaScript(`
      (function(){
        try {
          var rawNativeLauncherNodes = ${rawNodesLiteral};
          var hydrateReason = ${reasonLiteral};
          function parseJSON(raw, fallback) {
            if (!raw) {
              return fallback;
            }
            try {
              return typeof raw === 'string' ? JSON.parse(raw) : raw;
            } catch (_error) {
              return fallback;
            }
          }
          function normalizeURL(value) {
            var url = String(value || '').trim();
            if (!url) {
              return '';
            }
            var normalized = url.replace(/\\/+$/, '');
            return /\\/n\\/[^/?#]+$/i.test(normalized) ? normalized + '/' : normalized;
          }
          function merge(existing, incoming) {
            var seen = {};
            var merged = [];
            function push(node) {
              var name = String(node && node.name || '').trim();
              var url = normalizeURL(node && node.url);
              var createdAt = String(node && node.createdAt || '').trim();
              if (!name || !url || !createdAt || seen[url]) {
                return;
              }
              seen[url] = true;
              merged.push({
                id: String(node && node.id || '').trim() || ('node-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)),
                name: name,
                url: url,
                createdAt: createdAt,
                lastOpenedAt: String(node && node.lastOpenedAt || '').trim() || undefined
              });
            }
            incoming.forEach(push);
            existing.forEach(push);
            return merged.sort(function(left, right) {
              return String(right.createdAt || '').localeCompare(String(left.createdAt || ''));
            });
          }
          function applyNativeNodes(raw) {
            var result = parseJSON(raw, {});
            var nativeNodes = Array.isArray(result) ? result : (Array.isArray(result.nodes) ? result.nodes : []);
            try {
              var hash = String(window.location.hash || '');
              var match = hash.match(/(?:^#|&)relayNodes=([^&]+)/);
              if (match && match[1]) {
                var relayNodes = parseJSON(decodeURIComponent(match[1]), []);
                if (Array.isArray(relayNodes) && relayNodes.length) {
                  nativeNodes = relayNodes.concat(nativeNodes);
                  history.replaceState(null, '', window.location.pathname + window.location.search);
                }
              }
            } catch (_error) {
            }
            if (!nativeNodes.length) {
              return true;
            }
            var existing = parseJSON(localStorage.getItem('mindfs_launcher_nodes'), []);
            var merged = merge(Array.isArray(existing) ? existing : [], nativeNodes);
            localStorage.setItem('mindfs_launcher_nodes', JSON.stringify(merged));
            window.dispatchEvent(new CustomEvent('mindfs:launcher-nodes-updated', { detail: { count: merged.length } }));
            return true;
          }
          applyNativeNodes(rawNativeLauncherNodes);
        } catch (_error) {
        }
      })();
    `).catch((error: Error) => {
      console.warn(`MindFS launcher node hydrate failed: ${JSON.stringify(error)}`);
    });
  }

  private injectRelayNodeSync(): void {
  }

  private injectRelayNodeShellControls(): void {
    this.controller.runJavaScript(`
      (function(){
        try {
          function textOf(node) {
            return String((node && node.textContent) || '').replace(/\\s+/g, '').trim();
          }
          function hideInstallControls() {
            Array.prototype.forEach.call(document.querySelectorAll('button,a'), function(node) {
              var text = textOf(node);
              if (text === '安装应用' || text === '从菜单安装' || text === '安装说明' || text === '添加到主屏幕') {
                node.style.display = 'none';
                node.setAttribute('data-mindfs-harmony-hidden-install', '1');
              }
            });
            Array.prototype.forEach.call(document.querySelectorAll('div,span,p'), function(node) {
              var text = textOf(node);
              if (
                text === '当前浏览器未提供安装弹窗' ||
                text === '安装后可从桌面独立启动' ||
                text === '可从地址栏安装图标或浏览器菜单中安装' ||
                text === '请在浏览器菜单中选择“添加到主屏幕”或“安装应用”' ||
                text === '在Safari中用分享菜单安装' ||
                text === '请用Safari菜单File>AddtoDock' ||
                text === '已安装，可从桌面或应用列表打开'
              ) {
                node.style.display = 'none';
                node.setAttribute('data-mindfs-harmony-hidden-install-help', '1');
              }
            });
          }
          function patch() {
            hideInstallControls();
          }
          patch();
          window.setTimeout(patch, 300);
          window.setTimeout(patch, 1200);
          if (!window.__mindfsHarmonyShellControlsObserver) {
            window.__mindfsHarmonyShellControlsObserver = new MutationObserver(patch);
            window.__mindfsHarmonyShellControlsObserver.observe(document.documentElement, { childList: true, subtree: true });
          }
        } catch (_error) {
        }
      })();
    `).catch((error: Error) => {
      console.warn(`MindFS relay shell controls inject failed: ${JSON.stringify(error)}`);
    });
  }

  private injectGitStatusChevronFix(): void {
    this.controller.runJavaScript(`
      (function(){
        try {
          function chevron(open, size) {
            var rotation = open ? 'rotate(180deg)' : 'rotate(0deg)';
            return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" data-mindfs-harmony-git-chevron="1" style="display:block;transform:' + rotation + ';transition:transform 0.15s;color:currentColor;"><path fill-rule="evenodd" clip-rule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06"/></svg>';
          }
          function normalizeSlot(slot, open, size) {
            if (!slot) {
              return false;
            }
            if (slot.tagName && slot.tagName.toLowerCase() === 'svg') {
              slot.outerHTML = chevron(open, size);
              return true;
            }
            slot.innerHTML = chevron(open, size);
            slot.style.width = size + 'px';
            slot.style.height = size + 'px';
            slot.style.display = 'inline-flex';
            slot.style.alignItems = 'center';
            slot.style.justifyContent = 'center';
            slot.style.color = 'var(--text-secondary, #475569)';
            slot.style.border = 'none';
            slot.style.borderRight = 'none';
            slot.style.borderBottom = 'none';
            slot.style.transform = 'none';
            slot.style.marginTop = '0';
            slot.style.flex = '0 0 auto';
            return true;
          }
          function patchExpandButtons() {
            var count = 0;
            Array.prototype.forEach.call(document.querySelectorAll('button[aria-label="收起 Git 变更"], button[aria-label="展开 Git 变更"]'), function(button) {
              var open = button.getAttribute('aria-label') === '收起 Git 变更';
              var slot = button.firstElementChild;
              if (!slot || slot.tagName.toLowerCase() === 'svg') {
                button.innerHTML = chevron(open, 14);
                count += 1;
                return;
              }
              if (normalizeSlot(slot, open, 14)) {
                count += 1;
              }
            });
            return count;
          }
          function patchBranchButtons() {
            var count = 0;
            Array.prototype.forEach.call(document.querySelectorAll('[aria-label="Git 变更"], [title="Git 变更"]'), function(label) {
              var group = label.parentElement;
              if (!group || !group.querySelector) {
                return;
              }
              var button = group.querySelector('button:not([aria-label])');
              if (!button) {
                return;
              }
              var children = button.children;
              if (!children || children.length < 2) {
                return;
              }
              var branchText = String((children[0] && children[0].textContent) || '').trim();
              if (!branchText) {
                return;
              }
              var open = !!(button.parentElement && button.parentElement.children && button.parentElement.children.length > 1);
              var slot = children[children.length - 1];
              if (normalizeSlot(slot, open, 14)) {
                count += 1;
              }
            });
            return count;
          }
          function patch() {
            patchExpandButtons();
            patchBranchButtons();
          }
          patch();
          window.setTimeout(patch, 300);
          window.setTimeout(patch, 1200);
          if (!window.__mindfsHarmonyGitChevronObserver) {
            var scheduled = false;
            window.__mindfsHarmonyGitChevronObserver = new MutationObserver(function() {
              if (scheduled) {
                return;
              }
              scheduled = true;
              window.requestAnimationFrame(function() {
                scheduled = false;
                patch();
              });
            });
            window.__mindfsHarmonyGitChevronObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label'] });
          }
        } catch (_error) {
        }
      })();
    `).catch((error: Error) => {
      console.warn(`MindFS git chevron fix inject failed: ${JSON.stringify(error)}`);
    });
  }

  private injectRelayListSafeArea(): void {
    const rawSafeArea = this.bridge.getSystemSafeArea();
    const rawSafeAreaLiteral = JSON.stringify(rawSafeArea);
    this.controller.runJavaScript(`
      (function(){
        try {
          var rawNativeSafeArea = ${rawSafeAreaLiteral};
          function parseSafeArea(raw) {
            if (!raw) {
              return { top: 0, bottom: 0 };
            }
            try {
              return typeof raw === 'string' ? JSON.parse(raw) : raw;
            } catch (_error) {
              return { top: 0, bottom: 0 };
            }
          }
          function safeArea() {
            return rawNativeSafeArea;
          }
          function applyValue(raw) {
            var area = parseSafeArea(raw);
            var top = Math.max(0, Number(area && area.top) || 0);
            var bottom = Math.max(0, Number(area && area.bottom) || 0);
            document.documentElement.style.setProperty('--mindfs-safe-area-top', top + 'px');
            document.documentElement.style.setProperty('--mindfs-safe-area-bottom', bottom + 'px');
            if (!document.getElementById('mindfs-harmony-relay-list-safe-area')) {
              var style = document.createElement('style');
              style.id = 'mindfs-harmony-relay-list-safe-area';
              style.textContent = [
                '#root,body>div:first-child{',
                'padding-top:var(--mindfs-safe-area-top,0px)!important;',
                'box-sizing:border-box!important;',
                'min-height:calc(100vh - var(--mindfs-safe-area-top,0px))!important;',
                '}'
              ].join('');
              document.head.appendChild(style);
            }
          }
          function apply() {
            var raw = safeArea();
            if (!raw) {
              return;
            }
            applyValue(raw);
          }
          apply();
          window.setTimeout(apply, 120);
          window.setTimeout(apply, 500);
        } catch (_error) {
        }
      })();
    `).catch((error: Error) => {
      console.warn(`MindFS relay list safe area inject failed: ${JSON.stringify(error)}`);
    });
  }

  build() {
    Stack() {
      Web({
        src: `${this.appOrigin}index.html`,
        controller: this.controller
      })
        .javaScriptAccess(true)
        .domStorageAccess(true)
        .databaseAccess(true)
        .fileAccess(true)
        .mixedMode(MixedMode.All)
        .javaScriptOnDocumentStart([{
          script: `
            window.__MIND_FS_NATIVE_PLATFORM__ = 'harmony';
            if (!window.Capacitor) {
              window.Capacitor = {};
            }
            if (typeof window.Capacitor.isNativePlatform !== 'function') {
              window.Capacitor.isNativePlatform = function(){ return true; };
            }
            if (typeof window.Capacitor.getPlatform !== 'function') {
              window.Capacitor.getPlatform = function(){ return 'harmony'; };
            }
            if (typeof window.Capacitor.isPluginAvailable !== 'function') {
              window.Capacitor.isPluginAvailable = function(){ return false; };
            }
            (function(){
              var cap = window.Capacitor = window.Capacitor || {};
              cap.Plugins = cap.Plugins || {};
              cap.PluginHeaders = cap.PluginHeaders || [];
              var hasReplyPoller = false;
              for (var i = 0; i < cap.PluginHeaders.length; i += 1) {
                if (cap.PluginHeaders[i] && cap.PluginHeaders[i].name === 'ReplyPoller') {
                  hasReplyPoller = true;
                  break;
                }
              }
              if (!hasReplyPoller) {
                cap.PluginHeaders.push({
                  name: 'ReplyPoller',
                  methods: [{ name: 'configure', rtype: 'promise' }]
                });
              }
              var previousNativePromise = cap.nativePromise;
              cap.nativePromise = function(pluginName, methodName, options) {
                if (pluginName === 'ReplyPoller' && methodName === 'configure') {
                  return new Promise(function(resolve, reject) {
                    try {
                      var bridge = window.MindFSNative || window.MindFSHarmony || null;
                      if (!bridge || typeof bridge.configureReplyPoller !== 'function') {
                        reject(new Error('MindFS native bridge unavailable'));
                        return;
                      }
                      var raw = typeof options === 'string' ? options : JSON.stringify(options || {});
                      var error = bridge.configureReplyPoller(raw);
                      if (error) {
                        reject(new Error(String(error)));
                        return;
                      }
                      resolve();
                    } catch (error) {
                      reject(error);
                    }
                  });
                }
                if (typeof previousNativePromise === 'function') {
                  return previousNativePromise.apply(this, arguments);
                }
                return Promise.reject(new Error('"' + pluginName + '" plugin is not implemented on harmony'));
              };
              window.MindFSReplyPoller = {
                configure: function(payload) {
                  var bridge = window.MindFSNative || window.MindFSHarmony || null;
                  if (!bridge || typeof bridge.configureReplyPoller !== 'function') {
                    return;
                  }
                  bridge.configureReplyPoller(typeof payload === 'string' ? payload : JSON.stringify(payload || {}));
                }
              };
              window.dispatchEvent(new CustomEvent('mindfs:native-bridge-ready', { detail: { platform: 'harmony' } }));
              window.setTimeout(function(){
                window.dispatchEvent(new CustomEvent('mindfs:native-bridge-ready', { detail: { platform: 'harmony' } }));
              }, 250);
              window.setTimeout(function(){
                window.dispatchEvent(new CustomEvent('mindfs:native-bridge-ready', { detail: { platform: 'harmony' } }));
              }, 1000);
            })();
            (function(){
              function parseSafeArea(raw) {
                if (!raw) {
                  return { top: 0, bottom: 0 };
                }
                try {
                  return typeof raw === 'string' ? JSON.parse(raw) : raw;
                } catch (_error) {
                  return { top: 0, bottom: 0 };
                }
              }
              function applySafeArea() {
                try {
                  var bridge = window.MindFSNative || window.MindFSHarmony || null;
                  if (!bridge || typeof bridge.getSystemSafeArea !== 'function') {
                    return false;
                  }
                  function applyValue(raw) {
                    var area = parseSafeArea(raw);
                    var top = Math.max(0, Number(area && area.top) || 0);
                    var bottom = Math.max(0, Number(area && area.bottom) || 0);
                    document.documentElement.style.setProperty('--mindfs-safe-area-top', top + 'px');
                    document.documentElement.style.setProperty('--mindfs-safe-area-bottom', bottom + 'px');
                    window.dispatchEvent(new CustomEvent('mindfs:safe-area-updated', { detail: { top: top, bottom: bottom } }));
                  }
                  var raw = bridge.getSystemSafeArea();
                  if (raw && typeof raw.then === 'function') {
                    raw.then(applyValue).catch(function(){});
                  } else {
                    applyValue(raw);
                  }
                  return true;
                } catch (_error) {
                  return false;
                }
              }
              if (!applySafeArea()) {
                window.setTimeout(applySafeArea, 0);
                window.setTimeout(applySafeArea, 120);
                window.setTimeout(applySafeArea, 500);
              }
            })();
            (function(){
              function nativeBridge() {
                return window.MindFSNative || window.MindFSHarmony || null;
              }
              function notifyVisibility(value) {
                try {
                  var bridge = nativeBridge();
                  if (bridge && typeof bridge.setAppVisibility === 'function') {
                    bridge.setAppVisibility(value);
                  }
                } catch (_error) {
                }
              }
              function dispatchPendingReplySession() {
                try {
                  var bridge = nativeBridge();
                  if (!bridge || typeof bridge.consumePendingReplySession !== 'function') {
                    return;
                  }
                  var raw = bridge.consumePendingReplySession();
                  if (!raw) {
                    return;
                  }
                  var detail = JSON.parse(raw);
                  window.__mindfsPendingReplySession = detail;
                  window.dispatchEvent(new CustomEvent('mindfs:open-reply-session', { detail: detail }));
                } catch (error) {
                  console.error('[MindFS pending reply session] ' + String(error && (error.stack || error.message || error)));
                }
              }
              if (!window.__mindfsHarmonyNativeHooksInstalled) {
                window.__mindfsHarmonyNativeHooksInstalled = true;
                document.addEventListener('visibilitychange', function() {
                  notifyVisibility(document.visibilityState === 'hidden' ? 'hidden' : 'visible');
                });
                window.addEventListener('pagehide', function() { notifyVisibility('hidden'); });
                window.addEventListener('pageshow', function() { notifyVisibility('visible'); });
                window.addEventListener('focus', function() { notifyVisibility('visible'); });
                window.addEventListener('blur', function() { notifyVisibility('hidden'); });
                window.setInterval(dispatchPendingReplySession, 500);
              }
              notifyVisibility(document.visibilityState === 'hidden' ? 'hidden' : 'visible');
              window.__mindfsDispatchPendingReplySession = dispatchPendingReplySession;
            })();
            try {
              if (window.MindFSNative) {
                window.MindFSNative.platform = 'harmony';
              }
              if (window.MindFSHarmony) {
                window.MindFSHarmony.platform = 'harmony';
              }
            } catch (_error) {
            }
            window.addEventListener('error', function(event) {
              console.error('[MindFS window error] ' + event.message + ' @ ' + event.filename + ':' + event.lineno + ':' + event.colno);
            });
            window.addEventListener('unhandledrejection', function(event) {
              console.error('[MindFS unhandled rejection] ' + String(event.reason && (event.reason.stack || event.reason.message || event.reason)));
            });
          `,
          scriptRules: ['http://*', 'https://*']
        }])
        .javaScriptProxy({
          object: this.bridge,
          name: 'MindFSNative',
          methodList: this.nativeBridgeMethodList(),
          controller: this.controller
        })
        .javaScriptProxy({
          object: this.bridge,
          name: 'MindFSHarmony',
          methodList: this.nativeBridgeMethodList(),
          controller: this.controller
        })
        .javaScriptProxy({
          object: this.bridge,
          name: 'MindFSLauncherNodeSync',
          methodList: ['storeRelayNodes'],
          controller: this.controller
        })
        .onPageBegin((event) => {
          this.configureReplyPollerFromPageUrl(event.url);
        })
        .onPageEnd((event) => {
          const pageUrl = this.controller.getUrl();
          this.saveWebCookies();
          this.injectNativeRuntimeHooks();
          setTimeout(() => {
            this.injectNativeRuntimeHooks();
          }, 350);
          setTimeout(() => {
            this.injectNativeRuntimeHooks();
          }, 1000);
          setTimeout(() => {
            this.injectNativeRuntimeHooks();
          }, 1800);
          if (pageUrl.startsWith(this.appOrigin)) {
            this.injectLauncherRelayEntryVisibility();
            this.hydrateLauncherNodesFromNative();
          }
          if (this.shouldSyncRelayNodes(pageUrl)) {
            this.injectRelayNodeSync();
          }
          if (this.shouldPatchRelayListSafeArea(pageUrl)) {
            this.injectRelayListSafeArea();
            setTimeout(() => {
              this.injectRelayListSafeArea();
            }, 350);
            setTimeout(() => {
              this.injectRelayListSafeArea();
            }, 1000);
          }
          if (this.shouldPatchNodeShell(pageUrl)) {
            this.refreshNodeFrontendCacheOnce();
            this.injectRelayNodeShellControls();
            this.injectGitStatusChevronFix();
          }
          this.controller.runJavaScript(`
            if (!window.MindFSNative && window.MindFSHarmony) {
              window.MindFSNative = window.MindFSHarmony;
            }
            if (typeof window.__mindfsDispatchPendingReplySession === 'function') {
              window.__mindfsDispatchPendingReplySession();
            }
          `);
        })
        .onInterceptRequest((event) => {
          return this.createRawFileResponse(event.request.getRequestUrl());
        })
        .onSslErrorEvent((event) => {
          const host = this.hostFromUrl(event.url || event.originalUrl || '');
          if (this.isLocalNetworkHost(host)) {
            event.handler.handleConfirm();
            return;
          }
          event.handler.handleCancel(false);
        })
        .onErrorReceive((event) => {
          console.error(`MindFS Web load error: ${event.error.getErrorCode()} ${event.error.getErrorInfo()} ${event.request.getRequestUrl()}`);
        })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#0f172a')
  }
}
