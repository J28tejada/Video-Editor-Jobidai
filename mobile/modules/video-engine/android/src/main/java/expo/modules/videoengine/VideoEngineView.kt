package expo.modules.videoengine

import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.transformer.CompositionPlayer
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.Executors

/**
 * Native preview on Media3 CompositionPlayer: it plays the very composition
 * the export encodes (clips with fit/color/zoom/speed, transitions, music and
 * effects), decoded by the hardware codecs and composited on the GPU. Only
 * texts are left out — React Native draws them on top so they stay draggable.
 * JS drives it through the view ref (play / pause / seek).
 */
@UnstableApi
class VideoEngineView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onReady by EventDispatcher()
  private val onTimeUpdate by EventDispatcher()
  private val onEnded by EventDispatcher()
  private val onError by EventDispatcher()

  private val player: CompositionPlayer = CompositionPlayer.Builder(context).build()
  private val playerView = PlayerView(context).apply {
    layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    useController = false
    setShutterBackgroundColor(Color.BLACK)
    setKeepContentOnPlayerReset(true)
    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
    player = this@VideoEngineView.player
  }

  private var spec: EngineComposition? = null
  private var compositionJSON: String? = null
  private var buildGeneration = 0
  private var released = false
  private var scrubbing = false

  private val handler = Handler(Looper.getMainLooper())
  private val ticker = object : Runnable {
    override fun run() {
      if (released) return
      emitTime()
      if (player.isPlaying) handler.postDelayed(this, 33)
    }
  }

  init {
    setBackgroundColor(Color.BLACK)
    addView(playerView)
    player.addListener(object : Player.Listener {
      override fun onIsPlayingChanged(isPlaying: Boolean) {
        handler.removeCallbacks(ticker)
        if (isPlaying) handler.post(ticker) else emitTime()
      }

      override fun onPlaybackStateChanged(state: Int) {
        if (state == Player.STATE_ENDED) {
          player.playWhenReady = false
          onTimeUpdate(mapOf("time" to (spec?.duration ?: 0.0), "playing" to false))
          onEnded(mapOf<String, Any>())
        }
      }

      override fun onPlayerError(error: PlaybackException) {
        onError(mapOf("message" to (error.message ?: "playback error")))
      }
    })
  }

  // region Composition

  fun setComposition(json: String) {
    if (json == compositionJSON) return
    compositionJSON = json
    val next = try {
      EngineComposition.parse(json)
    } catch (e: Exception) {
      onError(mapOf("message" to (e.message ?: "invalid composition")))
      return
    }
    val resumeMs = player.currentPosition
    val generation = ++buildGeneration
    if (next.clips.isEmpty()) {
      spec = next
      player.stop()
      onReady(mapOf("duration" to 0.0))
      return
    }
    // Building may extract freeze frames (disk I/O): do it off the UI thread.
    // The preview renders at 720p (short side) to stay light on the GPU.
    val (width, height) = renderSize(next, PREVIEW_SHORT_SIDE)
    builder.execute {
      val composition = try {
        CompositionFactory.build(context, next, width, height, includeTexts = false)
      } catch (e: Exception) {
        handler.post { if (!released) onError(mapOf("message" to (e.message ?: "composition error"))) }
        return@execute
      }
      handler.post {
        if (released || generation != buildGeneration) return@post
        val wasPlaying = player.playWhenReady
        spec = next
        val startMs = resumeMs.coerceIn(0L, ((next.duration - 0.01) * 1000).toLong().coerceAtLeast(0L))
        player.setComposition(composition, startMs)
        player.prepare()
        player.playWhenReady = wasPlaying
        onReady(mapOf("duration" to next.duration))
        emitTime()
      }
    }
  }

  // endregion

  // region Transport

  fun play() {
    val s = spec ?: return
    if (s.clips.isEmpty()) return
    setScrubbing(false)
    if (player.playbackState == Player.STATE_ENDED || currentTime() >= s.duration - 0.05) {
      player.seekTo(0)
    }
    player.playWhenReady = true
  }

  fun pause() {
    player.playWhenReady = false
    emitTime()
  }

  /** Fast, keyframe-friendly seeks while scrubbing; exact when the finger lifts. */
  fun seek(time: Double, exact: Boolean) {
    val s = spec ?: return
    setScrubbing(!exact)
    player.seekTo((time.coerceIn(0.0, s.duration) * 1000).toLong())
    emitTime()
  }

  private fun setScrubbing(enabled: Boolean) {
    if (scrubbing == enabled) return
    scrubbing = enabled
    player.setScrubbingModeEnabled(enabled)
  }

  /** Current position on the composition timeline, in seconds. */
  private fun currentTime(): Double {
    val s = spec ?: return 0.0
    return (player.currentPosition / 1000.0).coerceIn(0.0, s.duration)
  }

  private fun emitTime() {
    if (released) return
    onTimeUpdate(mapOf("time" to currentTime(), "playing" to player.isPlaying))
  }

  // endregion

  fun release() {
    if (released) return
    released = true
    handler.removeCallbacks(ticker)
    playerView.player = null
    player.release()
  }

  companion object {
    private const val PREVIEW_SHORT_SIDE = 720.0
    private val builder = Executors.newSingleThreadExecutor()
  }
}
