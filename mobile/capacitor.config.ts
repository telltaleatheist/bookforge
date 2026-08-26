import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.owenmorgan.bookshelf',
  appName: 'Bookshelf',
  // The Angular "mobile" configuration builds here (see angular.json).
  webDir: '../dist/bookshelf-mobile',
  ios: {
    // The library server speaks plain HTTP over the tailnet; pair this with
    // NSAllowsArbitraryLoads in Info.plist so fetch/audio both work.
    limitsNavigationsToAppBoundDomains: false,
    // DO NOT set `scheme` here without reading this. ServerConfigService's
    // platform check uses `location.protocol === 'capacitor:'` as its race-free
    // witness that it is running inside this shell — the witness that stops a
    // mis-timed startup from seeding (and persisting) a web-shaped server list
    // that blanks the shelf forever (blip, 2026-08-25). Overriding the scheme
    // (e.g. to `https` for cookie behaviour) silently breaks that witness and
    // leaves only the Capacitor global, which is exactly the read that raced.
    // If a scheme change is ever needed, update isNative in the same commit.
  },
};

export default config;
