import Foundation

public enum NativeTools {
    public static func run(_ executable: String, _ arguments: [String]) throws {
        let process = Process(); process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
        let errors = Pipe(); process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle.nullDevice; process.standardError = errors
        try process.run(); let output = errors.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw UpdateFailure(String(data: output.prefix(2048), encoding: .utf8) ?? "macOS 無法驗證或解壓更新包。")
        }
    }
}
public enum NativeArchive {
    public static func inspect(_ data: Data) throws {
        func uint(_ offset: Int, _ size: Int) throws -> Int {
            guard offset >= 0, offset + size <= data.count else { throw UpdateFailure("ZIP 記錄不完整。") }
            return (0..<size).reduce(0) { $0 | Int(data[offset + $1]) << (8 * $1) }
        }
        func extras(_ offset: Int, _ length: Int) throws {
            var at = offset
            while at < offset + length {
                let tag = try uint(at, 2), count = try uint(at + 2, 2)
                guard at + 4 + count <= offset + length, tag != 1, tag != 0x7075 else { throw UpdateFailure("不支援的 ZIP 路徑記錄。") }
                at += 4 + count
            }
        }
        guard data.count >= 22, data.count <= UpdatePolicy.maximumArchive else { throw UpdateFailure("更新包大小無效。") }
        var end: Int?
        for offset in stride(from: data.count - 22, through: max(0, data.count - 65557), by: -1) {
            if try uint(offset, 4) == 0x06054b50, offset + 22 + (try uint(offset + 20, 2)) == data.count { end = offset; break }
        }
        guard let end else { throw UpdateFailure("ZIP 目錄缺失。") }
        let count = try uint(end + 10, 2), directory = try uint(end + 16, 4), size = try uint(end + 12, 4)
        guard count > 0, count <= 5000, try uint(end + 4, 2) == 0, try uint(end + 6, 2) == 0,
              try uint(end + 8, 2) == count, directory + size == end else { throw UpdateFailure("ZIP 目錄無效。") }
        var cursor = directory, total = 0; var names = Set<String>(); var ranges: [Range<Int>] = []
        for _ in 0..<count {
            guard cursor + 46 <= end, try uint(cursor, 4) == 0x02014b50 else { throw UpdateFailure("ZIP 檔案記錄無效。") }
            let flags = try uint(cursor + 8, 2), method = try uint(cursor + 10, 2), packed = try uint(cursor + 20, 4), expanded = try uint(cursor + 24, 4)
            let length = try uint(cursor + 28, 2), extra = try uint(cursor + 30, 2), comment = try uint(cursor + 32, 2), local = try uint(cursor + 42, 4)
            guard flags & 1 == 0, [0, 8].contains(method), cursor + 46 + length + extra + comment <= end,
                  let name = String(data: data.subdata(in: cursor + 46..<cursor + 46 + length), encoding: .utf8) else { throw UpdateFailure("ZIP 檔案名稱無效。") }
            let components = name.split(separator: "/", omittingEmptySubsequences: false)
            let pieces = name.hasSuffix("/") ? Array(components.dropLast()) : components
            guard !name.hasPrefix("/"), !name.contains("\\"), !name.contains("\0"), !name.contains(":"),
                  pieces.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && $0 != ".git" }),
                  name == "GPTNiangMac.app/" || name.hasPrefix("GPTNiangMac.app/") || name == "__MACOSX/" ||
                    name.hasPrefix("__MACOSX/GPTNiangMac.app/") || name == "__MACOSX/._GPTNiangMac.app" else { throw UpdateFailure("ZIP 路徑超出應用包範圍。") }
            let mode = try uint(cursor + 38, 4) >> 16, type = mode & 0xf000
            guard type == 0 || type == 0x8000 || type == 0x4000 else { throw UpdateFailure("更新包不能包含目錄連結。") }
            guard names.insert(name.precomposedStringWithCanonicalMapping.lowercased()).inserted else { throw UpdateFailure("更新包包含重複路徑。") }
            total += expanded; guard total <= UpdatePolicy.maximumExpanded else { throw UpdateFailure("更新包解壓後過大。") }
            try extras(cursor + 46 + length, extra)
            guard local + 30 <= directory, try uint(local, 4) == 0x04034b50, try uint(local + 6, 2) == flags, try uint(local + 8, 2) == method else { throw UpdateFailure("ZIP 本機記錄不符。") }
            let localLength = try uint(local + 26, 2), localExtra = try uint(local + 28, 2), finish = local + 30 + localLength + localExtra + packed
            guard localLength == length, finish <= directory,
                  data.subdata(in: local + 30..<local + 30 + length) == data.subdata(in: cursor + 46..<cursor + 46 + length),
                  !ranges.contains(where: { $0.overlaps(local..<finish) }) else { throw UpdateFailure("ZIP 檔案記錄重疊或名稱不符。") }
            try extras(local + 30 + localLength, localExtra); ranges.append(local..<finish)
            cursor += 46 + length + extra + comment
        }
        guard cursor == end else { throw UpdateFailure("ZIP 目錄長度不符。") }
    }
    public static func extract(_ archive: URL, to directory: URL) throws -> URL {
        try inspect(Data(contentsOf: archive))
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        try NativeTools.run("/usr/bin/ditto", ["-x", "-k", archive.path, directory.path])
        try UpdateFiles.checkTree(directory)
        return directory.appendingPathComponent("GPTNiangMac.app", isDirectory: true)
    }
    public static func version(of app: URL) throws -> String {
        let data = try Data(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        guard let info = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              info["CFBundleIdentifier"] as? String == UpdatePolicy.bundleID,
              let version = info["CFBundleShortVersionString"] as? String, StableVersion(version) != nil else { throw UpdateFailure("應用版本或識別碼不符。") }
        return version
    }
    public static func validate(_ app: URL, version: String, universal: Bool = true) throws {
        try UpdateFiles.checkTree(app)
        guard try self.version(of: app) == version else { throw UpdateFailure("應用版本與正式版標籤不符。") }
        for file in ["Contents/MacOS/GPTNiangMac", "Contents/Helpers/GPTNiangUpdater", "Contents/Resources/Backend/runtime/watch.mjs", "Contents/Resources/quotes.json"] {
            guard FileManager.default.fileExists(atPath: app.appendingPathComponent(file).path) else { throw UpdateFailure("應用包缺少必要檔案。") }
        }
        if let target = StableVersion(version), let localized = StableVersion("1.3.4"), target >= localized {
            let resourceURL = app.appendingPathComponent("Contents/Resources/GPTNiangMac_GPTNiangCore.bundle")
            guard let bundle = Bundle(url: resourceURL), let resources = bundle.resourceURL else { throw UpdateFailure("應用包缺少原生語言資源。") }
            for locale in ["zh-hans", "zh-hant"] {
                let file = resources.appendingPathComponent(locale + ".lproj/Localizable.strings")
                guard let data = try? Data(contentsOf: file),
                      let table = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: String],
                      !table.isEmpty else { throw UpdateFailure("應用包的原生語言資源不完整。") }
            }
        }
        try NativeTools.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
        if universal {
            for file in ["Contents/MacOS/GPTNiangMac", "Contents/Helpers/GPTNiangUpdater"] {
                try NativeTools.run("/usr/bin/lipo", [app.appendingPathComponent(file).path, "-verify_arch", "arm64", "x86_64"])
            }
        }
    }
}
