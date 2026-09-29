package expo.modules.videoengine

import android.content.Context
import android.graphics.Matrix
import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.OverlaySettings
import androidx.media3.common.VideoCompositorSettings
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SpeedProvider
import androidx.media3.common.SpeedParameters
import androidx.media3.common.util.Size
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.MatrixTransformation
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.RgbMatrix
import androidx.media3.effect.StaticOverlaySettings
import androidx.media3.effect.TextureOverlay
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import com.google.common.collect.ImmutableList

/**
 * Builds the Media3 [Composition] for an EngineComposition. The preview
 * (CompositionPlayer) and the export (Transformer) use the same composition,
 * so what you see is what gets exported.
 *
 * Sequences, in order:
 *  0. main — every base clip back to back (drives output timing; drawn on top);
 *  1. transitions (only if any) — during each transition window, the "other"
 *     side of the cut (the incoming clip's lead-in before the cut, the
 *     outgoing clip's tail after it; held first/last frame when the source has
 *     no more footage), silent gaps elsewhere. [TransitionSettings] blends it
 *     with the main sequence;
 *  2+. music and sound-effect audio lanes.
 *
 * Blocking (may extract freeze frames) — build off the main thread.
 */
@UnstableApi
object CompositionFactory {
  fun build(
    context: Context,
    spec: EngineComposition,
    width: Int,
    height: Int,
    includeTexts: Boolean,
  ): Composition {
    val freezes = FreezeFrames(context)
    val main = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_AUDIO, C.TRACK_TYPE_VIDEO))
      .addItems(spec.clips.map { clip -> clipItem(clip, clip.inPoint, clip.outPoint, width, height, spec.fps, withAudio = true) })
      .build()

    val sequences = mutableListOf(main)
    val transitions = spec.transitions
      .filter { it.index >= 0 && it.index + 1 < spec.clips.size && it.half > 0 }
      .sortedBy { it.index }
    if (transitions.isNotEmpty()) {
      sequences += transitionSequence(spec, transitions, width, height, freezes)
    }
    sequences += AudioLayers.sequences(spec.audio, spec.duration)

    val builder = Composition.Builder(sequences)
    if (transitions.isNotEmpty()) {
      builder.setVideoCompositorSettings(TransitionSettings(spec, transitions, width, height))
    }
    if (includeTexts && spec.texts.isNotEmpty()) {
      // Composition-level effects run after compositing, so text stays on top
      // of transitions; frame times here are composition-timeline times.
      builder.setEffects(
        Effects(
          listOf(),
          listOf<Effect>(OverlayEffect(ImmutableList.of<TextureOverlay>(TimedTextOverlay(spec.texts, width, height)))),
        )
      )
    }
    return builder.build()
  }

  private fun transitionSequence(
    spec: EngineComposition,
    transitions: List<EngineTransition>,
    width: Int,
    height: Int,
    freezes: FreezeFrames,
  ): EditedMediaItemSequence {
    val seq = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_VIDEO))
    var cursorUs = 0L
    for (tr in transitions) {
      val a = spec.clips[tr.index]
      val b = spec.clips[tr.index + 1]
      val cut = b.start
      val startUs = us(cut - tr.half)
      if (startUs > cursorUs) seq.addGap(startUs - cursorUs)

      // Before the cut: the incoming clip's lead-in.
      val lead = minOf(tr.half * b.speed, b.inPoint)
      val leadHold = tr.half - lead / b.speed
      if (leadHold > 0.001) {
        freezes.frameAt(b.uri, b.inPoint - lead)?.let { seq.addItem(stillItem(it, b, leadHold, width, height, spec.fps)) }
          ?: seq.addGap(us(leadHold))
      }
      if (lead > 0.001) seq.addItem(clipItem(b, b.inPoint - lead, b.inPoint, width, height, spec.fps, withAudio = false))

      // After the cut: the outgoing clip's tail.
      val tail = minOf(tr.half * a.speed, maxOf(0.0, freezes.durationOf(a.uri) - a.outPoint))
      if (tail > 0.001) seq.addItem(clipItem(a, a.outPoint, a.outPoint + tail, width, height, spec.fps, withAudio = false))
      val tailHold = tr.half - tail / a.speed
      if (tailHold > 0.001) {
        freezes.frameAt(a.uri, maxOf(0.0, a.outPoint + tail - 0.04))
          ?.let { seq.addItem(stillItem(it, a, tailHold, width, height, spec.fps)) }
          ?: seq.addGap(us(tailHold))
      }
      cursorUs = us(cut + tr.half)
    }
    // Keep the sequence alive to the end (blank frames are made transparent).
    val endUs = us(spec.duration)
    if (endUs > cursorUs) seq.addGap(endUs - cursorUs)
    return seq.build()
  }

  /** One clip (or a slice of its source) with its fit, color and zoom. */
  private fun clipItem(
    clip: EngineClip,
    fromSec: Double,
    toSec: Double,
    width: Int,
    height: Int,
    fps: Double,
    withAudio: Boolean,
  ): EditedMediaItem {
    val mediaItem = MediaItem.Builder()
      .setUri(Uri.parse(clip.uri))
      .setClippingConfiguration(
        MediaItem.ClippingConfiguration.Builder()
          .setStartPositionMs((fromSec * 1000).toLong())
          .setEndPositionMs((toSec * 1000).toLong())
          .build()
      )
      .build()
    val audio = mutableListOf<AudioProcessor>()
    if (withAudio && clip.volume != 1.0) {
      val gain = clip.volume.toFloat().coerceIn(0f, 2f)
      audio += ChannelMixingAudioProcessor().apply {
        for (channels in 1..2) {
          putChannelMixingMatrix(ChannelMixingMatrix.createForConstantGain(channels, channels).scaleBy(gain))
        }
      }
    }
    val builder = EditedMediaItem.Builder(mediaItem)
      .setEffects(Effects(audio, videoEffects(clip, width, height)))
      .setFrameRate(fps.toInt().coerceIn(1, 120))
    if (!withAudio) builder.setRemoveAudio(true)
    if (clip.speed != 1.0) {
      // Keep the voice pitch natural when speeding up / slowing down.
      builder.setSpeed(SpeedParameters(ConstantSpeed(clip.speed.toFloat()), true))
    }
    return builder.build()
  }

  /** A held frame (PNG) shown for `durationSec`, placed like its clip. */
  private fun stillItem(
    imageUri: String,
    clip: EngineClip,
    durationSec: Double,
    width: Int,
    height: Int,
    fps: Double,
  ): EditedMediaItem {
    val mediaItem = MediaItem.Builder()
      .setUri(Uri.parse(imageUri))
      .setImageDurationMs((durationSec * 1000).toLong().coerceAtLeast(1))
      .build()
    return EditedMediaItem.Builder(mediaItem)
      .setFrameRate(fps.toInt().coerceIn(1, 120))
      .setEffects(Effects(listOf(), videoEffects(clip, width, height)))
      .build()
  }

  /** Fit into the output frame, then color matrix, then zoom / reframe. */
  private fun videoEffects(clip: EngineClip, width: Int, height: Int): List<Effect> {
    val effects = mutableListOf<Effect>(
      Presentation.createForWidthAndHeight(
        width, height,
        if (clip.fit == "cover") Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP else Presentation.LAYOUT_SCALE_TO_FIT,
      ),
    )
    clip.colorMatrix?.let { m ->
      // Column-major 4×4 for `uRgbMatrix * vec4(rgb, 1)`: the 4th column is the offset.
      val gl = floatArrayOf(
        m[0].toFloat(), m[4].toFloat(), m[8].toFloat(), 0f,
        m[1].toFloat(), m[5].toFloat(), m[9].toFloat(), 0f,
        m[2].toFloat(), m[6].toFloat(), m[10].toFloat(), 0f,
        m[3].toFloat(), m[7].toFloat(), m[11].toFloat(), 1f,
      )
      effects += RgbMatrix { _, _ -> gl }
    }
    clip.transform?.let { t ->
      // NDC space (−1..1, y up): scale about the center, then move the center.
      val matrix = Matrix().apply {
        setScale(t.scale.toFloat(), t.scale.toFloat())
        postTranslate((2 * t.xNorm - 1).toFloat(), (1 - 2 * t.yNorm).toFloat())
      }
      effects += MatrixTransformation { matrix }
    }
    return effects
  }

  private fun us(sec: Double): Long = (sec * 1_000_000).toLong()
}

/**
 * Blends the main sequence (input 0, on top) with the transition sequence
 * (input 1, below) inside each transition window; outside them the
 * transition sequence is transparent.
 */
@UnstableApi
class TransitionSettings(
  private val spec: EngineComposition,
  private val transitions: List<EngineTransition>,
  private val width: Int,
  private val height: Int,
) : VideoCompositorSettings {
  private val shown: OverlaySettings = StaticOverlaySettings.Builder().build()
  private val hidden: OverlaySettings = StaticOverlaySettings.Builder().setAlphaScale(0f).build()

  override fun getOutputSize(inputSizes: List<Size>): Size = Size(width, height)

  override fun getOverlaySettings(inputId: Int, presentationTimeUs: Long): OverlaySettings {
    val t = presentationTimeUs / 1e6
    val tr = transitions.firstOrNull { tr ->
      val cut = spec.clips[tr.index + 1].start
      t >= cut - tr.half && t < cut + tr.half
    } ?: return if (inputId == 0) shown else hidden
    val cut = spec.clips[tr.index + 1].start
    val p = ((t - (cut - tr.half)) / (2 * tr.half)).coerceIn(0.0, 1.0).toFloat()
    val beforeCut = t < cut
    val isMain = inputId == 0
    return when (tr.kind) {
      "fade" -> if (!isMain) hidden else alpha(if (beforeCut) 1 - 2 * p else 2 * p - 1)
      "slide" -> {
        // Outgoing clip moves left, incoming enters from the right.
        val outgoing = beforeCut == isMain
        offset(if (outgoing) -2 * p else 2 * (1 - p))
      }
      else -> if (!isMain) shown else alpha(if (beforeCut) 1 - p else p)
    }
  }

  private fun alpha(a: Float): OverlaySettings =
    StaticOverlaySettings.Builder().setAlphaScale(a.coerceIn(0f, 1f)).build()

  private fun offset(x: Float): OverlaySettings =
    StaticOverlaySettings.Builder().setBackgroundFrameAnchor(x, 0f).build()
}

@UnstableApi
private class ConstantSpeed(private val speed: Float) : SpeedProvider {
  override fun getSpeed(timeUs: Long): Float = speed
  override fun getNextSpeedChangeTimeUs(timeUs: Long): Long = C.TIME_UNSET
}
