import Foundation
import AVFoundation
import MediaPlayer
import Capacitor

/// Native AVPlayer bridge for gapless, lock-safe audiobook playback.
///
/// Why this exists: the web `<audio>` element inside a WKWebView is
/// suspended-and-resumed by iOS whenever the screen locks or the app is
/// backgrounded. Audio survives (that fix already shipped), but there's a
/// ~0.5s drop at the suspend/resume seam — the "blip". AVPlayer plays through
/// the native audio stack, so it never enters that cycle: playback is truly
/// continuous across lock. It also supports ARBITRARY playback rates (2x, 3x,
/// 4x) with pitch correction via `audioTimePitchAlgorithm = .timeDomain`,
/// which the off-the-shelf Capacitor audio plugins do not (they cap at 1.0x).
///
/// Registered via `packageClassList` in capacitor.config.json — see
/// mobile/scripts/register-native-plugin.mjs, which re-adds it after every
/// `cap sync` (sync regenerates that list from npm plugins only).
@objc(NativeAudioPlugin)
public class NativeAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeAudioPlugin"
    public let jsName = "NativeAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setChapters", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "armSleep", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearSleep", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "destroy", returnType: CAPPluginReturnPromise),
    ]

    private var player: AVPlayer?
    private var item: AVPlayerItem?
    private var timeObserver: Any?
    private var statusObs: NSKeyValueObservation?
    private var stateObs: NSKeyValueObservation?
    private var lastNotifiedState = ""
    private var rate: Float = 1.0
    private var vol: Float = 1.0
    private var duration: Double = 0
    private var commandsWired = false
    private var interruptionWired = false
    private var npInfo: [String: Any] = [:]

    /// Chapter start times (seconds), pushed by JS after a book's chapters load
    /// (see setChapters). The lock-screen prev/next-track commands need these to
    /// seek chapter boundaries NATIVELY — JS is frozen while the screen is locked,
    /// so it can't compute the target. Empty ⇒ prev/next are no-ops.
    private var chapterTimes: [Double] = []

    /// Native sleep-timer backstop. JS owns the sleep UI/countdown, but its timer
    /// (checkSleep, driven by 'timeupdate') can't fire while the WebView is frozen
    /// on the lock screen, so audio would play all night. JS arms ONE of these to
    /// pause the AVPlayer at the same moment it would have — freeze-proof because
    /// the native process stays alive during background audio.
    ///   • wall-clock 'time' countdown → a DispatchWorkItem after N real ms
    ///   • content-position 'chapter'  → an AVPlayer boundary time observer
    private var sleepTimer: DispatchWorkItem?
    private var sleepBoundaryObserver: Any?

    /// True while Bookshelf is ACTIVELY PLAYING through the native AVPlayer.
    /// AppDelegate reads this to decide whether foregrounding should re-ACTIVATE
    /// the audio session. Activating a non-mixable .playback session interrupts
    /// other apps, so we only do it when we already own playback (re-activating
    /// a session we already hold is a self-no-op — it steals from nobody). While
    /// idle OR merely loaded-but-paused, the app must not proactively activate,
    /// or opening/returning to Bookshelf would stop Spotify/a podcast. Mutated
    /// only on the main queue (doPlay/doPause/teardown run there), where
    /// AppDelegate lifecycle callbacks also run.
    public private(set) static var isPlaying = false

    // ── Native position persistence ─────────────────────────────────────────────
    // Why this lives here: while the app is backgrounded/locked the WKWebView's
    // content process is suspended within minutes, so the JS position saver
    // (localStorage every 5s + server posts) stops firing — but this AVPlayer
    // keeps playing for HOURS. Without a native saver, a whole night of listening
    // is lost and reopening resumes at the last foregrounded moment. So the plugin
    // persists progress itself and hands it back to JS as an extra resume
    // candidate (see getPosition + audio-backend.ts / player.service.ts).
    private var posKey = ""            // book's downloadPath; empty ⇒ don't persist (read-aloud)
    private var lastPersistAt: Double = 0  // epoch MS of the last write, for the ~5s throttle
    private static let positionSlot = "NativeAudio.position"

    /// Persist `time` under the current book's key. `at` is epoch MILLISECONDS so
    /// JS can compare it directly against `Date.now()` when picking the newest of
    /// local/server/native. Skips a non-positive time UNLESS `allowZero` (an
    /// explicit seek to 0 — "start over" — must overwrite the slot, else JS's
    /// resetProgress would resurrect the old position from here).
    private func persistPosition(_ time: Double, allowZero: Bool = false) {
        guard !posKey.isEmpty else { return }
        guard allowZero || (time.isFinite && time > 0) else { return }
        lastPersistAt = Date().timeIntervalSince1970 * 1000
        UserDefaults.standard.set(
            ["key": posKey, "time": time.isFinite ? time : 0, "at": lastPersistAt],
            forKey: NativeAudioPlugin.positionSlot)
    }

    // MARK: - JS API

    @objc func load(_ call: CAPPluginCall) {
        guard let urlStr = call.getString("url"), let url = URL(string: urlStr) else {
            call.reject("load: missing/invalid url"); return
        }
        let key = call.getString("key") ?? ""
        DispatchQueue.main.async {
            // Category only — loading (or restoring a paused book at launch)
            // must never activate/steal the session from another app.
            self.configureSessionCategory()
            self.wireInterruptions()
            // Persist the OUTGOING book before the swap: the WebView that would
            // normally save it may be frozen (backgrounded), so this is the only
            // reliable save. Still under the OLD posKey — teardownPlayer persists
            // too, but do it explicitly so the intent is clear.
            if self.player != nil, !self.posKey.isEmpty {
                self.persistPosition(self.player?.currentTime().seconds ?? -1)
            }
            self.teardownPlayer()
            self.posKey = key
            // Guard the slot against the AVPlayer's transient currentTime == 0 right
            // after load: pretend we just persisted so the periodic observer won't
            // clobber the slot before JS performs its initial resume seek (which
            // goes through seek() and writes the correct value).
            self.lastPersistAt = Date().timeIntervalSince1970 * 1000

            let item = AVPlayerItem(url: url)
            // .timeDomain is Apple's voice-optimized time-stretch: preserves
            // pitch/intelligibility well past 2x (this is the whole point of
            // going native — fast audiobook playback that still sounds right).
            item.audioTimePitchAlgorithm = .timeDomain
            let player = AVPlayer(playerItem: item)
            player.automaticallyWaitsToMinimizeStalling = true
            player.volume = self.vol
            self.item = item
            self.player = player

            self.statusObs = item.observe(\.status, options: [.new]) { [weak self] it, _ in
                guard let self = self else { return }
                if it.status == .readyToPlay {
                    let d = it.duration.seconds
                    self.duration = d.isFinite ? d : 0
                    self.notifyListeners("ready", data: ["duration": self.duration])
                } else if it.status == .failed {
                    self.notifyListeners("error", data: ["message": it.error?.localizedDescription ?? "load failed"])
                }
            }

            let interval = CMTime(seconds: 0.25, preferredTimescale: 600)
            self.timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] t in
                guard let self = self else { return }
                let cur = t.seconds
                let safe = cur.isFinite ? cur : 0
                self.notifyListeners("time", data: ["currentTime": safe])
                self.updateNowPlayingElapsed(safe)
                // Throttled native save (~5s) — the real progress saver while the
                // WebView is frozen in the background.
                if safe > 0 {
                    let nowMs = Date().timeIntervalSince1970 * 1000
                    if nowMs - self.lastPersistAt >= 5000 { self.persistPosition(safe) }
                }
            }

            NotificationCenter.default.addObserver(
                self, selector: #selector(self.didEnd),
                name: .AVPlayerItemDidPlayToEndTime, object: item)

            // System-initiated pauses (route loss when AirPods come out, resource
            // pressure…) never pass through pause(), so mirror the player's real
            // transport state to JS from here. emitState dedupes the echoes of
            // our own doPlay/doPause.
            self.lastNotifiedState = ""
            self.stateObs = player.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    let playing = p.timeControlStatus != .paused
                    // At end-of-book the status flips to .paused as the ended
                    // notification fires — let didEnd() report that instead: a
                    // "paused" here would read as an external pause, and the JS
                    // route-change policy would auto-resume past the end.
                    if !playing, let it = self.item, it.duration.isNumeric,
                       it.currentTime().seconds >= it.duration.seconds - 0.75 { return }
                    self.emitState(playing ? "playing" : "paused")
                    self.updateNowPlaying(playing: playing)
                }
            }

            self.wireRemoteCommands()
            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.doPlay()
            call.resolve()
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.doPause()
            call.resolve()
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        let time = call.getDouble("time") ?? 0
        DispatchQueue.main.async {
            let cm = CMTime(seconds: time, preferredTimescale: 600)
            self.player?.seek(to: cm, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
                // Persist even a seek to 0: an explicit "start over" must overwrite
                // the slot, or resetProgress in JS would find the stale position here.
                self?.persistPosition(time, allowZero: true)
                self?.notifyListeners("time", data: ["currentTime": time])
                self?.updateNowPlayingElapsed(time)
                call.resolve()
            }
        }
    }

    @objc func setRate(_ call: CAPPluginCall) {
        let r = Float(call.getDouble("rate") ?? 1.0)
        self.rate = r
        DispatchQueue.main.async {
            // Setting rate > 0 also resumes playback, so only apply live when
            // already playing; otherwise it's stored and used by the next play().
            if let p = self.player, p.timeControlStatus == .playing {
                p.rate = r
            }
            self.updateNowPlaying(playing: self.player?.timeControlStatus == .playing)
            call.resolve()
        }
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        let v = Float(call.getDouble("volume") ?? 1.0)
        self.vol = v
        DispatchQueue.main.async { self.player?.volume = v; call.resolve() }
    }

    @objc func setNowPlaying(_ call: CAPPluginCall) {
        let title = call.getString("title") ?? ""
        let artist = call.getString("artist") ?? ""
        let artworkUrl = call.getString("artworkUrl")
        DispatchQueue.main.async {
            self.npInfo[MPMediaItemPropertyTitle] = title
            self.npInfo[MPMediaItemPropertyArtist] = artist
            self.npInfo[MPMediaItemPropertyPlaybackDuration] = self.duration
            self.npInfo[MPNowPlayingInfoPropertyPlaybackRate] = self.player?.rate ?? 0
            self.npInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = self.player?.currentTime().seconds ?? 0
            // Drop the previous book's artwork up front: this call means the book
            // (or its metadata) changed, and if the new artwork is absent or fails
            // to load, leaving the old MPMediaItemArtwork in place shows the WRONG
            // book on the lock screen. loadArtwork re-adds it once decoded.
            self.npInfo[MPMediaItemPropertyArtwork] = nil
            MPNowPlayingInfoCenter.default().nowPlayingInfo = self.npInfo
            // Claim (or hold) the Now Playing card at load, matching current state —
            // a restored-but-paused book should still own the card.
            MPNowPlayingInfoCenter.default().playbackState =
                self.player?.timeControlStatus == .playing ? .playing : .paused
            if let s = artworkUrl { self.loadArtwork(s) }
            call.resolve()
        }
    }

    /// Hand a saved position back to JS as an extra resume candidate. JS can't
    /// see progress made while its own WebView was frozen (backgrounded), so it
    /// asks the native side, which kept saving. Prefers the LIVE position when
    /// this book is still loaded natively (covers a WebView reload while audio
    /// keeps playing); otherwise falls back to the persisted slot.
    @objc func getPosition(_ call: CAPPluginCall) {
        let key = call.getString("key") ?? ""
        DispatchQueue.main.async {
            // Only stamp the live position at:now while actually PLAYING. When paused
            // the position hasn't advanced, but at:now would still beat a genuinely
            // newer server position from another device (pickStart is max-at-wins),
            // so after a WebContent reload the phone would resume at a stale spot and
            // clobber the server. Paused ⇒ fall through to the persisted slot, which
            // carries the REAL saved timestamp (doPause persists on pause).
            if NativeAudioPlugin.isPlaying, self.player != nil, !self.posKey.isEmpty, self.posKey == key {
                let t = self.player?.currentTime().seconds ?? 0
                let nowMs = Date().timeIntervalSince1970 * 1000
                call.resolve(["time": t.isFinite ? t : 0, "at": nowMs])
                return
            }
            if let slot = UserDefaults.standard.dictionary(forKey: NativeAudioPlugin.positionSlot),
               let storedKey = slot["key"] as? String, storedKey == key,
               let storedTime = slot["time"] as? Double {
                let at = slot["at"] as? Double ?? storedTime
                call.resolve(["time": storedTime, "at": at])
                return
            }
            call.resolve([:])
        }
    }

    /// Receive the current book's chapter start times (seconds) so the lock-screen
    /// prev/next-track commands can seek boundaries natively (JS is frozen while
    /// locked). Cleared with an empty array on unload.
    @objc func setChapters(_ call: CAPPluginCall) {
        let raw = call.getArray("times") ?? []
        DispatchQueue.main.async {
            self.chapterTimes = raw
                .compactMap { ($0 as? NSNumber)?.doubleValue }
                .filter { $0.isFinite }
                .sorted()
            call.resolve()
        }
    }

    /// Arm the native sleep backstop. JS passes exactly one of:
    ///   • `atPosition` (seconds) — pause when the AVPlayer reaches this content
    ///     position (end-of-chapter mode); a boundary observer, speed-independent.
    ///   • `afterMs` — pause after this many REAL milliseconds (wall-clock 'time'
    ///     countdown); a DispatchWorkItem, fires even while backgrounded.
    /// Idempotent: any previously-armed backstop is cleared first, so JS can freely
    /// re-arm on target changes (extend timer, seek in chapter mode).
    @objc func armSleep(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.clearSleepInternal()
            if let atPosition = call.getDouble("atPosition") {
                guard let player = self.player else { call.resolve(); return }
                let cm = CMTime(seconds: max(0, atPosition), preferredTimescale: 600)
                self.sleepBoundaryObserver = player.addBoundaryTimeObserver(
                    forTimes: [NSValue(time: cm)], queue: .main) { [weak self] in
                    self?.fireSleep()
                }
            } else if let afterMs = call.getDouble("afterMs") {
                let work = DispatchWorkItem { [weak self] in self?.fireSleep() }
                self.sleepTimer = work
                DispatchQueue.main.asyncAfter(deadline: .now() + max(0, afterMs) / 1000.0, execute: work)
            }
            call.resolve()
        }
    }

    /// Disarm the native sleep backstop. Safe when nothing is armed.
    @objc func clearSleep(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.clearSleepInternal()
            call.resolve()
        }
    }

    private func clearSleepInternal() {
        sleepTimer?.cancel()
        sleepTimer = nil
        if let o = sleepBoundaryObserver { player?.removeTimeObserver(o); sleepBoundaryObserver = nil }
    }

    /// The sleep backstop fired (likely while JS was frozen). Signal the 'sleep'
    /// intent to JS BEFORE pausing — same ordering as remoteTransport — so JS's
    /// auto-resume policy clears `wantPlaying` and won't fight the stop when it
    /// thaws. Pause via doPause() so isPlaying/session/emitState stay consistent.
    private func fireSleep() {
        clearSleepInternal()
        notifyListeners("command", data: ["action": "sleep"])
        doPause()
    }

    @objc func destroy(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.teardownPlayer()
            self.npInfo = [:]
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            // Genuine teardown (player ✕ / book unload) SHOULD relinquish the slot.
            MPNowPlayingInfoCenter.default().playbackState = .stopped
            call.resolve()
        }
    }

    // MARK: - transport core

    /// All play/pause paths (JS calls, remote commands, interruptions) funnel
    /// here, so transport never depends on the WebView being awake — iOS
    /// suspends it within minutes of backgrounding while paused, and a
    /// lock-screen play that round-trips through frozen JS plays nothing.
    private func doPlay() {
        activateSession()
        NativeAudioPlugin.isPlaying = true
        player?.playImmediately(atRate: rate)
        emitState("playing")
        updateNowPlaying(playing: true)
    }

    private func doPause() {
        NativeAudioPlugin.isPlaying = false
        player?.pause()
        // Save on pause — the WebView may already be frozen, so JS's pause-save
        // can't be relied on.
        persistPosition(player?.currentTime().seconds ?? -1)
        // Keep the audio session ACTIVE while paused — on iOS the app with the
        // most recently active .playback session owns the Now Playing slot and
        // the AirPods play button. Deactivating here (or letting WebKit do it)
        // hands both back to the previously-playing app. This re-activation is a
        // self-no-op (we already hold the session from doPlay), so it interrupts
        // nobody — but it must NOT be triggered proactively on foreground, which
        // is why AppDelegate gates its reclaim on isPlaying, not on being paused.
        activateSession()
        emitState("paused")
        updateNowPlaying(playing: false)
    }

    /// Single funnel for 'state' events; dedupes so the timeControlStatus
    /// observer doesn't echo transitions doPlay/doPause already reported.
    private func emitState(_ s: String) {
        if s == lastNotifiedState { return }
        lastNotifiedState = s
        notifyListeners("state", data: ["state": s])
    }

    // MARK: - internals

    @objc private func didEnd() {
        NativeAudioPlugin.isPlaying = false
        persistPosition(player?.currentTime().seconds ?? -1)
        emitState("ended")
        notifyListeners("ended", data: [:])
        updateNowPlaying(playing: false)
    }

    /// Set the audiobook-appropriate category WITHOUT activating. Harmless to
    /// other apps — it never interrupts. Called from load(): loading (or
    /// restoring a paused book on launch) must not steal the session.
    private func configureSessionCategory() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .spokenAudio)
    }

    /// Set the category AND activate. Activating a non-mixable .playback session
    /// is the ONLY step that interrupts other apps, so this is called only when
    /// Bookshelf legitimately owns playback: doPlay(), the keep-slot-while-paused
    /// path in doPause(), and the interruption-.ended reclaim.
    private func activateSession() {
        configureSessionCategory()
        let s = AVAudioSession.sharedInstance()
        try? s.setActive(true)
    }

    /// Resume after a phone call / Siri / other interruption, so playback
    /// recovers on its own the way a native audiobook app does.
    private func wireInterruptions() {
        if interruptionWired { return }
        interruptionWired = true
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification, object: nil)
    }

    @objc private func handleInterruption(_ note: Notification) {
        guard let info = note.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            NativeAudioPlugin.isPlaying = false
            persistPosition(player?.currentTime().seconds ?? -1)
            emitState("paused")
            updateNowPlaying(playing: false)
        case .ended:
            let opts = AVAudioSession.InterruptionOptions(
                rawValue: info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            if opts.contains(.shouldResume) {
                doPlay()
            } else {
                // The interruption deactivated our session; reclaim it even if
                // we stay paused, or the Now Playing slot (and the AirPods play
                // button) falls back to the previous media app.
                activateSession()
            }
        @unknown default: break
        }
    }

    private func teardownPlayer() {
        // Read the live position and persist it BEFORE releasing the player, so a
        // book unload / player swap doesn't drop the last few unsaved seconds.
        persistPosition(player?.currentTime().seconds ?? -1)
        // Drop any armed sleep backstop while the player is still live (the boundary
        // observer must be removed from the player it was added to).
        clearSleepInternal()
        chapterTimes = []
        if let t = timeObserver { player?.removeTimeObserver(t); timeObserver = nil }
        statusObs?.invalidate(); statusObs = nil
        stateObs?.invalidate(); stateObs = nil
        lastNotifiedState = ""
        NotificationCenter.default.removeObserver(self, name: .AVPlayerItemDidPlayToEndTime, object: nil)
        player?.pause()
        player = nil; item = nil; duration = 0
        NativeAudioPlugin.isPlaying = false
    }

    // MARK: - Now Playing / lock-screen artwork

    private func loadArtwork(_ urlString: String) {
        if urlString.hasPrefix("data:") {
            guard let comma = urlString.firstIndex(of: ","),
                  let data = Data(base64Encoded: String(urlString[urlString.index(after: comma)...])),
                  let img = UIImage(data: data) else { return }
            setArtwork(img); return
        }
        guard let url = URL(string: urlString) else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data = data, let img = UIImage(data: data) else { return }
            self?.setArtwork(img)
        }.resume()
    }

    private func setArtwork(_ img: UIImage) {
        let art = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
        DispatchQueue.main.async {
            self.npInfo[MPMediaItemPropertyArtwork] = art
            MPNowPlayingInfoCenter.default().nowPlayingInfo = self.npInfo
        }
    }

    private func updateNowPlaying(playing: Bool) {
        npInfo[MPNowPlayingInfoPropertyPlaybackRate] = playing ? (player?.rate ?? rate) : 0
        npInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = player?.currentTime().seconds ?? 0
        npInfo[MPMediaItemPropertyPlaybackDuration] = duration
        MPNowPlayingInfoCenter.default().nowPlayingInfo = npInfo
        // NOTE: on iOS, `MPNowPlayingInfoCenter.playbackState` is honored on
        // macOS/Catalyst only — it is NOT what holds the Now Playing slot here
        // (a previous fix leaned on it and did nothing). On iOS the slot follows
        // the ACTIVE AVAudioSession: doPause() keeps ours active, and nothing may
        // deactivate it while a book is loaded — see also the guards in
        // player.service.ts that stop the WebView from poking WebKit's
        // mediaSession/audioSession (WebKit would deactivate the session ~1s
        // after a "paused" signal, handing the AirPods button to the previous app).
        MPNowPlayingInfoCenter.default().playbackState = playing ? .playing : .paused
    }

    private func updateNowPlayingElapsed(_ t: Double) {
        guard !npInfo.isEmpty else { return }
        npInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = t
        MPNowPlayingInfoCenter.default().nowPlayingInfo = npInfo
    }

    /// Play/pause from the lock screen / AirPods act on AVPlayer HERE, natively;
    /// JS still gets the 'command' (pre-resolved — never 'toggle') purely as an
    /// intent signal, sent BEFORE the state change so its auto-resume policy
    /// sees the deliberate pause first. Routing transport through JS was one of
    /// the "loses the thread" failure modes: with the app backgrounded and
    /// paused, iOS suspends the WebView, so a remote play died in frozen JS.
    private func remoteTransport(playing: Bool) {
        DispatchQueue.main.async {
            self.notifyListeners("command", data: ["action": playing ? "play" : "pause"])
            if playing { self.doPlay() } else { self.doPause() }
        }
    }

    /// Seek the AVPlayer to `seconds` (clamped to [0, duration]) NATIVELY and keep
    /// everything else in sync: persist, refresh Now Playing elapsed, push a 'time'
    /// event so the JS mirror + lock-screen scrubber follow, AND a distinct 'seeked'
    /// event. Used by the lock-screen skip / scrub / chapter commands, which must
    /// work while JS is frozen. Deliberately emits NO 'command' event — a queued
    /// command would replay in a burst when JS thaws (double-skip); JS re-syncs from
    /// 'time'. The 'seeked' event is what lets JS distinguish a deliberate jump
    /// (re-anchor listening time so the skipped span isn't credited) from a plain
    /// 'time' thaw-jump (real background playback that MUST count as listened).
    private func nativeSeek(to seconds: Double) {
        guard let player = self.player else { return }
        let clamped = duration > 0 ? max(0, min(seconds, duration)) : max(0, seconds)
        let cm = CMTime(seconds: clamped, preferredTimescale: 600)
        player.seek(to: cm, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            guard let self = self else { return }
            self.persistPosition(clamped, allowZero: clamped <= 0)
            self.updateNowPlayingElapsed(clamped)
            self.notifyListeners("time", data: ["currentTime": clamped])
            self.notifyListeners("seeked", data: ["time": clamped])
        }
    }

    /// Lock-screen prev/next-track → seek the adjacent chapter boundary natively.
    /// Needs chapterTimes (set by JS); a no-op when none are set. `prev` mirrors the
    /// in-app rule: >3s into a chapter restarts it, otherwise steps to the previous.
    private func seekToAdjacentChapter(next: Bool) {
        guard let player = self.player, !chapterTimes.isEmpty else { return }
        let cur = player.currentTime().seconds
        if next {
            if let target = chapterTimes.first(where: { $0 > cur + 0.5 }) { nativeSeek(to: target) }
            // else already in the last chapter → no-op
        } else {
            let curStart = chapterTimes.last(where: { $0 <= cur + 0.001 }) ?? chapterTimes.first ?? 0
            if cur - curStart > 3 {
                nativeSeek(to: curStart)
            } else if let prev = chapterTimes.last(where: { $0 < curStart - 0.001 }) {
                nativeSeek(to: prev)
            }
            // else first chapter, near its start → no-op
        }
    }

    private func wireRemoteCommands() {
        if commandsWired { return }
        commandsWired = true
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in
            self?.remoteTransport(playing: true); return .success }
        c.pauseCommand.addTarget { [weak self] _ in
            self?.remoteTransport(playing: false); return .success }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.remoteTransport(playing: self.player?.timeControlStatus == .paused)
            return .success }
        // Skips / scrub / chapter jumps are performed NATIVELY for the audiobook —
        // a single continuous track (posKey set) — so they work with the screen
        // locked while JS is frozen, and emit NO 'command' (which would replay in a
        // burst on thaw → double-skip). JS re-syncs position from the 'time' events
        // nativeSeek emits. The read-aloud facade (posKey EMPTY) plays sentence-by-
        // sentence — advancing needs the next sentence's URL, which only JS has — so
        // there it must still round-trip the command (see isSingleTrack).
        c.skipForwardCommand.preferredIntervals = [30]
        c.skipForwardCommand.addTarget { [weak self] ev in
            guard let self = self, let p = self.player else { return .commandFailed }
            if self.isSingleTrack {
                let interval = (ev as? MPSkipIntervalCommandEvent)?.interval ?? 30
                self.nativeSeek(to: p.currentTime().seconds + interval)
            } else {
                self.notifyListeners("command", data: ["action": "skipForward"])
            }
            return .success }
        c.skipBackwardCommand.preferredIntervals = [15]
        c.skipBackwardCommand.addTarget { [weak self] ev in
            guard let self = self, let p = self.player else { return .commandFailed }
            if self.isSingleTrack {
                let interval = (ev as? MPSkipIntervalCommandEvent)?.interval ?? 15
                self.nativeSeek(to: p.currentTime().seconds - interval)
            } else {
                self.notifyListeners("command", data: ["action": "skipBackward"])
            }
            return .success }
        c.nextTrackCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            if self.isSingleTrack { self.seekToAdjacentChapter(next: true) }
            else { self.notifyListeners("command", data: ["action": "nextChapter"]) }
            return .success }
        c.previousTrackCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            if self.isSingleTrack { self.seekToAdjacentChapter(next: false) }
            else { self.notifyListeners("command", data: ["action": "prevChapter"]) }
            return .success }
        c.changePlaybackPositionCommand.addTarget { [weak self] ev in
            guard let self = self, let e = ev as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            if self.isSingleTrack { self.nativeSeek(to: e.positionTime) }
            else { self.notifyListeners("command", data: ["action": "seek", "time": e.positionTime]) }
            return .success
        }
    }

    /// True for the audiobook facade — one continuous AVPlayer item, keyed for
    /// position persistence — so lock-screen seeks can be handled natively. False
    /// for read-aloud (no posKey), which plays sentence-by-sentence and needs the
    /// command round-tripped to JS to load the next/previous sentence.
    private var isSingleTrack: Bool { !posKey.isEmpty }
}
