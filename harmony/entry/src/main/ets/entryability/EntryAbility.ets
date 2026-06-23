import { UIAbility, Want } from '@kit.AbilityKit';
import { webview } from '@kit.ArkWeb';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { MindFSNativeBridge } from '../native/MindFSNativeBridge';

const DOMAIN = 0x4d46;

export default class EntryAbility extends UIAbility {
  onCreate(want: Want): void {
    MindFSNativeBridge.handleLaunchWant(want);
  }

  private updateSystemSafeArea(mainWindow: window.Window, reason: string, area?: window.AvoidArea): void {
    try {
      const systemAvoidArea =
        area ?? mainWindow.getWindowAvoidAreaIgnoringVisibility(window.AvoidAreaType.TYPE_SYSTEM);
      let top = systemAvoidArea.topRect.height > 0 ? px2vp(systemAvoidArea.topRect.height) : 0;
      let bottom = systemAvoidArea.bottomRect.height > 0 ? px2vp(systemAvoidArea.bottomRect.height) : 0;
      try {
        const cutoutAvoidArea = mainWindow.getWindowAvoidAreaIgnoringVisibility(window.AvoidAreaType.TYPE_CUTOUT);
        if (cutoutAvoidArea.topRect.height > 0) {
          top = Math.max(top, px2vp(cutoutAvoidArea.topRect.height));
        }
      } catch (_error) {
      }
      try {
        const navigationAvoidArea =
          mainWindow.getWindowAvoidAreaIgnoringVisibility(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);
        if (navigationAvoidArea.bottomRect.height > 0) {
          bottom = Math.max(bottom, px2vp(navigationAvoidArea.bottomRect.height));
        }
      } catch (_error) {
      }
      top = top > 0 ? Math.max(24, top) : 24;
      MindFSNativeBridge.setSystemSafeArea(top, bottom);
      hilog.info(
        DOMAIN,
        'MindFS',
        'safe area updated reason=%{public}s top=%{public}d bottom=%{public}d',
        reason,
        top,
        bottom
      );
    } catch (error) {
      hilog.warn(DOMAIN, 'MindFS', 'updateSystemSafeArea failed: %{public}s', JSON.stringify(error));
    }
  }

  private configureWindow(windowStage: window.WindowStage): void {
    try {
      const mainWindow = windowStage.getMainWindowSync();
      try {
        mainWindow.on('systemAvoidAreaChange', (area: window.AvoidArea) => {
          this.updateSystemSafeArea(mainWindow, 'systemAvoidAreaChange', area);
        });
      } catch (error) {
        hilog.warn(DOMAIN, 'MindFS', 'systemAvoidAreaChange listener failed: %{public}s', JSON.stringify(error));
      }
      this.updateSystemSafeArea(mainWindow, 'initial');
      void mainWindow.setWindowLayoutFullScreen(true)
        .then(() => {
          this.updateSystemSafeArea(mainWindow, 'layoutFullScreen');
          setTimeout(() => {
            this.updateSystemSafeArea(mainWindow, 'layoutFullScreenDelayed');
          }, 250);
        })
        .catch((error: Error) => {
          hilog.warn(DOMAIN, 'MindFS', 'setWindowLayoutFullScreen failed: %{public}s', JSON.stringify(error));
        });
      void mainWindow.setWindowSystemBarProperties({
        statusBarColor: '#00000000',
        navigationBarColor: '#00000000',
        statusBarContentColor: '#111827',
        navigationBarContentColor: '#111827',
        isStatusBarLightIcon: false,
        isNavigationBarLightIcon: false
      }).catch((error: Error) => {
        hilog.warn(DOMAIN, 'MindFS', 'setWindowSystemBarProperties failed: %{public}s', JSON.stringify(error));
      });
    } catch (error) {
      hilog.warn(DOMAIN, 'MindFS', 'configureWindow failed: %{public}s', JSON.stringify(error));
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    this.configureWindow(windowStage);
    windowStage.loadContent('pages/Index', (error) => {
      if (error.code) {
        hilog.error(DOMAIN, 'MindFS', 'Failed to load content: %{public}d %{public}s', error.code, error.message);
      }
    });
  }

  onForeground(): void {
    MindFSNativeBridge.setAppForeground(true);
  }

  onBackground(): void {
    try {
      webview.WebCookieManager.saveCookieSync();
    } catch (error) {
      hilog.warn(DOMAIN, 'MindFS', 'save cookies on background failed: %{public}s', JSON.stringify(error));
    }
    MindFSNativeBridge.setAppForeground(false);
    MindFSNativeBridge.resumeConfiguredReplyPolling('background');
  }

  onNewWant(want: Want): void {
    MindFSNativeBridge.handleLaunchWant(want);
  }
}
