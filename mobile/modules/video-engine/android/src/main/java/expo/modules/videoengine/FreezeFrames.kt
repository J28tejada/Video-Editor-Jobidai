package expo.modules.videoengine

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.media.MediaMetadataRetriever
import android.net.Uri
import java.io.File
import java.io.FileOutputStream

/**
 * Still frames used when a transition needs video past the end (or before the
 * start) of a clip's source: the first/last frame is held, as in the web
 * editor. Frames are written once as PNG to the cache and reused.
 * Blocking — call off the main thread.
 */
class FreezeFrames(private val context: Context) {
  private val durations = mutableMapOf<String, Double>()

  /** Source duration in seconds (cached per URI). */
  fun durationOf(uri: String): Double = durations.getOrPut(uri) {
    withRetriever(uri) { r ->
      (r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L) / 1000.0
    } ?: 0.0
  }

  /** file:// URI of the frame at `timeSec`, upright, or null if undecodable. */
  fun frameAt(uri: String, timeSec: Double): String? {
    val dir = File(context.cacheDir, "freeze").apply { mkdirs() }
    val key = Integer.toUnsignedString(uri.hashCode(), 36)
    val file = File(dir, "$key-${(timeSec * 1000).toLong()}.png")
    if (file.exists()) return Uri.fromFile(file).toString()
    val bitmap = withRetriever(uri) { r ->
      val frame = r.getFrameAtTime((timeSec * 1_000_000).toLong(), MediaMetadataRetriever.OPTION_CLOSEST)
        ?: return@withRetriever null
      upright(frame, r)
    } ?: return null
    FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    bitmap.recycle()
    return Uri.fromFile(file).toString()
  }

  /**
   * Some devices return frames in stored (unrotated) orientation. If the
   * frame's aspect doesn't match the display orientation, apply the rotation.
   */
  private fun upright(frame: Bitmap, r: MediaMetadataRetriever): Bitmap {
    val rotation = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
    if (rotation != 90 && rotation != 270) return frame
    val w = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: return frame
    val h = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: return frame
    val alreadyRotated = (frame.width > frame.height) == (h > w)
    if (alreadyRotated || w == h) return frame
    val rotated = Bitmap.createBitmap(
      frame, 0, 0, frame.width, frame.height, Matrix().apply { postRotate(rotation.toFloat()) }, true,
    )
    frame.recycle()
    return rotated
  }

  private fun <T> withRetriever(uri: String, block: (MediaMetadataRetriever) -> T?): T? {
    val r = MediaMetadataRetriever()
    return try {
      r.setDataSource(context, Uri.parse(uri))
      block(r)
    } catch (_: Exception) {
      null
    } finally {
      r.release()
    }
  }
}
