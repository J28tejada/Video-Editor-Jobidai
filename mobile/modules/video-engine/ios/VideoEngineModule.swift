import AVFoundation
import ExpoModulesCore
import UIKit

public class VideoEngineModule: Module {
  private var exportSession: AVAssetExportSession?

  public func definition() -> ModuleDefinition {
    Name("VideoEngine")

    Events("onExportProgress")

    AsyncFunction("getMediaInfoAsync") { (uri: String) async throws -> [String: Any] in
      guard let url = URL(string: uri) else { throw MediaLoadException(uri) }
      let asset = AVURLAsset(url: url)
      let duration = try await asset.load(.duration).seconds
      let audioTracks = try await asset.loadTracks(withMediaType: .audio)
      var info: [String: Any] = [
        "durationSec": duration,
        "hasAudio": !audioTracks.isEmpty,
        "hasVideo": false,
        "width": 0,
        "height": 0,
      ]
      // Audio-only files (music, sound effects) are valid sources too.
      guard let video = try await asset.loadTracks(withMediaType: .video).first else {
        if audioTracks.isEmpty { throw MediaLoadException("no audio or video in \(url.lastPathComponent)") }
        if let format = try await audioTracks[0].load(.formatDescriptions).first {
          info["codec"] = fourCC(CMFormatDescriptionGetMediaSubType(format))
        }
        return info
      }
      let natural = try await video.load(.naturalSize)
      let transform = try await video.load(.preferredTransform)
      let oriented = CGRect(origin: .zero, size: natural).applying(transform)
      let fps = try await video.load(.nominalFrameRate)
      let formats = try await video.load(.formatDescriptions)
      info["hasVideo"] = true
      info["width"] = abs(oriented.width)
      info["height"] = abs(oriented.height)
      if fps > 0 { info["fps"] = Double(fps) }
      if let format = formats.first {
        info["codec"] = fourCC(CMFormatDescriptionGetMediaSubType(format))
      }
      return info
    }

    AsyncFunction("generateThumbnailsAsync") {
      (uri: String, times: [Double], maxSize: Double) async throws -> [String] in
      guard let url = URL(string: uri) else { throw MediaLoadException(uri) }
      let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
      generator.appliesPreferredTrackTransform = true
      generator.maximumSize = CGSize(width: maxSize, height: maxSize)
      let tolerance = CMTime(value: 1, timescale: 10)
      generator.requestedTimeToleranceBefore = tolerance
      generator.requestedTimeToleranceAfter = tolerance

      let dir = FileManager.default.temporaryDirectory.appendingPathComponent(
        "thumbs", isDirectory: true)
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      let key = String(UInt(bitPattern: uri.hashValue), radix: 36)

      var results: [String] = []
      for t in times {
        let file = dir.appendingPathComponent("\(key)-\(Int(t * 1000))-\(Int(maxSize)).jpg")
        if FileManager.default.fileExists(atPath: file.path) {
          results.append(file.absoluteString)
          continue
        }
        do {
          let (cg, _) = try await generator.image(at: CMTime(seconds: t, preferredTimescale: 600))
          guard let data = UIImage(cgImage: cg).jpegData(compressionQuality: 0.7) else {
            results.append("")
            continue
          }
          try data.write(to: file)
          results.append(file.absoluteString)
        } catch {
          results.append("")
        }
      }
      return results
    }

    AsyncFunction("extractAudioAsync") {
      (uri: String, startSec: Double, endSec: Double, sampleRate: Double) async throws -> String in
      try await AudioExtractor.extract(uri: uri, start: startSec, end: endSec, sampleRate: sampleRate)
    }

    AsyncFunction("exportAsync") { (json: String, shortSide: Double) async throws -> [String: Any] in
      guard self.exportSession == nil else { throw ExportInProgressException() }
      let spec = try EngineComposition.decode(json)
      guard !spec.clips.isEmpty else { throw InvalidCompositionException("timeline is empty") }

      let renderSize = CompositionBuilder.renderSize(for: spec, shortSide: shortSide)
      let built = try await CompositionBuilder.build(spec, renderSize: renderSize)
      built.videoComposition.animationTool = TextRenderer.animationTool(
        texts: spec.texts, renderSize: renderSize, duration: built.duration)

      guard
        let session = AVAssetExportSession(
          asset: built.asset, presetName: AVAssetExportPresetHighestQuality)
      else {
        throw ExportFailedException("could not create export session")
      }
      let output = FileManager.default.temporaryDirectory.appendingPathComponent(
        "export-\(Int(Date().timeIntervalSince1970)).mp4")
      try? FileManager.default.removeItem(at: output)
      session.outputURL = output
      session.outputFileType = .mp4
      session.shouldOptimizeForNetworkUse = true
      session.videoComposition = built.videoComposition
      session.audioMix = built.audioMix
      session.audioTimePitchAlgorithm = .spectral
      self.exportSession = session
      defer { self.exportSession = nil }

      // Poll progress while the export runs.
      let progressTask = Task { [weak self, weak session] in
        while !Task.isCancelled {
          guard let session else { return }
          self?.sendEvent("onExportProgress", ["progress": Double(session.progress)])
          try? await Task.sleep(nanoseconds: 250_000_000)
        }
      }
      defer { progressTask.cancel() }

      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        session.exportAsynchronously { continuation.resume() }
      }

      switch session.status {
      case .completed:
        self.sendEvent("onExportProgress", ["progress": 1.0])
        return ["uri": output.absoluteString]
      case .cancelled:
        throw ExportCancelledException()
      default:
        throw ExportFailedException(session.error?.localizedDescription ?? "unknown error")
      }
    }

    AsyncFunction("cancelExportAsync") {
      if let session = self.exportSession {
        session.cancelExport()
      }
    }

    View(VideoEngineView.self) {
      Events("onReady", "onTimeUpdate", "onEnded", "onError")

      Prop("composition") { (view: VideoEngineView, json: String) in
        view.setComposition(json)
      }

      AsyncFunction("play") { (view: VideoEngineView) in
        view.play()
      }

      AsyncFunction("pause") { (view: VideoEngineView) in
        view.pause()
      }

      AsyncFunction("seek") { (view: VideoEngineView, time: Double, exact: Bool) in
        view.seek(to: time, exact: exact)
      }
    }
  }
}

private func fourCC(_ code: FourCharCode) -> String {
  let bytes = [24, 16, 8, 0].map { UInt8((code >> $0) & 0xff) }
  return String(bytes: bytes, encoding: .ascii)?.trimmingCharacters(in: .whitespaces) ?? ""
}
