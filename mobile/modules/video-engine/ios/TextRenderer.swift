import AVFoundation
import UIKit

/// Burns text overlays into an export through AVVideoCompositionCoreAnimationTool.
/// Each text is rasterized once (same box/padding rules as the web compositor
/// and the RN preview layer) and shown only during its time window.
enum TextRenderer {
  static func animationTool(
    texts: [EngineText], renderSize: CGSize, duration: Double
  ) -> AVVideoCompositionCoreAnimationTool? {
    guard !texts.isEmpty, duration > 0 else { return nil }

    let frame = CGRect(origin: .zero, size: renderSize)
    let parent = CALayer()
    parent.frame = frame
    // Top-left origin, so yNorm matches the editor's coordinate system.
    parent.isGeometryFlipped = true
    let videoLayer = CALayer()
    videoLayer.frame = frame
    parent.addSublayer(videoLayer)

    for text in texts where text.end > text.start {
      guard let rendered = rasterize(text, renderSize: renderSize) else { continue }
      parent.addSublayer(timedLayer(rendered, start: text.start, end: text.end, duration: duration))
      // Karaoke: the same line with the spoken word highlighted, on top,
      // during each word.
      if let words = text.words, !words.isEmpty {
        for (i, word) in words.enumerated() {
          let wordEnd = min(text.end, max(word.end, i + 1 < words.count ? words[i + 1].start : text.end))
          let wordStart = max(text.start, word.start)
          guard wordEnd > wordStart, let lit = rasterize(text, renderSize: renderSize, highlight: i) else {
            continue
          }
          parent.addSublayer(timedLayer(lit, start: wordStart, end: wordEnd, duration: duration))
        }
      }
    }

    return AVVideoCompositionCoreAnimationTool(
      postProcessingAsVideoLayer: videoLayer, in: parent)
  }

  private static func timedLayer(
    _ rendered: (image: UIImage, box: CGRect), start: Double, end: Double, duration: Double
  ) -> CALayer {
    let layer = CALayer()
    layer.contents = rendered.image.cgImage
    layer.frame = rendered.box
    layer.contentsScale = 1
    layer.opacity = 0
    layer.add(visibility(start: start, end: end, duration: duration), forKey: "visibility")
    return layer
  }

  /// Opacity 0 → 1 at `start`, 1 → 0 at `end` (near-instant steps).
  private static func visibility(start: Double, end: Double, duration: Double) -> CAAnimation {
    let eps = 0.001
    let s = min(max(start / duration, 0), 1)
    let e = min(max(end / duration, 0), 1)
    var values: [Float] = []
    var keyTimes: [Double] = []
    func add(_ t: Double, _ v: Float) {
      let clamped = max(t, keyTimes.last ?? 0)
      keyTimes.append(clamped)
      values.append(v)
    }
    add(0, s <= 0 ? 1 : 0)
    if s > 0 {
      add(max(0, s - eps), 0)
      add(s, 1)
    }
    if e < 1 {
      add(e, 1)
      add(min(1, e + eps), 0)
      add(1, 0)
    } else {
      add(1, 1)
    }
    let anim = CAKeyframeAnimation(keyPath: "opacity")
    anim.values = values
    anim.keyTimes = keyTimes.map { NSNumber(value: $0) }
    anim.beginTime = AVCoreAnimationBeginTimeAtZero
    anim.duration = duration
    anim.isRemovedOnCompletion = false
    anim.fillMode = .forwards
    return anim
  }

  /// Draws one text box into an image. Returns the image and its frame in the
  /// render (top-left origin).
  static func rasterize(_ text: EngineText, renderSize: CGSize, highlight: Int? = nil)
    -> (image: UIImage, box: CGRect)?
  {
    let fontPx = max(1, CGFloat(text.fontSizeNorm) * renderSize.height)
    let font = UIFont.systemFont(ofSize: fontPx, weight: weight(text.fontWeight))
    let hasBackground = text.background != nil
    let shadow = NSShadow()
    if !hasBackground {
      shadow.shadowColor = UIColor.black.withAlphaComponent(0.6)
      shadow.shadowBlurRadius = fontPx * 0.12
      shadow.shadowOffset = CGSize(width: 0, height: fontPx * 0.04)
    }
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: parseColor(text.color),
      .shadow: shadow,
    ]
    // With word timings, the line is the words joined, so each word's range
    // is known for karaoke highlighting.
    let words = text.words ?? []
    let display = words.isEmpty ? text.text : words.map(\.text).joined(separator: " ")
    let string = NSMutableAttributedString(string: display, attributes: attributes)
    if let h = highlight, h < words.count {
      var location = 0
      for (i, w) in words.enumerated() {
        let length = (w.text as NSString).length
        if i == h {
          string.addAttribute(
            .foregroundColor, value: parseColor(text.highlightColor ?? "#ffe600"),
            range: NSRange(location: location, length: length))
          break
        }
        location += length + 1
      }
    }
    let textSize = string.size()
    guard textSize.width > 0 else { return nil }

    let padX = fontPx * 0.35
    let padY = fontPx * 0.25
    let boxSize = CGSize(
      width: ceil(textSize.width + padX * 2), height: ceil(max(textSize.height, fontPx) + padY * 2))

    let cx = CGFloat(text.xNorm) * renderSize.width
    let cy = CGFloat(text.yNorm) * renderSize.height
    let left: CGFloat
    switch text.align {
    case "left": left = cx - padX
    case "right": left = cx + padX - boxSize.width
    default: left = cx - boxSize.width / 2
    }
    let box = CGRect(x: left, y: cy - boxSize.height / 2, width: boxSize.width, height: boxSize.height)

    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = false
    let image = UIGraphicsImageRenderer(size: boxSize, format: format).image { _ in
      if let bg = text.background {
        parseColor(bg).setFill()
        UIBezierPath(
          roundedRect: CGRect(origin: .zero, size: boxSize), cornerRadius: min(fontPx * 0.2, 16)
        ).fill()
      }
      string.draw(
        at: CGPoint(x: padX, y: (boxSize.height - textSize.height) / 2))
    }
    return (image: image, box: box)
  }

  private static func weight(_ w: Double) -> UIFont.Weight {
    switch w {
    case ..<350: return .regular
    case ..<550: return .medium
    case ..<650: return .semibold
    case ..<750: return .bold
    case ..<850: return .heavy
    default: return .black
    }
  }
}
