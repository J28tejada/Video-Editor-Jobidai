package expo.modules.videoengine

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Decodes a time range of a file's audio to raw mono float32 PCM
 * (little-endian) at the requested sample rate — the input format used by
 * silence detection and Whisper. MediaCodec decodes; channels are averaged to
 * mono and a streaming box-filter decimator resamples (enough for speech and
 * loudness analysis). Blocking — call off the main thread.
 */
object AudioExtractor {
  private const val TIMEOUT_US = 10_000L

  fun extract(context: Context, uri: String, startSec: Double, endSec: Double, sampleRate: Int): String {
    val output = File(context.cacheDir, "pcm-${System.nanoTime()}.f32")
    val extractor = MediaExtractor()
    var codec: MediaCodec? = null
    BufferedOutputStream(FileOutputStream(output), 1 shl 16).use { out ->
      try {
        extractor.setDataSource(context, Uri.parse(uri), null)
        val trackIndex = (0 until extractor.trackCount).firstOrNull {
          extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
        } ?: return Uri.fromFile(output).toString() // no audio → empty PCM
        if (endSec <= startSec) return Uri.fromFile(output).toString()

        val format = extractor.getTrackFormat(trackIndex)
        extractor.selectTrack(trackIndex)
        val startUs = (startSec * 1_000_000).toLong()
        val endUs = (endSec * 1_000_000).toLong()
        extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)

        val decoder = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
        codec = decoder
        decoder.configure(format, null, null, 0)
        decoder.start()

        val resampler = Resampler(sampleRate, out)
        val info = MediaCodec.BufferInfo()
        var inputDone = false
        var outputDone = false
        while (!outputDone) {
          if (!inputDone) {
            val inIndex = decoder.dequeueInputBuffer(TIMEOUT_US)
            if (inIndex >= 0) {
              val buffer = decoder.getInputBuffer(inIndex)!!
              val size = extractor.readSampleData(buffer, 0)
              if (size < 0 || extractor.sampleTime > endUs) {
                decoder.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                inputDone = true
              } else {
                decoder.queueInputBuffer(inIndex, 0, size, extractor.sampleTime, 0)
                extractor.advance()
              }
            }
          }
          val outIndex = decoder.dequeueOutputBuffer(info, TIMEOUT_US)
          when {
            outIndex >= 0 -> {
              if (info.size > 0) {
                val buffer = decoder.getOutputBuffer(outIndex)!!
                buffer.position(info.offset)
                buffer.limit(info.offset + info.size)
                val fmt = decoder.outputFormat
                resampler.feed(
                  buffer.slice().order(ByteOrder.nativeOrder()),
                  fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE),
                  fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT),
                  if (fmt.containsKey(MediaFormat.KEY_PCM_ENCODING)) fmt.getInteger(MediaFormat.KEY_PCM_ENCODING)
                  else AudioFormat.ENCODING_PCM_16BIT,
                  info.presentationTimeUs, startUs, endUs,
                )
              }
              decoder.releaseOutputBuffer(outIndex, false)
              if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) outputDone = true
            }
            outIndex == MediaCodec.INFO_TRY_AGAIN_LATER && inputDone && resampler.pastEnd -> outputDone = true
          }
        }
      } catch (e: MediaLoadException) {
        throw e
      } catch (e: Exception) {
        throw MediaLoadException("$uri (${e.message})")
      } finally {
        try {
          codec?.stop()
        } catch (_: Exception) {
        }
        codec?.release()
        extractor.release()
      }
    }
    return Uri.fromFile(output).toString()
  }

  /**
   * Mono downmix + box-filter resampling: each output sample is the average
   * of the input samples that fall into its period.
   */
  private class Resampler(private val outRate: Int, private val out: BufferedOutputStream) {
    private var sum = 0.0
    private var count = 0
    private var inCount = 0L
    private var nextBoundary = -1.0
    private var ratio = 1.0
    private var last = 0f
    private val bytes = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN)
    var pastEnd = false
      private set

    fun feed(
      pcm: ByteBuffer,
      inRate: Int,
      channels: Int,
      encoding: Int,
      ptsUs: Long,
      startUs: Long,
      endUs: Long,
    ) {
      if (nextBoundary < 0) {
        ratio = inRate.toDouble() / outRate
        nextBoundary = ratio
      }
      val float = encoding == AudioFormat.ENCODING_PCM_FLOAT
      val bytesPerSample = if (float) 4 else 2
      val frames = pcm.remaining() / (bytesPerSample * channels)
      for (f in 0 until frames) {
        var mono = 0f
        for (c in 0 until channels) {
          mono += if (float) pcm.float else pcm.short / 32768f
        }
        mono /= channels
        val tUs = ptsUs + f * 1_000_000L / inRate
        if (tUs < startUs) continue
        if (tUs >= endUs) {
          pastEnd = true
          return
        }
        sum += mono
        count++
        inCount++
        while (inCount >= nextBoundary) {
          // Upsampling (input slower than output) repeats the last value.
          if (count > 0) last = (sum / count).toFloat()
          write(last)
          sum = 0.0
          count = 0
          nextBoundary += ratio
        }
      }
    }

    private fun write(v: Float) {
      bytes.clear()
      bytes.putFloat(v)
      out.write(bytes.array(), 0, 4)
    }
  }
}
