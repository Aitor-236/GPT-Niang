import Foundation

public enum InterfaceLanguage: String, Codable, CaseIterable {
    case system, simplified, traditional

    public func resolved(preferredLanguages: [String] = Locale.preferredLanguages) -> InterfaceLanguage {
        guard self == .system else { return self }
        let first = preferredLanguages.first?.lowercased() ?? "zh-hans"
        return first.contains("hant") || first.hasPrefix("zh-tw") || first.hasPrefix("zh-hk") || first.hasPrefix("zh-mo") ? .traditional : .simplified
    }
    public var title: String {
        switch self {
        case .system: return "跟隨系統"
        case .simplified: return "简体中文"
        case .traditional: return "繁體中文"
        }
    }
    private static let catalogs: [String: [String: String]] = {
        let packaged = Bundle.main.url(forResource: "GPTNiangMac_GPTNiangCore", withExtension: "bundle").flatMap(Bundle.init(url:))
        let root = packaged ?? Bundle.module
        var catalogs: [String: [String: String]] = [:]
        for locale in ["zh-Hans", "zh-Hant"] {
            for folder in [locale.lowercased(), locale] {
                guard let resources = root.resourceURL,
                      let data = try? Data(contentsOf: resources.appendingPathComponent(folder + ".lproj/Localizable.strings")),
                      let table = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: String] else { continue }
                catalogs[locale] = table; break
            }
        }
        return catalogs
    }()
    public func text(_ key: String, _ arguments: String...) -> String { text(key, arguments: arguments) }
    public func text(_ key: String, arguments: [String]) -> String {
        let locale = resolved() == .traditional ? "zh-Hant" : "zh-Hans"
        // Read the explicitly selected catalog, independently of Bundle's
        // system-preferred localization; SwiftPM lowercases lproj directory names.
        // Cache once so animation ticks never reread files or create bundles.
        let format = Self.catalogs[locale]?[key] ?? key
        guard !arguments.isEmpty else { return format }
        return String(format: format, locale: Locale(identifier: locale), arguments: arguments.map { $0 as CVarArg })
    }
}
