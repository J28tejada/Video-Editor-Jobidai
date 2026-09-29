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
///  - two video tracks (A/B roll): consecutive clips alternate, so both sides
///    of a transition are available at once. Each clip is extended past its
///    cut by the transition half on either side — with real source frames
///    when the trim leaves some, else by holding the first/last frame;
///  - one audio track with the clips' sound back to back (time-scaled for
///    speed) and an audio mix for per-clip volume;
///  - EngineInstructions for the custom Core Image compositor: one per clip
///    body and one per transition window.
/// Decoding runs on the hardware pipeline; compositing on the GPU.
enum CompositionBuilder {
  static let timescale: CMTimeScale = 600
  /// Duration of the single frame used for freeze frames.
  private static let frame = CMTime(value: 1, timescale: 30)

  static func build(_ spec: EngineComposition, renderSize: CGSize) async throws -> BuiltComposition {
    let composition = AVMutableComposition()
    guard
      let trackA = composition.addMutableTrack(
        withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
      let trackB = composition.addMutableTrack(
        withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
      let audioTrack = composition.addMutableTrack(
        withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
    else {
      throw InvalidCompositionException("could not create composition tracks")
    }
    let videoTracks = [trackA, trackB]

    // Transition halves on each side of every clip.
    let n = spec.clips.count
    var halfBefore = [Double](repeating: 0, count: n)
    var halfAfter = [Double](repeating: 0, count: n)
    var kindAfter = [String](repeating: "crossfade", count: n)
    for tr in spec.transitions where tr.index >= 0 && tr.index + 1 < n && tr.half > 0 {
      halfAfter[tr.index] = tr.half
      halfBefore[tr.index + 1] = tr.half
      kindAfter[tr.index] = tr.kind
    }

    let audioParams = AVMutableAudioMixInputParameters(track: audioTrack)
    var hasAudio = false
    var cursor = CMTime.zero
    var layers: [ClipLayer] = []
    var bodies: [(start: Double, end: Double)] = []

    for (i, clip) in spec.clips.enumerated() {
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
      let speed = clip.speed > 0 ? clip.speed : 1
      let track = videoTracks[layers.count % 2]

      // Incoming transition: frames before the in-point (or a held first frame).
      let pre = halfBefore[i]
      if pre > 0 {
        var at = cursor - seconds(pre)
        let available = min(pre * speed, inTime.seconds)
        let hold = pre - available / speed
        if hold > 0.001 {
          at = try insert(
            track, srcVideo, from: inTime - seconds(available), length: frame, at: at,
            duration: seconds(hold))
        }
        if available > 0.001 {
          at = try insert(
            track, srcVideo, from: inTime - seconds(available), length: seconds(available), at: at,
            duration: seconds(available / speed))
        }
      }

      // Body.
      let bodyDuration = CMTimeMultiplyByFloat64(outTime - inTime, multiplier: 1 / speed)
      _ = try insert(track, srcVideo, from: inTime, length: outTime - inTime, at: cursor, duration: bodyDuration)
      if let srcAudio {
        _ = try insert(audioTrack, srcAudio, from: inTime, length: outTime - inTime, at: cursor, duration: bodyDuration)
        hasAudio = true
      }
      let clipEnd = cursor + bodyDuration

      // Outgoing transition: frames after the out-point (or a held last frame).
      let post = halfAfter[i]
      if post > 0 {
        var at = clipEnd
        let available = min(post * speed, max(0, (assetDuration - outTime).seconds))
        if available > 0.001 {
          at = try insert(
            track, srcVideo, from: outTime, length: seconds(available), at: at,
            duration: seconds(available / speed))
        }
        let hold = post - available / speed
        if hold > 0.001 {
          let last = CMTimeMaximum(.zero, outTime + seconds(available) - frame)
          _ = try insert(track, srcVideo, from: last, length: frame, at: at, duration: seconds(hold))
        }
      }

      var layer = ClipLayer(
        trackID: track.trackID,
        transform: placement(
          natural: naturalSize, preferred: preferredTransform, render: renderSize,
          cover: clip.fit == "cover", zoom: clip.transform),
        colorMatrix: clip.colorMatrix)
      if let keys = clip.transformKeys, !keys.isEmpty {
        layer.animated = AnimatedPlacement(
          natural: naturalSize, preferred: preferredTransform, render: renderSize,
          cover: clip.fit == "cover", keys: keys, start: cursor.seconds, inPoint: inTime.seconds,
          speed: speed)
      }
      layers.append(layer)
      bodies.append((cursor.seconds, clipEnd.seconds))

      // AVAudioMix volume is limited to 0...1; boosts above 1 are clamped.
      audioParams.setVolume(Float(min(max(clip.volume, 0), 1)), at: cursor)
      cursor = clipEnd
    }

    if !hasAudio { composition.removeTrack(audioTrack) }
    let layerParams = try await addAudioLayers(spec.audio, to: composition, videoEnd: cursor)

    // Instructions tile [0, end]: clip bodies between transition windows.
    var instructions: [EngineInstruction] = []
    for (i, layer) in layers.enumerated() {
      let bodyStart = bodies[i].start + halfBefore[i]
      let bodyEnd = bodies[i].end - halfAfter[i]
      if bodyEnd > bodyStart + 0.0005 {
        instructions.append(
          EngineInstruction(timeRange: range(bodyStart, bodyEnd), from: layer))
      }
      if halfAfter[i] > 0, i + 1 < layers.count {
        instructions.append(
          EngineInstruction(
            timeRange: range(bodyEnd, bodies[i].end + halfAfter[i]), from: layer,
            to: layers[i + 1], kind: kindAfter[i]))
      }
    }
    // Absorb rounding drift so the instructions end exactly at the composition end.
    if let last = instructions.popLast() {
      instructions.append(
        last.piece(CMTimeRange(start: last.timeRange.start, end: composition.duration), overlay: nil))
    }
    let cutaways = try await addCutaways(
      spec.cutaways, to: composition, renderSize: renderSize, end: composition.duration)
    if !cutaways.isEmpty { instructions = split(instructions, by: cutaways) }

    let videoComposition = AVMutableVideoComposition()
    videoComposition.customVideoCompositorClass = EngineCompositor.self
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

  /// B-roll on its own video track (overlapping ones after the first are
  /// dropped, as on Android), shown in full cover over the main picture.
  private static func addCutaways(
    _ cutaways: [EngineCutaway], to composition: AVMutableComposition, renderSize: CGSize,
    end: CMTime
  ) async throws -> [(range: CMTimeRange, layer: ClipLayer)] {
    guard !cutaways.isEmpty,
      let track = composition.addMutableTrack(
        withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
    else { return [] }
    var out: [(range: CMTimeRange, layer: ClipLayer)] = []
    var busyUntil = 0.0
    for c in cutaways.sorted(by: { $0.start < $1.start }) where c.start >= busyUntil - 0.001 {
      let startT = seconds(max(0, c.start))
      let endT = CMTimeMinimum(seconds(c.end), end)
      guard endT > startT, let url = URL(string: c.uri) else { continue }
      let asset = AVURLAsset(url: url)
      guard let src = try await asset.loadTracks(withMediaType: .video).first else { continue }
      let assetDuration = try await asset.load(.duration)
      let natural = try await src.load(.naturalSize)
      let preferred = try await src.load(.preferredTransform)
      let inTime = seconds(max(0, c.inPoint))
      let length = CMTimeMinimum(endT - startT, assetDuration - inTime)
      guard length > .zero else { continue }
      try track.insertTimeRange(CMTimeRange(start: inTime, duration: length), of: src, at: startT)
      let range = CMTimeRange(start: startT, duration: length)
      out.append((
        range,
        ClipLayer(
          trackID: track.trackID,
          transform: placement(
            natural: natural, preferred: preferred, render: renderSize, cover: c.fit == "cover",
            zoom: nil),
          colorMatrix: c.colorMatrix)
      ))
      busyUntil = range.end.seconds
    }
    if out.isEmpty { composition.removeTrack(track) }
    return out
  }

  /// Splits instructions at B-roll boundaries so each piece either has the
  /// B-roll on top or not; transition progress keeps its full window.
  private static func split(
    _ instructions: [EngineInstruction], by cutaways: [(range: CMTimeRange, layer: ClipLayer)]
  ) -> [EngineInstruction] {
    var out: [EngineInstruction] = []
    for ins in instructions {
      var cuts = [ins.timeRange.start, ins.timeRange.end]
      for c in cutaways {
        for t in [c.range.start, c.range.end] where t > ins.timeRange.start && t < ins.timeRange.end {
          cuts.append(t)
        }
      }
      cuts.sort { $0 < $1 }
      for i in 0..<(cuts.count - 1) where cuts[i + 1] > cuts[i] {
        let piece = CMTimeRange(start: cuts[i], end: cuts[i + 1])
        let mid = piece.start + CMTimeMultiplyByRatio(piece.duration, multiplier: 1, divisor: 2)
        let overlay = cutaways.first { $0.range.containsTime(mid) }?.layer
        out.append(ins.piece(piece, overlay: overlay))
      }
    }
    return out
  }

  /// Inserts `length` of source starting at `from` so that it occupies
  /// `duration` on the timeline at `at` (stretching a single frame = freeze).
  /// Returns the end time.
  @discardableResult
  private static func insert(
    _ track: AVMutableCompositionTrack, _ source: AVAssetTrack, from: CMTime, length: CMTime,
    at: CMTime, duration: CMTime
  ) throws -> CMTime {
    try track.insertTimeRange(CMTimeRange(start: from, duration: length), of: source, at: at)
    if CMTimeCompare(length, duration) != 0 {
      track.scaleTimeRange(CMTimeRange(start: at, duration: length), toDuration: duration)
    }
    return at + duration
  }

  private static func seconds(_ s: Double) -> CMTime {
    CMTime(seconds: s, preferredTimescale: timescale)
  }

  private static func range(_ a: Double, _ b: Double) -> CMTimeRange {
    CMTimeRange(start: seconds(a), end: seconds(b))
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
  /// frame: contain = letterbox, cover = fill + crop; then the optional zoom
  /// scales the fitted frame and centers it at (xNorm, yNorm).
  static func placement(
    natural: CGSize, preferred: CGAffineTransform, render: CGSize, cover: Bool,
    zoom: EngineTransform?
  ) -> CGAffineTransform {
    let oriented = CGRect(origin: .zero, size: natural).applying(preferred)
    let dw = abs(oriented.width)
    let dh = abs(oriented.height)
    guard dw > 0, dh > 0 else { return preferred }
    let fit =
      cover
      ? max(render.width / dw, render.height / dh)
      : min(render.width / dw, render.height / dh)
    let scale = fit * CGFloat(zoom?.scale ?? 1)
    let cx = CGFloat(zoom?.xNorm ?? 0.5) * render.width
    let cy = CGFloat(zoom?.yNorm ?? 0.5) * render.height
    return
      preferred
      .concatenating(CGAffineTransform(translationX: -oriented.minX, y: -oriented.minY))
      .concatenating(CGAffineTransform(scaleX: scale, y: scale))
      .concatenating(CGAffineTransform(translationX: cx - dw * scale / 2, y: cy - dh * scale / 2))
  }
}
