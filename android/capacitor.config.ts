import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mindfs.app',
  appName: 'MindFS',
  webDir: 'app/src/main/assets/public',
  bundledWebRuntime: false,
  server: {
    androidScheme: 'http',
    allowNavigation: ['*'],
  },
  plugins: {
    SystemBars: {
      insetsHandling: 'disable',
    },
    StatusBar: {
      overlaysWebView: true,
      backgroundColor: '#0f172a',
      style: 'DARK',
    },
  },
};

export default config;
