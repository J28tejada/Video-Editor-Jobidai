import AVFoundation
import CoreImage

/// One clip as it is drawn: which composition track holds its frames, how to
/// place them in the output (orientation + fit + zoom, top-left coordinates)
/// and an optional color matrix.
struct ClipLayer {
  let trackID: CMPersistentTrackID
  let transform: CGAffineTransform
  let colorMatrix: [Double]?
}

/// A span of the timeline showing one clip, or a transition between two.
final class EngineInstruction: NSObject, AVVideoCompositionInstructionProtocol {
  let timeRange: CMTimeRange
  let enablePostProcessing = true  // text is burned in with Core Animation on export
  let containsTweening = true
  let requiredSourceTrackIDs: [NSValue]?
  let passthroughTrackID: CMPersistentTrackID = kCMPersistentTrackID_Invalid

  let from: ClipLayer
  let to: ClipLayer?
  let kind: String

  init(timeRange: CMTimeRange, from: ClipLayer, to: ClipLayer? = nil, kind: String = "") {
    self.timeRange = timeRange
    self.from = from
    self.to = to
    self.kind = kind
    var ids = [NSNumber(value: from.trackID)]
    if let to { ids.append(NSNumber(value: to.trackID)) }
    self.requiredSourceTrackIDs = ids
    super.init()
  }
}

/// Custom compositor (Core Image) used by both the preview and the export, so
/// they always match. Works in sRGB so the color matrices behave like the web
/// editor's CSS filters.
final class EngineCompositor: NSObject, AVVideoCompositing {
  private static let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
  private let context = CIContext(options: [
    .workingColorSpace: EngineCompositor.srgb,
    .outputColorSpace: EngineCompositor.srgb,
  ])
  private let queue = DispatchQueue(label: "video-engine.compositor")

  private static let pixelAttributes: [String: Any] = [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
  ]

  var sourcePixelBufferAttributes: [String: Any]? { EngineCompositor.pixelAttributes }
  var requiredPixelBufferAttributesForRenderContext: [String: Any] { EngineCompositor.pixelAttributes }

  func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {}

  func cancelAllPendingVideoCompositionRequests() {}

  func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
    queue.async {
      guard
        let instruction = request.videoCompositionInstruction as? EngineInstruction,
        let output = request.renderContext.newPixelBuffer()
      else {
        request.finish(with: NSError(domain: "VideoEngine", code: 1))
        return
      }
      let size = request.renderContext.size
      let image = self.compose(instruction, request: request, size: size)
      self.context.render(
        image, to: output, bounds: CGRect(origin: .zero, size: size), colorSpace: EngineCompositor.srgb)
      request.finish(withComposedVideoFrame: output)
    }
  }

  private func compose(
    _ instruction: EngineInstruction, request: AVAsynchronousVideoCompositionRequest, size: CGSize
  ) -> CIImage {
    let rect = CGRect(origin: .zero, size: size)
    let black = CIImage(color: .black).cropped(to: rect)
    let a = layerImage(instruction.from, request: request, size: size)

    guard let incoming = instruction.to else {
      return (a?.composited(over: black) ?? black).cropped(to: rect)
    }
    let b = layerImage(incoming, request: request, size: size)
    let range = instruction.timeRange
    let p = min(
      1,
      max(0, (request.compositionTime - range.start).seconds / max(0.001, range.duration.seconds)))
    let aFull = a?.composited(over: black) ?? black
    let bFull = b?.composited(over: black) ?? black

    let result: CIImage
    switch instruction.kind {
    case "fade":
      // Dip to black: A fades out, then B fades in.
      result = p < 0.5 ? dissolve(aFull, black, 2 * p) : dissolve(black, bFull, 2 * p - 1)
    case "slide":
      // A leaves to the left while B enters from the right.
      let w = size.width
      let aMoved = (a ?? black).transformed(by: CGAffineTransform(translationX: -p * w, y: 0))
      let bMoved = (b ?? black).transformed(by: CGAffineTransform(translationX: (1 - p) * w, y: 0))
      result = aMoved.composited(over: bMoved.composited(over: black))
    default:
      result = dissolve(aFull, bFull, p)
    }
    return result.cropped(to: rect)
  }

  private func dissolve(_ from: CIImage, _ to: CIImage, _ t: Double) -> CIImage {
    from.applyingFilter("CIDissolveTransition", parameters: [
      kCIInputTargetImageKey: to,
      kCIInputTimeKey: min(1, max(0, t)),
    ])
  }

  /// Source frame → color adjusted → oriented, fitted and zoomed into the
  /// output. Core Image is bottom-left origin; the layer transform is
  /// top-left, so it is wrapped in flips.
  private func layerImage(
    _ layer: ClipLayer, request: AVAsynchronousVideoCompositionRequest, size: CGSize
  ) -> CIImage? {
    guard let buffer = request.sourceFrame(byTrackID: layer.trackID) else { return nil }
    var image = CIImage(cvPixelBuffer: buffer)
    if let m = layer.colorMatrix, m.count == 12 {
      image = image.applyingFilter("CIColorMatrix", parameters: [
        "inputRVector": CIVector(x: m[0], y: m[1], z: m[2], w: 0),
        "inputGVector": CIVector(x: m[4], y: m[5], z: m[6], w: 0),
        "inputBVector": CIVector(x: m[8], y: m[9], z: m[10], w: 0),
        "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
        "inputBiasVector": CIVector(x: m[3], y: m[7], z: m[11], w: 0),
      ]).applyingFilter("CIColorClamp")
    }
    let flipIn = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: image.extent.height)
    let flipOut = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: size.height)
    return image.transformed(by: flipIn.concatenating(layer.transform).concatenating(flipOut))
      .cropped(to: CGRect(origin: .zero, size: size))
  }
}
