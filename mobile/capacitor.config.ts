import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.owenmorgan.satchel',
  appName: 'Bookshelf',
  // The Angular "mobile" configuration builds here (see angular.json).
  webDir: '../dist/bookshelf-mobile',
  ios: {
    // The library server speaks plain HTTP over the tailnet; pair this with
    // NSAllowsArbitraryLoads in Info.plist so fetch/audio both work.
    limitsNavigationsToAppBoundDomains: false,
  },
};

export default config;
