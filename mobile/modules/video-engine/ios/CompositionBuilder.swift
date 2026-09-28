import AVFoundation
import UIKit

/// Everything AVFoundation needs to play or export one EngineComposition.
struct BuiltComposition {
  let asset: AVMutableComposition
  let videoComposition: AVMutableVideoComposition
  let audioMix: AVMutableAudioMix?
  let duration: Double
}

/// Turns the render description into an AVMutableComposition:
///  - one video + one audio composition track; each clip's trimmed range is
///    inserted back to back and time-scaled for its speed;
///  - one video-composition instruction per clip carrying that clip's
///    fit transform (sources may differ in size/orientation);
///  - an audio mix applying each clip's volume from its start time.
/// Decoding and compositing then run on the system's hardware pipeline.
enum CompositionBuilder {
  static let timescale: CMTimeScale = 600

  static func build(_ spec: EngineComposition, renderSize: CGSize) async throws -> BuiltComposition {
    let composition = AVMutableComposition()
    guard
      let videoTrack = composition.addMutableTrack(
        withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
      let audioTrack = composition.addMutableTrack(
        withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
    else {
      throw InvalidCompositionException("could not create composition tracks")
    }

    var instructions: [AVMutableVideoCompositionInstruction] = []
    let audioParams = AVMutableAudioMixInputParameters(track: audioTrack)
    var hasAudio = false
    var cursor = CMTime.zero

    for clip in spec.clips {
      guard let url = URL(string: clip.uri) else { throw MediaLoadException(clip.uri) }
      let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
      guard let srcVideo = try await asset.loadTracks(withMediaType: .video).first else {
        throw MediaLoadException("no video track in \(url.lastPathComponent)")
      }
      let srcAudio = try await asset.loadTracks(withMediaType: .audio).first
      let assetDuration = try await asset.load(.duration)
      let naturalSize = try await srcVideo.load(.naturalSize)
      let preferredTransform = try await srcVideo.load(.preferredTransform)

      let inTime = CMTime(seconds: max(0, clip.inPoint), preferredTimescale: timescale)
      let outTime = CMTimeMinimum(
        CMTime(seconds: clip.outPoint, preferredTimescale: timescale), assetDuration)
      guard outTime > inTime else { continue }
      let sourceRange = CMTimeRange(start: inTime, end: outTime)

      try videoTrack.insertTimeRange(sourceRange, of: srcVideo, at: cursor)
      if let srcAudio {
        try audioTrack.insertTimeRange(sourceRange, of: srcAudio, at: cursor)
        hasAudio = true
      }

      // Speed: stretch/compress the inserted segment on the composition timeline.
      let speed = clip.speed > 0 ? clip.speed : 1
      var segmentDuration = sourceRange.duration
      if abs(speed - 1) > 0.001 {
        let scaled = CMTimeMultiplyByFloat64(segmentDuration, multiplier: 1 / speed)
        let inserted = CMTimeRange(start: cursor, duration: segmentDuration)
        videoTrack.scaleTimeRange(inserted, toDuration: scaled)
        if srcAudio != nil { audioTrack.scaleTimeRange(inserted, toDuration: scaled) }
        segmentDuration = scaled
      }
      let segment = CMTimeRange(start: cursor, duration: segmentDuration)

      let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
      layer.setTransform(
        fitTransform(
          natural: naturalSize, preferred: preferredTransform, render: renderSize,
          cover: clip.fit == "cover"),
        at: segment.start)
      let instruction = AVMutableVideoCompositionInstruction()
      instruction.timeRange = segment
      instruction.layerInstructions = [layer]
      instructions.append(instruction)

      // AVAudioMix volume is limited to 0...1; boosts above 1 are clamped.
      audioParams.setVolume(Float(min(max(clip.volume, 0), 1)), at: segment.start)

      cursor = segment.end
    }

    if !hasAudio { composition.removeTrack(audioTrack) }

    let layerParams = try await addAudioLayers(spec.audio, to: composition, videoEnd: cursor)

    // Instructions must tile the whole composition exactly; absorb rounding
    // drift in the last one.
    if let last = instructions.last, last.timeRange.end != composition.duration {
      last.timeRange = CMTimeRange(start: last.timeRange.start, end: composition.duration)
    }

    let videoComposition = AVMutableVideoComposition()
    videoComposition.renderSize = renderSize
    videoComposition.frameDuration = CMTime(
      value: 1, timescale: CMTimeScale(max(1, min(120, spec.fps.rounded()))))
    videoComposition.instructions = instructions

    var audioMix: AVMutableAudioMix?
    let allParams = (hasAudio ? [audioParams] : []) + layerParams
    if !allParams.isEmpty {
      let mix = AVMutableAudioMix()
      mix.inputParameters = allParams
      audioMix = mix
    }

    return BuiltComposition(
      asset: composition, videoComposition: videoComposition, audioMix: audioMix,
      duration: composition.duration.seconds)
  }

  /// Music and sound-effect layers. Layers that don't overlap in time share a
  /// composition track (fewer tracks = fewer simultaneous decoders); each
  /// layer's gain envelope becomes volume ramps on its track's mix parameters.
  private static func addAudioLayers(
    _ layers: [EngineAudio], to composition: AVMutableComposition, videoEnd: CMTime
  ) async throws -> [AVMutableAudioMixInputParameters] {
    var lanes: [(track: AVMutableCompositionTrack, params: AVMutableAudioMixInputParameters, busyUntil: CMTime)] = []

    for layer in layers.sorted(by: { $0.start < $1.start }) {
      let layerStart = CMTime(seconds: max(0, layer.start), preferredTimescale: timescale)
      let layerEnd = CMTimeMinimum(CMTime(seconds: layer.end, preferredTimescale: timescale), videoEnd)
      guard layerEnd > layerStart, let url = URL(string: layer.uri) else { continue }
      let asset = AVURLAsset(url: url)
      guard let source = try await asset.loadTracks(withMediaType: .audio).first else { continue }
      let sourceDuration = try await asset.load(.duration)
      let inTime = CMTime(seconds: max(0, layer.inPoint), preferredTimescale: timescale)
      let outTime = CMTimeMinimum(
        CMTime(seconds: layer.outPoint, preferredTimescale: timescale), sourceDuration)
      guard outTime > inTime else { continue }

      var laneIndex = lanes.firstIndex { $0.busyUntil <= layerStart }
      if laneIndex == nil,
        let track = composition.addMutableTrack(
          withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
      {
        lanes.append((track, AVMutableAudioMixInputParameters(track: track), .zero))
        laneIndex = lanes.count - 1
      }
      guard let lane = laneIndex else { continue }

      // One pass of the source range, repeated while looping, cut at the end.
      var at = layerStart
      while at < layerEnd {
        let pass = CMTimeMinimum(outTime - inTime, layerEnd - at)
        try lanes[lane].track.insertTimeRange(
          CMTimeRange(start: inTime, duration: pass), of: source, at: at)
        at = at + pass
        if !layer.loop { break }
      }
      applyEnvelope(layer.envelope, to: lanes[lane].params, from: layerStart, to: at)
      lanes[lane].busyUntil = at
    }
    return lanes.map { $0.params }
  }

  /// Piecewise-linear gain → a volume at the layer start plus one ramp per
  /// envelope segment. AVAudioMix volumes are limited to 0...1.
  private static func applyEnvelope(
    _ points: [GainPoint], to params: AVMutableAudioMixInputParameters, from start: CMTime,
    to end: CMTime
  ) {
    func volume(_ g: Double) -> Float { Float(min(max(g, 0), 1)) }
    let s = start.seconds
    let e = end.seconds
    var prevT = s
    var prevGain = gain(points, at: s)
    params.setVolume(volume(prevGain), at: start)
    let inner = points.filter { $0.t > s && $0.t < e }
    for p in inner + [GainPoint(t: e, gain: gain(points, at: e))] where p.t > prevT {
      params.setVolumeRamp(
        fromStartVolume: volume(prevGain), toEndVolume: volume(p.gain),
        timeRange: CMTimeRange(
          start: CMTime(seconds: prevT, preferredTimescale: timescale),
          end: CMTime(seconds: p.t, preferredTimescale: timescale)))
      prevT = p.t
      prevGain = p.gain
    }
  }

  /// Linear interpolation over sorted points; holds the ends.
  static func gain(_ points: [GainPoint], at t: Double) -> Double {
    guard let first = points.first, let last = points.last else { return 1 }
    if t <= first.t { return first.gain }
    if t >= last.t { return last.gain }
    for i in 1..<points.count where t <= points[i].t {
      let a = points[i - 1]
      let b = points[i]
      let span = b.t - a.t
      return span <= 0 ? b.gain : a.gain + (b.gain - a.gain) * (t - a.t) / span
    }
    return last.gain
  }

  /// Output size for the project, optionally scaled so its short side equals
  /// `shortSide`. Always even, as H.264/HEVC encoders require.
  static func renderSize(for spec: EngineComposition, shortSide: Double = 0) -> CGSize {
    var w = max(2, spec.width)
    var h = max(2, spec.height)
    if shortSide > 0 {
      let scale = shortSide / min(w, h)
      w *= scale
      h *= scale
    }
    let even = { (v: Double) -> CGFloat in CGFloat(max(2, Int((v / 2).rounded()) * 2)) }
    return CGSize(width: even(w), height: even(h))
  }

  /// Maps a source track (with its orientation transform) into the render
  /// frame: contain = letterbox, cover = fill + crop, centered.
  static func fitTransform(
    natural: CGSize, preferred: CGAffineTransform, render: CGSize, cover: Bool
  ) -> CGAffineTransform {
    let oriented = CGRect(origin: .zero, size: natural).applying(preferred)
    let dw = abs(oriented.width)
    let dh = abs(oriented.height)
    guard dw > 0, dh > 0 else { return preferred }
    let scale =
      cover
      ? max(render.width / dw, render.height / dh)
      : min(render.width / dw, render.height / dh)
    return
      preferred
      .concatenating(CGAffineTransform(translationX: -oriented.minX, y: -oriented.minY))
      .concatenating(CGAffineTransform(scaleX: scale, y: scale))
      .concatenating(
        CGAffineTransform(
          translationX: (render.width - dw * scale) / 2,
          y: (render.height - dh * scale) / 2))
  }
}
