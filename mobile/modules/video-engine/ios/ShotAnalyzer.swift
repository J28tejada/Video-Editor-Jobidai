import AVFoundation
import CoreGraphics

/// Frame-difference scores for shot detection: tiny frames sampled every
/// `interval` seconds are compared by color histogram and by luma, giving a
/// 0..1 "how different from the previous sample" score per sample. The JS
/// side turns the scores into shot boundaries (src/core/agent/understanding).
enum ShotAnalyzer {
  private static let w = 32
  private static let h = 18

  static func measure(uri: String, interval: Double, maxSamples: Int) async throws -> [String: Any] {
    guard let url = URL(string: uri) else { throw MediaLoadException(uri) }
    let asset = AVURLAsset(url: url)
    let duration = try await asset.load(.duration).seconds
    guard duration > 0 else { return ["times": [Double](), "scores": [Double]()] }
    let step = max(interval, duration / Double(max(1, maxSamples)))

    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 96, height: 96)
    let tolerance = CMTime(seconds: step / 4, preferredTimescale: 600)
    generator.requestedTimeToleranceBefore = tolerance
    generator.requestedTimeToleranceAfter = tolerance

    var times: [Double] = []
    var scores: [Double] = []
    var previous: Signature?
    var t = 0.0
    while t < duration {
      if let (cg, _) = try? await generator.image(at: CMTime(seconds: t, preferredTimescale: 600)),
        let sig = signature(cg)
      {
        times.append(t)
        scores.append(previous.map { difference($0, sig) } ?? 0)
        previous = sig
      }
      t += step
    }
    return ["times": times, "scores": scores, "duration": duration]
  }

  private struct Signature {
    let histogram: [Double]  // 3 channels × 8 bins, normalized
    let luma: [Double]  // w × h
  }

  private static func signature(_ image: CGImage) -> Signature? {
    var pixels = [UInt8](repeating: 0, count: w * h * 4)
    guard
      let ctx = CGContext(
        data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    ctx.interpolationQuality = .low
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    var histogram = [Double](repeating: 0, count: 24)
    var luma = [Double](repeating: 0, count: w * h)
    for i in 0..<(w * h) {
      let r = Double(pixels[i * 4]), g = Double(pixels[i * 4 + 1]), b = Double(pixels[i * 4 + 2])
      histogram[Int(r) / 32] += 1
      histogram[8 + Int(g) / 32] += 1
      histogram[16 + Int(b) / 32] += 1
      luma[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    }
    let n = Double(w * h)
    return Signature(histogram: histogram.map { $0 / n }, luma: luma)
  }

  /// 0 = identical, ~1 = completely different.
  private static func difference(_ a: Signature, _ b: Signature) -> Double {
    var hist = 0.0
    for i in 0..<a.histogram.count { hist += abs(a.histogram[i] - b.histogram[i]) }
    hist /= 6  // three channels, each L1 distance in 0...2
    var pix = 0.0
    for i in 0..<a.luma.count { pix += abs(a.luma[i] - b.luma[i]) }
    pix /= Double(a.luma.count)
    return min(1, max(hist, pix * 2.5))
  }
}
