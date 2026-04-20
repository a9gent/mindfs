import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.mindfs.app',
  appName: 'MindFS',
  webDir: 'app/src/main/assets/public',
  bundledWebRuntime: false,
  server: {
    androidScheme: 'http',
  },
};

export default config;
