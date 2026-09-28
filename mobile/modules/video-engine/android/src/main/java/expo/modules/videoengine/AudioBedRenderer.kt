package expo.modules.videoengine

import android.content.Context
import android.net.Uri
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.transformer.Composition
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import java.io.File

/**
 * Preview audio for music and sound effects on Android.
 *
 * ExoPlayer plays one audio track at a time, so the extra layers are mixed
 * ahead of time into a single "bed" file (audio-only Transformer export with
 * the same sequences the final export uses) that plays alongside the video.
 * Beds are cached by content, so undo/redo back to a previous mix is instant.
 * Main thread only.
 */
@UnstableApi
class AudioBedRenderer(private val context: Context) {
  private var transformer: Transformer? = null
  private var pendingKey: String? = null

  fun render(
    layers: List<EngineAudio>,
    videoEnd: Double,
    onDone: (uri: String?) -> Unit,
  ) {
    cancel()
    if (layers.isEmpty() || videoEnd <= 0) {
      onDone(null)
      return
    }
    val key = "${layers.hashCode()}-${(videoEnd * 1000).toLong()}"
    val dir = File(context.cacheDir, "beds").apply { mkdirs() }
    val output = File(dir, "bed-${Integer.toUnsignedString(key.hashCode(), 36)}.m4a")
    if (output.exists()) {
      onDone(Uri.fromFile(output).toString())
      return
    }

    val padUs = (videoEnd * 1_000_000).toLong()
    val sequences = AudioLayers.sequences(layers, videoEnd, padToUs = padUs)
    if (sequences.isEmpty()) {
      onDone(null)
      return
    }
    val partial = File(dir, "${output.nameWithoutExtension}.part.m4a")
    pendingKey = key
    val t = Transformer.Builder(context)
      .setAudioMimeType(MimeTypes.AUDIO_AAC)
      .addListener(object : Transformer.Listener {
        override fun onCompleted(composition: Composition, exportResult: ExportResult) {
          if (pendingKey != key) return
          transformer = null
          pendingKey = null
          partial.renameTo(output)
          onDone(Uri.fromFile(output).toString())
        }

        override fun onError(
          composition: Composition,
          exportResult: ExportResult,
          exportException: ExportException,
        ) {
          if (pendingKey != key) return
          transformer = null
          pendingKey = null
          partial.delete()
          onDone(null)
        }
      })
      .build()
    transformer = t
    t.start(Composition.Builder(sequences).build(), partial.absolutePath)
  }

  fun cancel() {
    pendingKey = null
    transformer?.cancel()
    transformer = null
  }
}
