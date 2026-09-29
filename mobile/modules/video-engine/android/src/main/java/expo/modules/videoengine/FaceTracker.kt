package expo.modules.videoengine

import android.content.Context
import android.graphics.Bitmap
import android.graphics.PointF
import android.media.FaceDetector
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build

/**
 * Where the main face is at given source times (center, 0..1 top-left), for
 * auto-reframing, using the platform face detector (no extra dependencies).
 * Frames without a face are skipped. Blocking — call off the main thread.
 */
object FaceTracker {
  private const val WIDTH = 320 // even width, as FaceDetector requires

  fun detect(context: Context, uri: String, times: List<Double>): List<Map<String, Double>> {
    val retriever = MediaMetadataRetriever()
    val out = mutableListOf<Map<String, Double>>()
    try {
      retriever.setDataSource(context, Uri.parse(uri))
      val faces = arrayOfNulls<FaceDetector.Face>(4)
      val mid = PointF()
      for (t in times) {
        val frame = frameAt(retriever, (t * 1_000_000).toLong()) ?: continue
        val h = (frame.height * WIDTH / frame.width).coerceAtLeast(2)
        val scaled = Bitmap.createScaledBitmap(frame, WIDTH, h, true)
        val rgb565 = scaled.copy(Bitmap.Config.RGB_565, false)
        if (scaled !== frame) scaled.recycle()
        frame.recycle()
        val found = FaceDetector(WIDTH, h, faces.size).findFaces(rgb565, faces)
        val best = faces.take(found).filterNotNull().maxByOrNull { it.eyesDistance() }
        if (best != null) {
          best.getMidPoint(mid)
          out += mapOf("t" to t, "x" to (mid.x / WIDTH).toDouble(), "y" to (mid.y / h).toDouble())
        }
        rgb565.recycle()
      }
    } catch (e: Exception) {
      throw MediaLoadException("$uri (${e.message})")
    } finally {
      retriever.release()
    }
    return out
  }

  private fun frameAt(r: MediaMetadataRetriever, timeUs: Long): Bitmap? {
    val option = MediaMetadataRetriever.OPTION_CLOSEST_SYNC
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      r.getScaledFrameAtTime(timeUs, option, 640, 640)
    } else {
      r.getFrameAtTime(timeUs, option)
    }
  }
}
