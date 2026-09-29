import AVFoundation

/// Decodes a time range of a file's audio to raw mono float32 PCM
/// (little-endian) at the requested sample rate — the input format used by
/// silence detection and Whisper. AVAssetReader does the decoding, downmix
/// and resampling.
enum AudioExtractor {
  static func extract(uri: String, start: Double, end: Double, sampleRate: Double) async throws
    -> String
  {
    guard let url = URL(string: uri) else { throw MediaLoadException(uri) }
    let output = FileManager.default.temporaryDirectory.appendingPathComponent(
      "pcm-\(UUID().uuidString).f32")
    FileManager.default.createFile(atPath: output.path, contents: nil)

    let asset = AVURLAsset(url: url)
    // No audio track → empty PCM (callers treat it as silence / no speech).
    guard let track = try await asset.loadTracks(withMediaType: .audio).first, end > start else {
      return output.absoluteString
    }

    let reader = try AVAssetReader(asset: asset)
    let trackOutput = AVAssetReaderTrackOutput(
      track: track,
      outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: sampleRate,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 32,
        AVLinearPCMIsFloatKey: true,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
      ])
    trackOutput.alwaysCopiesSampleData = false
    reader.add(trackOutput)
    reader.timeRange = CMTimeRange(
      start: CMTime(seconds: max(0, start), preferredTimescale: 600),
      end: CMTime(seconds: end, preferredTimescale: 600))
    guard reader.startReading() else {
      throw MediaLoadException(reader.error?.localizedDescription ?? url.lastPathComponent)
    }

    let handle = try FileHandle(forWritingTo: output)
    defer { try? handle.close() }
    while let sample = trackOutput.copyNextSampleBuffer() {
      guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
      let length = CMBlockBufferGetDataLength(block)
      guard length > 0 else { continue }
      var data = Data(count: length)
      let status = data.withUnsafeMutableBytes { raw -> OSStatus in
        guard let base = raw.baseAddress else { return -1 }
        return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: base)
      }
      if status == noErr { try handle.write(contentsOf: data) }
    }
    if reader.status == .failed {
      throw MediaLoadException(reader.error?.localizedDescription ?? url.lastPathComponent)
    }
    return output.absoluteString
  }
}
