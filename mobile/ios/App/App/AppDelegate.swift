import UIKit
import AVFoundation
import Capacitor
import CapApp_SPM

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Prime the category only. At launch nothing is loaded yet, so we must
        // NOT activate — activating a non-mixable .playback session here would
        // stop whatever the user is already listening to (Spotify/a podcast)
        // the instant Bookshelf opens. The native player activates on its play
        // path once a book actually plays.
        configureAudioSession(activate: false)
        return true
    }

    /// UIBackgroundModes=audio (Info.plist) only grants PERMISSION to keep
    /// running; iOS still silences WKWebView audio on background/lock unless the
    /// app holds an active `.playback` audio session. `.spokenAudio` is the
    /// audiobook-appropriate mode (ducking behavior, route handling).
    ///
    /// Setting the category is harmless to other apps; only `setActive(true)`
    /// on this non-mixable session interrupts them. So activation is gated: the
    /// caller activates only when Bookshelf is actually playing.
    /// See `NativeAudioPlugin.isPlaying`.
    private func configureAudioSession(activate: Bool) {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio)
            if activate {
                try session.setActive(true)
            }
        } catch {
            print("[Bookshelf] AVAudioSession setup failed: \(error)")
        }
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Re-assert after phone calls / Siri / other apps claimed the session,
        // but ONLY when we are actually PLAYING. Re-activating while idle OR
        // merely paused would interrupt other apps' audio every time the user
        // returns to Bookshelf. When we're playing, re-activating a session we
        // already hold is a self-no-op that reclaims nothing from anyone — it
        // just guarantees the Now Playing slot / AirPods button stay ours.
        // (Post-phone-call recovery for a paused book is handled by the plugin's
        // interruption-.ended reclaim, not here.)
        configureAudioSession(activate: NativeAudioPlugin.isPlaying)
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
