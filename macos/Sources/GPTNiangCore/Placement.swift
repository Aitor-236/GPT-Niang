import Foundation
import CoreGraphics

public enum WidgetPlacement {
    public static func desktopFrame(area: CGRect, size: CGSize, origin: CGPoint) -> CGRect {
        let width = min(size.width, area.width), height = min(size.height, area.height)
        return CGRect(x: max(area.minX, min(area.maxX-width, origin.x)),
                      y: max(area.minY, min(area.maxY-height, origin.y)), width: width, height: height)
    }
    public static func appKitRect(quartz: CGRect, mainDisplayHeight: CGFloat) -> CGRect {
        CGRect(x: quartz.minX, y: mainDisplayHeight - quartz.maxY, width: quartz.width, height: quartz.height)
    }
    public static func usableArea(host: CGRect, visibleScreen: CGRect) -> CGRect {
        let intersection = host.intersection(visibleScreen)
        return intersection.isNull || intersection.isEmpty ? visibleScreen : intersection
    }
    public static func frame(host: CGRect, visibleScreen: CGRect, size: CGSize, x: Double, y: Double) -> CGRect {
        let area = usableArea(host: host, visibleScreen: visibleScreen)
        let width = min(size.width, area.width)
        let height = min(size.height, area.height)
        let horizontal = max(0, area.width - width - 24)
        let vertical = max(0, area.height - height - 24)
        let result = CGRect(x: area.minX + min(12, max(0, area.width - width)) + horizontal * min(1, max(0, x)),
                            y: area.minY + min(12, max(0, area.height - height)) + vertical * min(1, max(0, y)),
                            width: width, height: height)
        return result
    }
}
