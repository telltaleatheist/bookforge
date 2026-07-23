import Foundation
import Capacitor

/// On-device file storage for the "This iPhone" local library.
///
/// Why this exists: local audiobooks are imported into the WebView and, on the
/// web, stored in IndexedDB and played from a `blob:` object URL. But native
/// playback goes through AVPlayer (see NativeAudioPlugin), and AVPlayer cannot
/// load a `blob:` URL — it needs a real file on disk. This plugin writes the
/// audio bytes into the app's Documents directory and hands back a `file://`
/// URL that AVPlayer can open.
///
/// It ALSO stores a downloaded book's small sidecars (cover, synced-transcript
/// VTT, chapters JSON) here, for durability: WKWebView evicts IndexedDB under
/// storage pressure/inactivity while files under Documents/ survive, so keeping
/// the sidecars in IDB meant a downloaded book kept its audio but lost its cover
/// and sentences "out of nowhere." Covers render via getUrl()+<img>; VTT/chapters
/// come back through read() (JS cannot fetch() a file:// URL). The methods are
/// asset-name-agnostic (`<id>-<asset>[.<ext>]`) so no per-asset code is needed.
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
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readSlice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
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

    private func safeName(_ s: String) -> String {
        return s.replacingOccurrences(of: "/", with: "_")
    }

    /// `<id>-<asset>` plus the asset's real extension when the JS side knows it.
    /// The extension matters: AVPlayer determines the container format of a local
    /// `file://` URL from the path extension, and refuses extension-less files
    /// with "Cannot Open" even when the bytes are a perfectly valid audiobook.
    private func fileURL(id: String, asset: String, ext: String?) -> URL {
        var name = "\(safeName(id))-\(safeName(asset))"
        if let ext = ext, !ext.isEmpty {
            name += "." + ext.filter { $0.isLetter || $0.isNumber }
        }
        return storageDir().appendingPathComponent(name)
    }

    /// Locate a stored asset whatever extension it was written with (including
    /// none, for files written before extensions were added).
    private func findExisting(id: String, asset: String) -> URL? {
        let dir = storageDir()
        let base = "\(safeName(id))-\(safeName(asset))"
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return nil }
        for name in names where name == base || name.hasPrefix("\(base).") {
            return dir.appendingPathComponent(name)
        }
        return nil
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
        let url = fileURL(id: id, asset: asset, ext: call.getString("ext"))
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
        if let url = findExisting(id: id, asset: asset) {
            call.resolve(["url": url.absoluteString])
        } else {
            call.resolve(["url": NSNull()])
        }
    }

    /// Read a whole stored asset back as base64, or null when it isn't present
    /// (e.g. a sidecar that was never written, or was reclaimed). Used for the
    /// small sidecars (VTT/chapters) that JS parses as text/JSON — JS cannot
    /// fetch() a file:// URL inside WKWebView. NOT for `main`: base64-ing a
    /// 590 MB audiobook would OOM the WebView (audio is played natively via getUrl).
    @objc func read(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let asset = call.getString("asset") else {
            call.reject("read: missing id/asset"); return
        }
        guard let url = findExisting(id: id, asset: asset) else {
            call.resolve(["data": NSNull()]); return
        }
        do {
            let data = try Data(contentsOf: url)
            call.resolve(["data": data.base64EncodedString()])
        } catch {
            call.reject("read: \(error.localizedDescription)")
        }
    }

    /// Read a byte RANGE of a stored asset as base64, plus the file's total size.
    /// Unlike read(), this streams only `length` bytes from `offset` via a file
    /// handle, so it's safe on `main` (a 590 MB audiobook): the JS side walks the
    /// m4b's box structure to pull just the small `moov` metadata box and extract
    /// the embedded cover art, never materializing the whole file. `total` lets the
    /// caller know EOF up front. Missing asset → { data: null, total: 0 }.
    @objc func readSlice(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let asset = call.getString("asset") else {
            call.reject("readSlice: missing id/asset"); return
        }
        let offset = call.getInt("offset") ?? 0
        let length = call.getInt("length") ?? 0
        guard let url = findExisting(id: id, asset: asset) else {
            call.resolve(["data": NSNull(), "total": 0]); return
        }
        do {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let total = try handle.seekToEnd()
            if offset > 0 { try handle.seek(toOffset: UInt64(offset)) } else { try handle.seek(toOffset: 0) }
            let data = (length > 0 ? try handle.read(upToCount: length) : Data()) ?? Data()
            call.resolve(["data": data.base64EncodedString(), "total": Int(total)])
        } catch {
            call.reject("readSlice: \(error.localizedDescription)")
        }
    }

    /// List the filenames currently in the storage dir, so the JS side can
    /// reconcile them against its index and reclaim files stranded by a hard-kill
    /// mid-download (a download's uuid is only indexed after it fully succeeds).
    @objc func list(_ call: CAPPluginCall) {
        let dir = storageDir()
        do {
            let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
            call.resolve(["files": names])
        } catch {
            // The JS contract is that bridge failures THROW — returning [] here
            // would make the reconciler think the storage dir is empty and
            // reclaim nothing (or worse, drop valid index entries).
            call.reject("list: \(error.localizedDescription)")
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
