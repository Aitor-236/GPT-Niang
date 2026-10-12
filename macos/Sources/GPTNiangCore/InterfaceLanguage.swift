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
    public func text(_ key: String, _ arguments: String...) -> String { text(key, arguments: arguments) }
    public func text(_ key: String, arguments: [String]) -> String {
        let locale = resolved() == .traditional ? "zh-Hant" : "zh-Hans"
        // SwiftPM's generated accessor embeds its build path. Prefer the resource
        // bundle inside the distributed app; use Bundle.module in source/tests.
        let packaged = Bundle.main.url(forResource: "GPTNiangMac_GPTNiangCore", withExtension: "bundle").flatMap(Bundle.init(url:))
        let root = packaged ?? Bundle.module
        let localized = root.url(forResource: locale, withExtension: "lproj").flatMap(Bundle.init(url:)) ?? root
        let format = localized.localizedString(forKey: key, value: key, table: "Localizable")
        guard !arguments.isEmpty else { return format }
        return String(format: format, locale: Locale(identifier: locale), arguments: arguments.map { $0 as CVarArg })
    }
}
