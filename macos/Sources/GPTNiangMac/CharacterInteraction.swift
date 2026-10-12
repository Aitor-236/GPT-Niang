import SwiftUI
import AppKit

// AppKit handles pointer capture across a moving NSPanel. SwiftUI owns animation.
struct CharacterInteraction: NSViewRepresentable {
    var onPress: (Bool) -> Void
    var onDrag: (CGSize) -> Void
    var onClick: () -> Void
    var onMenu: (NSEvent, NSView) -> Void

    func makeNSView(context: Context) -> PointerView { let view = PointerView(); updateNSView(view, context: context); return view }
    func updateNSView(_ view: PointerView, context: Context) {
        view.onPress = onPress; view.onDrag = onDrag; view.onClick = onClick; view.onMenu = onMenu
    }
    final class PointerView: NSView {
        var onPress: (Bool) -> Void = { _ in }
        var onDrag: (CGSize) -> Void = { _ in }
        var onClick: () -> Void = {}
        var onMenu: (NSEvent, NSView) -> Void = { _, _ in }
        private var start: CGPoint?
        private var moved = false
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func mouseDown(with event: NSEvent) { start = window?.convertPoint(toScreen: event.locationInWindow) ?? NSEvent.mouseLocation; moved = false; onPress(true) }
        override func mouseDragged(with event: NSEvent) {
            guard let start else { return }
            let now = window?.convertPoint(toScreen: event.locationInWindow) ?? NSEvent.mouseLocation
            let delta = CGSize(width: now.x - start.x, height: start.y - now.y)
            if moved || hypot(delta.width, delta.height) >= 3 { moved = true; onDrag(delta) }
        }
        override func mouseUp(with event: NSEvent) {
            guard start != nil else { return }
            start = nil; onPress(false)
            if moved { onDrag(.zero) } else { onClick() }
        }
        override func rightMouseDown(with event: NSEvent) { onMenu(event, self) }
        override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
    }
}
