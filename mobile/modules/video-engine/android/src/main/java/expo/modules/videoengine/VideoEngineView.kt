package expo.modules.videoengine

import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/**
 * Native preview: an ExoPlayer playlist of clipped media items, one per
 * timeline clip, decoded by the hardware codecs (MediaCodec). Speed, volume
 * and fit are applied per clip as playback moves between items. JS drives it
 * through the view ref (play / pause / seek) and receives time updates.
 */
@UnstableApi
class VideoEngineView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onReady by EventDispatcher()
  private val onTimeUpdate by EventDispatcher()
  private val onEnded by EventDispatcher()
  private val onError by EventDispatcher()

  private val player: ExoPlayer = ExoPlayer.Builder(context).build()
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
  private var released = false

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
      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        applyClipSettings()
      }

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
    val resumeAt = currentTime()
    val wasPlaying = player.playWhenReady
    spec = next
    if (next.clips.isEmpty()) {
      player.clearMediaItems()
      onReady(mapOf("duration" to 0.0))
      return
    }
    val items = next.clips.map { clip ->
      MediaItem.Builder()
        .setUri(Uri.parse(clip.uri))
        .setMediaId(clip.id)
        .setClippingConfiguration(
          MediaItem.ClippingConfiguration.Builder()
            .setStartPositionMs((clip.inPoint * 1000).toLong())
            .setEndPositionMs((clip.outPoint * 1000).toLong())
            .build()
        )
        .build()
    }
    player.setMediaItems(items)
    player.prepare()
    seekInternal(resumeAt.coerceAtMost((next.duration - 0.01).coerceAtLeast(0.0)), exact = true)
    player.playWhenReady = wasPlaying
    onReady(mapOf("duration" to next.duration))
  }

  /** Speed, volume and fit of the clip currently playing. */
  private fun applyClipSettings() {
    val clip = spec?.clips?.getOrNull(player.currentMediaItemIndex) ?: return
    player.playbackParameters = PlaybackParameters(clip.speed.toFloat())
    // ExoPlayer volume is 0..1; boosts above 1 are clamped in preview.
    player.volume = clip.volume.toFloat().coerceIn(0f, 1f)
    playerView.resizeMode =
      if (clip.fit == "cover") AspectRatioFrameLayout.RESIZE_MODE_ZOOM
      else AspectRatioFrameLayout.RESIZE_MODE_FIT
  }

  // endregion

  // region Transport

  fun play() {
    if (spec?.clips.isNullOrEmpty()) return
    if (player.playbackState == Player.STATE_ENDED) seekInternal(0.0, exact = true)
    player.playWhenReady = true
  }

  fun pause() {
    player.playWhenReady = false
    emitTime()
  }

  fun seek(time: Double, exact: Boolean) {
    seekInternal(time, exact)
    emitTime()
  }

  private fun seekInternal(time: Double, exact: Boolean) {
    val s = spec ?: return
    val index = s.clipIndexAt(time)
    if (index < 0) return
    val clip = s.clips[index]
    val offsetSec = ((time - clip.start) * clip.speed).coerceIn(0.0, clip.outPoint - clip.inPoint)
    player.setSeekParameters(if (exact) SeekParameters.EXACT else SeekParameters.CLOSEST_SYNC)
    player.seekTo(index, (offsetSec * 1000).toLong())
    applyClipSettings()
  }

  /** Current position on the composition timeline, in seconds. */
  private fun currentTime(): Double {
    val s = spec ?: return 0.0
    val clip = s.clips.getOrNull(player.currentMediaItemIndex) ?: return 0.0
    return (clip.start + player.currentPosition / 1000.0 / clip.speed).coerceIn(0.0, s.duration)
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
}
