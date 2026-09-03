// Print "<windowId> <x> <y> <w> <h>" for the first on-screen window of an app.
import CoreGraphics
import Foundation

let name = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Dive"
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: AnyObject]] ?? []
for w in list {
    guard let owner = w[kCGWindowOwnerName as String] as? String, owner.contains(name),
          let bounds = w[kCGWindowBounds as String] as? [String: CGFloat],
          let id = w[kCGWindowNumber as String] as? Int,
          let width = bounds["Width"], width > 200 else { continue }
    print("\(id) \(Int(bounds["X"] ?? 0)) \(Int(bounds["Y"] ?? 0)) \(Int(width)) \(Int(bounds["Height"] ?? 0))")
    exit(0)
}
exit(1)
