import AVFoundation
import ExpoModulesCore

/// Native preview: plays the composition through AVPlayer, so decode and
/// compositing run on the hardware pipeline. JS drives it via the view ref
/// (play / pause / seek) and gets time updates as events.
class VideoEngineView: ExpoView {
  let onReady = EventDispatcher()
  let onTimeUpdate = EventDispatcher()
  let onEnded = EventDispatcher()
  let onError = EventDispatcher()

  private let player = AVPlayer()
  private let playerLayer = AVPlayerLayer()
  private var timeObserver: Any?
  private var endObserver: NSObjectProtocol?
  private var buildTask: Task<Void, Never>?
  private var compositionJSON: String?
  private var duration: Double = 0

  // Seek coalescing: while a seek is in flight only the latest request is kept,
  // so fast scrubbing never queues up stale seeks.
  private var seeking = false
  private var pendingSeek: (time: Double, exact: Bool)?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)

    player.actionAtItemEnd = .pause
    playerLayer.player = player
    playerLayer.videoGravity = .resizeAspect
    layer.addSublayer(playerLayer)

    timeObserver = player.addPeriodicTimeObserver(
      forInterval: CMTime(value: 1, timescale: 30), queue: .main
    ) { [weak self] time in
      self?.emitTime(time.seconds)
    }
  }

  deinit {
    if let timeObserver { player.removeTimeObserver(timeObserver) }
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    buildTask?.cancel()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    playerLayer.frame = bounds
    CATransaction.commit()
  }

  // MARK: - Composition

  func setComposition(_ json: String) {
    guard json != compositionJSON else { return }
    compositionJSON = json
    rebuild(json)
  }

  private func rebuild(_ json: String) {
    let resumeAt = player.currentTime().seconds.isFinite ? player.currentTime().seconds : 0
    let wasPlaying = player.rate != 0
    buildTask?.cancel()
    buildTask = Task { @MainActor [weak self] in
      guard let self else { return }
      do {
        let spec = try EngineComposition.decode(json)
        if spec.clips.isEmpty {
          self.player.replaceCurrentItem(with: nil)
          self.duration = 0
          self.onReady(["duration": 0])
          return
        }
        let built = try await CompositionBuilder.build(
          spec, renderSize: CompositionBuilder.renderSize(for: spec))
        guard !Task.isCancelled else { return }

        let item = AVPlayerItem(asset: built.asset)
        item.videoComposition = built.videoComposition
        item.audioMix = built.audioMix
        item.audioTimePitchAlgorithm = .spectral
        self.observeEnd(of: item)
        self.player.replaceCurrentItem(with: item)
        self.duration = built.duration

        let target = CMTime(
          seconds: min(resumeAt, max(0, built.duration - 0.01)),
          preferredTimescale: CompositionBuilder.timescale)
        await self.player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero)
        if wasPlaying { self.player.play() }
        self.onReady(["duration": built.duration])
        self.emitTime(self.player.currentTime().seconds)
      } catch {
        guard !Task.isCancelled else { return }
        self.onError(["message": error.localizedDescription])
      }
    }
  }

  private func observeEnd(of item: AVPlayerItem) {
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    endObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
    ) { [weak self] _ in
      guard let self else { return }
      self.emitTime(self.duration)
      self.onEnded([:])
    }
  }

  // MARK: - Transport

  func play() {
    guard player.currentItem != nil else { return }
    // Restart from the top when play is pressed at the end.
    if player.currentTime().seconds >= duration - 0.05 {
      player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero)
    }
    player.play()
    emitTime(player.currentTime().seconds)
  }

  func pause() {
    player.pause()
    emitTime(player.currentTime().seconds)
  }

  func seek(to time: Double, exact: Bool) {
    guard player.currentItem != nil else { return }
    let clamped = min(max(0, time), max(0, duration))
    if seeking {
      pendingSeek = (clamped, exact)
      return
    }
    seeking = true
    let tolerance = exact ? CMTime.zero : CMTime(value: 1, timescale: 10)
    player.seek(
      to: CMTime(seconds: clamped, preferredTimescale: CompositionBuilder.timescale),
      toleranceBefore: tolerance, toleranceAfter: tolerance
    ) { [weak self] _ in
      DispatchQueue.main.async {
        guard let self else { return }
        self.seeking = false
        self.emitTime(self.player.currentTime().seconds)
        if let next = self.pendingSeek {
          self.pendingSeek = nil
          self.seek(to: next.time, exact: next.exact)
        }
      }
    }
  }

  private func emitTime(_ seconds: Double) {
    guard seconds.isFinite else { return }
    onTimeUpdate(["time": min(seconds, duration), "playing": player.rate != 0])
  }
}
