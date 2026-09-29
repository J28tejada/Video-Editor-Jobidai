package expo.modules.videoengine

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Frame-difference scores for shot detection: tiny frames sampled every
 * `interval` seconds are compared by color histogram and by luma, giving a
 * 0..1 "how different from the previous sample" score per sample. The JS
 * side turns the scores into shot boundaries. Blocking — call off the main
 * thread.
 */
object ShotAnalyzer {
  private const val W = 32
  private const val H = 18

  private class Signature(val histogram: DoubleArray, val luma: DoubleArray)

  fun measure(context: Context, uri: String, interval: Double, maxSamples: Int): Map<String, Any> {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(context, Uri.parse(uri))
      val duration = (retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        ?: 0L) / 1000.0
      val times = mutableListOf<Double>()
      val scores = mutableListOf<Double>()
      if (duration <= 0) return mapOf("times" to times, "scores" to scores, "duration" to 0.0)
      val step = max(interval, duration / max(1, maxSamples))
      var previous: Signature? = null
      var t = 0.0
      while (t < duration) {
        frame(retriever, (t * 1_000_000).toLong())?.let { bitmap ->
          val sig = signature(bitmap)
          bitmap.recycle()
          times += t
          scores += previous?.let { difference(it, sig) } ?: 0.0
          previous = sig
        }
        t += step
      }
      return mapOf("times" to times, "scores" to scores, "duration" to duration)
    } catch (e: Exception) {
      throw MediaLoadException("$uri (${e.message})")
    } finally {
      retriever.release()
    }
  }

  private fun frame(r: MediaMetadataRetriever, timeUs: Long): Bitmap? {
    val option = MediaMetadataRetriever.OPTION_CLOSEST
    val raw = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      r.getScaledFrameAtTime(timeUs, option, 96, 96)
    } else {
      r.getFrameAtTime(timeUs, option)
    } ?: return null
    val small = Bitmap.createScaledBitmap(raw, W, H, true)
    if (small !== raw) raw.recycle()
    return small
  }

  private fun signature(bitmap: Bitmap): Signature {
    val pixels = IntArray(W * H)
    bitmap.getPixels(pixels, 0, W, 0, 0, W, H)
    val histogram = DoubleArray(24)
    val luma = DoubleArray(W * H)
    for (i in pixels.indices) {
      val p = pixels[i]
      val r = (p shr 16) and 0xff
      val g = (p shr 8) and 0xff
      val b = p and 0xff
      histogram[r / 32] += 1.0
      histogram[8 + g / 32] += 1.0
      histogram[16 + b / 32] += 1.0
      luma[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    }
    val n = (W * H).toDouble()
    for (i in histogram.indices) histogram[i] /= n
    return Signature(histogram, luma)
  }

  /** 0 = identical, ~1 = completely different. */
  private fun difference(a: Signature, b: Signature): Double {
    var hist = 0.0
    for (i in a.histogram.indices) hist += abs(a.histogram[i] - b.histogram[i])
    hist /= 6 // three channels, each L1 distance in 0..2
    var pix = 0.0
    for (i in a.luma.indices) pix += abs(a.luma[i] - b.luma[i])
    pix /= a.luma.size
    return min(1.0, max(hist, pix * 2.5))
  }
}
