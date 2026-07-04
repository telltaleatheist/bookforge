import Foundation
import Capacitor

/// On-device file storage for the "This iPhone" local library.
///
/// Why this exists: local audiobooks are imported into the WebView and, on the
/// web, stored in IndexedDB and played from a `blob:` object URL. But native
/// playback goes through AVPlayer (see NativeAudioPlugin), and AVPlayer cannot
/// load a `blob:` URL — it needs a real file on disk. This plugin writes the
/// audio bytes into the app's Documents directory and hands back a `file://`
/// URL that AVPlayer can open. Covers and EPUB bytes stay in IndexedDB (the
/// WebView reads those directly), so only the audio main asset is mirrored here.
///
/// Registered via `packageClassList` in capacitor.config.json — see
/// mobile/scripts/register-native-plugin.mjs, which re-adds it (alongside
/// NativeAudioPlugin) after every `cap sync`.
@objc(NativeFilePlugin)
public class NativeFilePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeFilePlugin"
    public let jsName = "NativeFile"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
    ]

    /// Files live under Documents/bookshelf-local, named `<id>-<asset>`.
    private func storageDir() -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("bookshelf-local", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    private func fileURL(id: String, asset: String) -> URL {
        // Keep the ids/assets we generate (uuid + "main"/"cover") filesystem-safe.
        let safeId = id.replacingOccurrences(of: "/", with: "_")
        let safeAsset = asset.replacingOccurrences(of: "/", with: "_")
        return storageDir().appendingPathComponent("\(safeId)-\(safeAsset)")
    }

    // MARK: - JS API

    /// Write (or append) one slice of a book asset. The JS side streams large
    /// audio in ~chunks and calls this once per slice: `append == false` for the
    /// first slice (create/truncate), `append == true` for the rest. Chunking is
    /// mandatory — base64-ing a whole audiobook into one string OOM-reloads the
    /// WebView before the offline index commits (see NativeFileService.write).
    @objc func write(_ call: CAPPluginCall) {
        guard let id = call.getString("id"),
              let asset = call.getString("asset"),
              let data = call.getString("data") else {
            call.reject("write: missing id/asset/data"); return
        }
        guard let bytes = Data(base64Encoded: data) else {
            call.reject("write: data is not valid base64"); return
        }
        let append = call.getBool("append") ?? false
        let url = fileURL(id: id, asset: asset)
        do {
            if append && FileManager.default.fileExists(atPath: url.path) {
                // Subsequent slice: append to the end of the existing file.
                let handle = try FileHandle(forWritingTo: url)
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: bytes)
            } else {
                // First slice (or no prior file): create/truncate atomically, then
                // keep this local-only cache out of iCloud/iTunes backups. The flag
                // persists with the file, so setting it on the first slice suffices.
                try bytes.write(to: url, options: .atomic)
                var mutable = url
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try? mutable.setResourceValues(values)
            }
            call.resolve(["url": url.absoluteString])
        } catch {
            call.reject("write: \(error.localizedDescription)")
        }
    }

    @objc func getUrl(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let asset = call.getString("asset") else {
            call.reject("getUrl: missing id/asset"); return
        }
        let url = fileURL(id: id, asset: asset)
        if FileManager.default.fileExists(atPath: url.path) {
            call.resolve(["url": url.absoluteString])
        } else {
            call.resolve(["url": NSNull()])
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("remove: missing id"); return
        }
        // Delete every asset for this book (`<id>-main`, `<id>-cover`, …).
        let dir = storageDir()
        let prefix = "\(id.replacingOccurrences(of: "/", with: "_"))-"
        if let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) {
            for name in names where name.hasPrefix(prefix) {
                try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
            }
        }
        call.resolve()
    }
}
