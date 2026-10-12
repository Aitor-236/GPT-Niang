import XCTest
import AppKit
import GPTNiangCore
@testable import GPTNiangMac

final class NativeInteractionTests: XCTestCase {
    @MainActor func testRefreshAndCharacterActionsFollowWindowsBubbleSequence() async throws {
        let data = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: data) }
        let model = WidgetModel(dataDirectory: data, resources: data)
        model.refresh(); XCTAssertFalse(model.bubble)
        XCTAssertTrue(FileManager.default.fileExists(atPath: data.appendingPathComponent("refresh.flag").path))
        model.characterClick(); XCTAssertTrue(model.bubble); XCTAssertNil(model.message)
        model.clickBubble(); XCTAssertNotNil(model.message)
        model.characterClick(); XCTAssertNil(model.message); XCTAssertTrue(model.bubble)
        model.bubbleTapAdvance = true
        model.characterClick(); XCTAssertNotNil(model.message)
        model.characterClick(); XCTAssertFalse(model.bubble)
    }
    @MainActor func testResetQuotesBacksUpWeightedCustomData() async throws {
        let data = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: data) }
        let model = WidgetModel(dataDirectory: data, resources: data)
        model.quoteText = "3 | 我的繁體語錄"; model.saveQuotes()
        let file = data.appendingPathComponent("quotes.json")
        let original = try Data(contentsOf: file)
        model.resetQuotes()
        XCTAssertEqual(try Data(contentsOf: data.appendingPathComponent("quotes.json.bak")), original)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }
    @MainActor func testEveryClickCountPreservesFeedbackAndRightClickMenu() async throws {
        let view = CharacterInteraction.PointerView()
        var clicks = 0, settings = 0, presses: [Bool] = []
        view.onClick = { clicks += 1 }; view.onMenu = { _, _ in settings += 1 }; view.onPress = { presses.append($0) }
        for count in 1...4 {
            let down = NSEvent.mouseEvent(with: .leftMouseDown, location: .zero, modifierFlags: [], timestamp: 0,
                windowNumber: 0, context: nil, eventNumber: 0, clickCount: count, pressure: 0)!
            let up = NSEvent.mouseEvent(with: .leftMouseUp, location: .zero, modifierFlags: [], timestamp: 0,
                windowNumber: 0, context: nil, eventNumber: 0, clickCount: count, pressure: 0)!
            view.mouseDown(with: down); view.mouseUp(with: up)
        }
        XCTAssertEqual(clicks, 4); XCTAssertEqual(settings, 0)
        XCTAssertEqual(presses, [true, false, true, false, true, false, true, false])
        let right = NSEvent.mouseEvent(with: .rightMouseDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 0)!
        view.rightMouseDown(with: right); XCTAssertEqual(settings, 1)
    }
    @MainActor func testNativeDisplayPreferencesRoundTripPreservesQuotes() async throws {
        let data = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: data) }
        let model = WidgetModel(dataDirectory: data, resources: data)
        XCTAssertEqual(model.language, .system)
        model.language = .simplified
        model.desktopTopmost = true; model.desktopLeft = -500; model.desktopBottom = 200; model.soundOn = false; model.hideMenu = true
        model.specialQuotes = "我的繁體語錄"; model.volume = 0.4; model.followCodex = false
        model.savePreferences()
        let restored = WidgetModel(dataDirectory: data, resources: data)
        XCTAssertEqual(restored.language, .simplified)
        XCTAssertEqual(restored.specialQuotes, "我的繁體語錄"); XCTAssertEqual(restored.volume, 0.4)
        XCTAssertFalse(restored.followCodex)
        XCTAssertTrue(restored.desktopTopmost); XCTAssertEqual(restored.desktopLeft, -500)
        XCTAssertEqual(restored.desktopBottom, 200); XCTAssertFalse(restored.soundOn); XCTAssertTrue(restored.hideMenu)
    }
    @MainActor func testMalformedSnapshotClearsPreviousBusinessAccount() async throws {
        let data = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: data) }
        let model = WidgetModel(dataDirectory: data, resources: data)
        let file = data.appendingPathComponent("status.json")
        try Data(#"{"ok":true,"planLabel":"Business","windows":[{"kind":"individual","minutes":null,"remaining":48}]}"#.utf8).write(to: file)
        model.readSnapshot(try Data(contentsOf: file)); XCTAssertEqual(model.snapshot.displayWindows.first?.id, "individual")
        try Data("broken".utf8).write(to: file)
        model.readSnapshot(try Data(contentsOf: file)); XCTAssertTrue(model.snapshot.windows.isEmpty); XCTAssertNil(model.snapshot.planLabel)
        XCTAssertNotNil(model.snapshot.error)
        model.stop()
    }
    @MainActor func testNativeSingleDoubleAndRightClickRoutes() async throws {
        // Detached view events exercise routing without posting OS input.
        let view = CharacterInteraction.PointerView()
        var clicks = 0, settings = 0
        var presses: [Bool] = []
        view.onClick = { clicks += 1 }; view.onMenu = { _, _ in settings += 1 }
        view.onPress = { presses.append($0) }
        func event(_ type: NSEvent.EventType, clicks: Int) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: .zero, modifierFlags: [], timestamp: 0,
                               windowNumber: 0, context: nil, eventNumber: 0, clickCount: clicks, pressure: 0)!
        }
        view.mouseDown(with: event(.leftMouseDown, clicks: 1)); view.mouseUp(with: event(.leftMouseUp, clicks: 1))
        XCTAssertEqual(clicks, 1); XCTAssertEqual(settings, 0); XCTAssertEqual(presses, [true, false])
        view.mouseDown(with: event(.leftMouseDown, clicks: 2)); view.mouseUp(with: event(.leftMouseUp, clicks: 2))
        XCTAssertEqual(settings, 0); XCTAssertEqual(clicks, 2)
        view.rightMouseDown(with: event(.rightMouseDown, clicks: 1)); XCTAssertEqual(settings, 1)
    }
    @MainActor func testSpeedHelperEOFMarksStoppedAndCanRestart() async throws {
        let store = ThreadSpeedStore()
        store.start(executable: URL(fileURLWithPath: "/usr/bin/true"), arguments: [])
        for _ in 0..<30 {
            if store.error != nil { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertNotNil(store.error)
        XCTAssertTrue(store.rows.isEmpty)
        store.start(executable: URL(fileURLWithPath: "/bin/cat"), arguments: [])
        XCTAssertNil(store.error)
        store.stop()
        try await Task.sleep(nanoseconds: 30_000_000)
        // A callback from the previous helper must not clear a new run's state.
        XCTAssertNil(store.error)
    }
}
