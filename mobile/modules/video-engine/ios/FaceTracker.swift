import AVFoundation
import Vision

/// Where the main face is at given source times (center, 0..1 top-left),
/// for auto-reframing. Frames without a face are skipped.
enum FaceTracker {
  static func detect(uri: String, times: [Double]) async throws -> [[String: Double]] {
    guard let url = URL(string: uri) else { throw MediaLoadException(uri) }
    let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 480, height: 480)
    let tolerance = CMTime(value: 1, timescale: 10)
    generator.requestedTimeToleranceBefore = tolerance
    generator.requestedTimeToleranceAfter = tolerance

    var out: [[String: Double]] = []
    for t in times {
      guard let (image, _) = try? await generator.image(at: CMTime(seconds: t, preferredTimescale: 600))
      else { continue }
      let request = VNDetectFaceRectanglesRequest()
      try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
      // Largest face = the subject.
      guard
        let face = request.results?.max(by: {
          $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height
        })
      else { continue }
      // Vision uses a bottom-left origin.
      out.append(["t": t, "x": Double(face.boundingBox.midX), "y": Double(1 - face.boundingBox.midY)])
    }
    return out
  }
}
