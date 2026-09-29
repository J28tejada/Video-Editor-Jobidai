package expo.modules.videoengine

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import androidx.media3.common.util.UnstableApi
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream

@UnstableApi
class VideoEngineModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private var exporter: Exporter? = null

  override fun definition() = ModuleDefinition {
    Name("VideoEngine")

    Events("onExportProgress")

    AsyncFunction("getMediaInfoAsync") { uri: String ->
      mediaInfo(uri)
    }

    AsyncFunction("generateThumbnailsAsync") { uri: String, times: List<Double>, maxSize: Double ->
      thumbnails(uri, times, maxSize.toInt().coerceAtLeast(16))
    }

    AsyncFunction("extractAudioAsync") { uri: String, startSec: Double, endSec: Double, sampleRate: Int ->
      AudioExtractor.extract(context, uri, startSec, endSec, sampleRate)
    }

    AsyncFunction("measureShotChangesAsync") { uri: String, interval: Double, maxSamples: Int ->
      ShotAnalyzer.measure(context, uri, interval, maxSamples)
    }

    AsyncFunction("detectFacesAsync") { uri: String, times: List<Double> ->
      FaceTracker.detect(context, uri, times)
    }

    AsyncFunction("exportAsync") { json: String, shortSide: Double, promise: Promise ->
      if (exporter?.isRunning == true) {
        promise.reject(ExportInProgressException())
        return@AsyncFunction
      }
      val spec = try {
        EngineComposition.parse(json)
      } catch (e: InvalidCompositionException) {
        promise.reject(e)
        return@AsyncFunction
      }
      if (spec.clips.isEmpty()) {
        promise.reject(InvalidCompositionException("timeline is empty"))
        return@AsyncFunction
      }
      val ex = Exporter(context)
      exporter = ex
      ex.start(
        spec, shortSide,
        onProgress = { p -> sendEvent("onExportProgress", mapOf("progress" to p)) },
        onFinished = { result ->
          if (exporter === ex) exporter = null
          result.fold(
            onSuccess = { uri -> promise.resolve(mapOf("uri" to uri)) },
            onFailure = { e ->
              promise.reject(e as? CodedException ?: ExportFailedException(e.message ?: "error", e))
            },
          )
        },
      )
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("cancelExportAsync") {
      exporter?.cancel()
    }.runOnQueue(Queues.MAIN)

    View(VideoEngineView::class) {
      Events("onReady", "onTimeUpdate", "onEnded", "onError")

      Prop("composition") { view: VideoEngineView, json: String ->
        view.setComposition(json)
      }

      AsyncFunction("play") { view: VideoEngineView -> view.play() }

      AsyncFunction("pause") { view: VideoEngineView -> view.pause() }

      AsyncFunction("seek") { view: VideoEngineView, time: Double, exact: Boolean ->
        view.seek(time, exact)
      }

      OnViewDestroys { view: VideoEngineView -> view.release() }
    }
  }

  private fun mediaInfo(uri: String): Map<String, Any?> {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(context, Uri.parse(uri))
      fun meta(key: Int) = retriever.extractMetadata(key)
      val durationMs = meta(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        ?: throw MediaLoadException("no duration for $uri")
      val hasVideo = meta(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) == "yes"
      val hasAudio = meta(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes"
      if (!hasVideo && !hasAudio) throw MediaLoadException("no audio or video in $uri")
      var width = 0
      var height = 0
      if (hasVideo) {
        width = meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
        height = meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
        val rotation = meta(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
        if (rotation == 90 || rotation == 270) width = height.also { height = width }
      }
      val (fps, codec) = trackFormat(uri, if (hasVideo) "video/" else "audio/")
      return mapOf(
        "durationSec" to durationMs / 1000.0,
        "hasVideo" to hasVideo,
        "width" to width,
        "height" to height,
        "fps" to if (hasVideo) fps else null,
        "hasAudio" to hasAudio,
        "codec" to codec,
      )
    } catch (e: MediaLoadException) {
      throw e
    } catch (e: Exception) {
      throw MediaLoadException("$uri (${e.message})")
    } finally {
      retriever.release()
    }
  }

  /** Frame rate and MIME of the first track of a kind ("video/" / "audio/"). */
  private fun trackFormat(uri: String, prefix: String): Pair<Double?, String?> {
    val extractor = MediaExtractor()
    return try {
      extractor.setDataSource(context, Uri.parse(uri), null)
      for (i in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(i)
        val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
        if (!mime.startsWith(prefix)) continue
        val fps = if (format.containsKey(MediaFormat.KEY_FRAME_RATE)) {
          try {
            format.getInteger(MediaFormat.KEY_FRAME_RATE).toDouble()
          } catch (_: ClassCastException) {
            format.getFloat(MediaFormat.KEY_FRAME_RATE).toDouble()
          }
        } else null
        return fps to mime
      }
      null to null
    } catch (_: Exception) {
      null to null
    } finally {
      extractor.release()
    }
  }

  private fun thumbnails(uri: String, times: List<Double>, maxSize: Int): List<String> {
    val dir = File(context.cacheDir, "thumbs").apply { mkdirs() }
    val key = Integer.toUnsignedString(uri.hashCode(), 36)
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(context, Uri.parse(uri))
      return times.map { t ->
        val file = File(dir, "$key-${(t * 1000).toLong()}-$maxSize.jpg")
        if (file.exists()) return@map Uri.fromFile(file).toString()
        val frame = frameAt(retriever, (t * 1_000_000).toLong(), maxSize) ?: return@map ""
        FileOutputStream(file).use { frame.compress(Bitmap.CompressFormat.JPEG, 70, it) }
        frame.recycle()
        Uri.fromFile(file).toString()
      }
    } catch (e: Exception) {
      throw MediaLoadException("$uri (${e.message})")
    } finally {
      retriever.release()
    }
  }

  private fun frameAt(retriever: MediaMetadataRetriever, timeUs: Long, maxSize: Int): Bitmap? {
    val option = MediaMetadataRetriever.OPTION_CLOSEST_SYNC
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      return retriever.getScaledFrameAtTime(timeUs, option, maxSize, maxSize)
    }
    val full = retriever.getFrameAtTime(timeUs, option) ?: return null
    val scale = maxSize.toFloat() / maxOf(full.width, full.height)
    if (scale >= 1f) return full
    val scaled = Bitmap.createScaledBitmap(
      full, (full.width * scale).toInt().coerceAtLeast(1), (full.height * scale).toInt().coerceAtLeast(1), true,
    )
    full.recycle()
    return scaled
  }
}
