package expo.modules.videoengine

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.common.audio.AudioProcessor.UnhandledAudioFormatException
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt

/**
 * Music and sound-effect layers as Transformer audio sequences. Used by the
 * export (mixed with the video sequence) and by the preview's audio bed.
 *
 * Layers that don't overlap in time share a sequence (fewer parallel
 * decoders). Each pass of a layer is one clipped item carrying an
 * [EnvelopeAudioProcessor] that applies the layer's gain curve.
 */
@UnstableApi
object AudioLayers {
  /**
   * @param padToUs when > 0, every sequence is padded with silence to this
   *   length (used to render a bed that spans the whole timeline).
   */
  fun sequences(layers: List<EngineAudio>, videoEnd: Double, padToUs: Long = 0): List<EditedMediaItemSequence> {
    val lanes = mutableListOf<MutableList<EngineAudio>>()
    val busyUntil = mutableListOf<Double>()
    for (layer in layers.sortedBy { it.start }) {
      val end = minOf(layer.end, videoEnd)
      if (end <= layer.start || layer.outPoint <= layer.inPoint) continue
      val lane = busyUntil.indexOfFirst { it <= layer.start }.takeIf { it >= 0 } ?: run {
        lanes += mutableListOf<EngineAudio>()
        busyUntil += 0.0
        lanes.lastIndex
      }
      lanes[lane] += layer
      busyUntil[lane] = end
    }

    return lanes.map { lane ->
      val builder = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_AUDIO))
      var cursorUs = 0L
      for (layer in lane) {
        val startUs = seconds(layer.start)
        val endUs = seconds(minOf(layer.end, videoEnd))
        if (startUs > cursorUs) builder.addGap(startUs - cursorUs)
        var at = maxOf(startUs, cursorUs)
        val passUs = seconds(layer.outPoint - layer.inPoint)
        while (at < endUs) {
          val lenUs = minOf(passUs, endUs - at)
          builder.addItem(passItem(layer, lenUs, at))
          at += lenUs
          if (!layer.loop) break
        }
        cursorUs = at
      }
      if (padToUs > cursorUs) builder.addGap(padToUs - cursorUs)
      builder.build()
    }
  }

  private fun passItem(layer: EngineAudio, lengthUs: Long, timelineStartUs: Long): EditedMediaItem {
    val inMs = (layer.inPoint * 1000).toLong()
    val mediaItem = MediaItem.Builder()
      .setUri(Uri.parse(layer.uri))
      .setClippingConfiguration(
        MediaItem.ClippingConfiguration.Builder()
          .setStartPositionMs(inMs)
          .setEndPositionMs(inMs + lengthUs / 1000)
          .build()
      )
      .build()
    return EditedMediaItem.Builder(mediaItem)
      .setRemoveVideo(true)
      .setEffects(
        Effects(listOf<AudioProcessor>(EnvelopeAudioProcessor(layer, timelineStartUs / 1e6)), listOf())
      )
      .build()
  }

  private fun seconds(s: Double): Long = (s * 1_000_000).toLong()
}

/**
 * Multiplies PCM samples by the layer's gain envelope. Position is tracked by
 * counting frames since the item started (Transformer never seeks), so
 * timeline time = `timelineStart` + frames / sampleRate.
 */
@UnstableApi
class EnvelopeAudioProcessor(
  private val layer: EngineAudio,
  private val timelineStart: Double,
) : BaseAudioProcessor() {
  private var frames = 0L

  override fun onConfigure(inputAudioFormat: AudioFormat): AudioFormat {
    if (inputAudioFormat.encoding != C.ENCODING_PCM_16BIT &&
      inputAudioFormat.encoding != C.ENCODING_PCM_FLOAT
    ) {
      throw UnhandledAudioFormatException(inputAudioFormat)
    }
    return inputAudioFormat
  }

  override fun queueInput(inputBuffer: ByteBuffer) {
    val format = inputAudioFormat
    val size = inputBuffer.remaining()
    if (size == 0) return
    val output = replaceOutputBuffer(size)
    val input = inputBuffer.order(ByteOrder.nativeOrder())
    val float = format.encoding == C.ENCODING_PCM_FLOAT
    val rate = format.sampleRate.toDouble()
    while (input.remaining() >= format.bytesPerFrame) {
      val gain = layer.gainAt(timelineStart + frames / rate).toFloat()
      for (c in 0 until format.channelCount) {
        if (float) {
          output.putFloat(input.float * gain)
        } else {
          val v = (input.short * gain).roundToInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
          output.putShort(v.toShort())
        }
      }
      frames++
    }
    inputBuffer.position(inputBuffer.limit())
    output.flip()
  }

  override fun onFlush(streamMetadata: AudioProcessor.StreamMetadata) {
    frames = 0
  }
}
