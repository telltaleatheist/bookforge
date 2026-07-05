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

    // MARK: - JS API

    @objc func load(_ call: CAPPluginCall) {
        guard let urlStr = call.getString("url"), let url = URL(string: urlStr) else {
            call.reject("load: missing/invalid url"); return
        }
        DispatchQueue.main.async {
            self.configureSession()
            self.wireInterruptions()
            self.teardownPlayer()

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
        configureSession()
        player?.playImmediately(atRate: rate)
        emitState("playing")
        updateNowPlaying(playing: true)
    }

    private func doPause() {
        player?.pause()
        // Keep the audio session ACTIVE while paused — on iOS the app with the
        // most recently active .playback session owns the Now Playing slot and
        // the AirPods play button. Deactivating here (or letting WebKit do it)
        // hands both back to the previously-playing app.
        configureSession()
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
        emitState("ended")
        notifyListeners("ended", data: [:])
        updateNowPlaying(playing: false)
    }

    private func configureSession() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .spokenAudio)
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
                configureSession()
            }
        @unknown default: break
        }
    }

    private func teardownPlayer() {
        if let t = timeObserver { player?.removeTimeObserver(t); timeObserver = nil }
        statusObs?.invalidate(); statusObs = nil
        stateObs?.invalidate(); stateObs = nil
        lastNotifiedState = ""
        NotificationCenter.default.removeObserver(self, name: .AVPlayerItemDidPlayToEndTime, object: nil)
        player?.pause()
        player = nil; item = nil; duration = 0
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
        c.skipForwardCommand.preferredIntervals = [30]
        c.skipForwardCommand.addTarget { [weak self] _ in
            self?.notifyListeners("command", data: ["action": "skipForward"]); return .success }
        c.skipBackwardCommand.preferredIntervals = [15]
        c.skipBackwardCommand.addTarget { [weak self] _ in
            self?.notifyListeners("command", data: ["action": "skipBackward"]); return .success }
        c.nextTrackCommand.addTarget { [weak self] _ in
            self?.notifyListeners("command", data: ["action": "nextChapter"]); return .success }
        c.previousTrackCommand.addTarget { [weak self] _ in
            self?.notifyListeners("command", data: ["action": "prevChapter"]); return .success }
        c.changePlaybackPositionCommand.addTarget { [weak self] ev in
            guard let e = ev as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.notifyListeners("command", data: ["action": "seek", "time": e.positionTime])
            return .success
        }
    }
}
