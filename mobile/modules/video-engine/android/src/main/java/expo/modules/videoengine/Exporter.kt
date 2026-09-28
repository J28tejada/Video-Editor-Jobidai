package expo.modules.videoengine

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.SpeedParameters
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.ChannelMixingAudioProcessor
import androidx.media3.common.audio.ChannelMixingMatrix
import androidx.media3.common.audio.SpeedProvider
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.TextureOverlay
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import com.google.common.collect.ImmutableList
import java.io.File

/**
 * Renders an EngineComposition to MP4 with Media3 Transformer: one clipped,
 * speed-adjusted item per clip in a single sequence, scaled into the output
 * frame (contain/cover), per-clip gain, text burned in with an overlay, and
 * music / sound effects mixed in from extra audio sequences.
 * Must be used from the main thread (Transformer callbacks use its looper).
 */
@UnstableApi
class Exporter(private val context: Context) {
  private var transformer: Transformer? = null
  private val handler = Handler(Looper.getMainLooper())

  val isRunning: Boolean get() = transformer != null

  fun start(
    spec: EngineComposition,
    shortSide: Double,
    onProgress: (Double) -> Unit,
    onFinished: (Result<String>) -> Unit,
  ) {
    val (width, height) = renderSize(spec, shortSide)
    val output = File(context.cacheDir, "export-${System.currentTimeMillis()}.mp4")

    val items = spec.clips.map { clip -> editedItem(clip, spec, width, height) }
    // Declaring both track types makes Transformer synthesize silence for
    // clips without audio, so mixed audio/no-audio timelines still export.
    val sequence = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_AUDIO, C.TRACK_TYPE_VIDEO))
      .addItems(items)
      .build()
    // Music / sound-effect layers are extra audio sequences mixed with the clips.
    val audioSequences = AudioLayers.sequences(spec.audio, spec.duration)
    val composition = Composition.Builder(listOf(sequence) + audioSequences).build()

    val progressHolder = ProgressHolder()
    val poll = object : Runnable {
      override fun run() {
        val t = transformer ?: return
        if (t.getProgress(progressHolder) == Transformer.PROGRESS_STATE_AVAILABLE) {
          onProgress(progressHolder.progress / 100.0)
        }
        handler.postDelayed(this, 250)
      }
    }

    val t = Transformer.Builder(context)
      .setVideoMimeType(MimeTypes.VIDEO_H264)
      .setAudioMimeType(MimeTypes.AUDIO_AAC)
      .addListener(object : Transformer.Listener {
        override fun onCompleted(composition: Composition, exportResult: ExportResult) {
          handler.removeCallbacks(poll)
          transformer = null
          onProgress(1.0)
          onFinished(Result.success(Uri.fromFile(output).toString()))
        }

        override fun onError(
          composition: Composition,
          exportResult: ExportResult,
          exportException: ExportException,
        ) {
          handler.removeCallbacks(poll)
          transformer = null
          output.delete()
          onFinished(Result.failure(ExportFailedException(exportException.message ?: "error", exportException)))
        }
      })
      .build()
    transformer = t
    t.start(composition, output.absolutePath)
    handler.post(poll)
  }

  /** Cancels the running export. Returns false when nothing was running. */
  fun cancel(): Boolean {
    val t = transformer ?: return false
    transformer = null
    t.cancel()
    return true
  }

  private fun editedItem(clip: EngineClip, spec: EngineComposition, width: Int, height: Int): EditedMediaItem {
    val mediaItem = MediaItem.Builder()
      .setUri(Uri.parse(clip.uri))
      .setClippingConfiguration(
        MediaItem.ClippingConfiguration.Builder()
          .setStartPositionMs((clip.inPoint * 1000).toLong())
          .setEndPositionMs((clip.outPoint * 1000).toLong())
          .build()
      )
      .build()

    val videoEffects = mutableListOf<Effect>(
      Presentation.createForWidthAndHeight(
        width, height,
        if (clip.fit == "cover") Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP
        else Presentation.LAYOUT_SCALE_TO_FIT,
      ),
    )
    if (spec.texts.isNotEmpty()) {
      videoEffects += OverlayEffect(ImmutableList.of<TextureOverlay>(TimedTextOverlay(spec.texts, width, height, clip)))
    }

    val audioProcessors = mutableListOf<AudioProcessor>()
    if (clip.volume != 1.0) {
      val gain = clip.volume.toFloat().coerceIn(0f, 2f)
      audioProcessors += ChannelMixingAudioProcessor().apply {
        for (channels in 1..2) {
          putChannelMixingMatrix(ChannelMixingMatrix.createForConstantGain(channels, channels).scaleBy(gain))
        }
      }
    }

    val builder = EditedMediaItem.Builder(mediaItem)
      .setEffects(Effects(audioProcessors, videoEffects))
    if (clip.speed != 1.0) {
      // Keep the voice pitch natural when speeding up / slowing down.
      builder.setSpeed(SpeedParameters(ConstantSpeed(clip.speed.toFloat()), true))
    }
    return builder.build()
  }
}

@UnstableApi
private class ConstantSpeed(private val speed: Float) : SpeedProvider {
  override fun getSpeed(timeUs: Long): Float = speed
  override fun getNextSpeedChangeTimeUs(timeUs: Long): Long = C.TIME_UNSET
}
