package expo.modules.videoengine

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.transformer.Composition
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import java.io.File
import java.util.concurrent.Executors

/**
 * Renders an EngineComposition to MP4 with Media3 Transformer, using the same
 * [CompositionFactory] composition as the preview plus burned-in text.
 * Call from the main thread; the composition is built on a worker thread.
 */
@UnstableApi
class Exporter(private val context: Context) {
  private var transformer: Transformer? = null
  private var cancelled = false
  private var onFinished: ((Result<String>) -> Unit)? = null
  private val handler = Handler(Looper.getMainLooper())

  var isRunning: Boolean = false
    private set

  fun start(
    spec: EngineComposition,
    shortSide: Double,
    onProgress: (Double) -> Unit,
    onFinished: (Result<String>) -> Unit,
  ) {
    isRunning = true
    cancelled = false
    this.onFinished = onFinished
    val (width, height) = renderSize(spec, shortSide)
    worker.execute {
      val composition = try {
        CompositionFactory.build(context, spec, width, height, includeTexts = true)
      } catch (e: Exception) {
        handler.post { finish(Result.failure(ExportFailedException(e.message ?: "build", e))) }
        return@execute
      }
      handler.post {
        if (!cancelled) encode(composition, onProgress)
      }
    }
  }

  private fun encode(composition: Composition, onProgress: (Double) -> Unit) {
    val output = File(context.cacheDir, "export-${System.currentTimeMillis()}.mp4")
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
          onProgress(1.0)
          finish(Result.success(Uri.fromFile(output).toString()))
        }

        override fun onError(
          composition: Composition,
          exportResult: ExportResult,
          exportException: ExportException,
        ) {
          handler.removeCallbacks(poll)
          output.delete()
          finish(Result.failure(ExportFailedException(exportException.message ?: "error", exportException)))
        }
      })
      .build()
    transformer = t
    t.start(composition, output.absolutePath)
    handler.post(poll)
  }

  /** Reports the result once (later callbacks after a cancel are ignored). */
  private fun finish(result: Result<String>) {
    val callback = onFinished ?: return
    onFinished = null
    transformer = null
    isRunning = false
    callback(result)
  }

  /** Cancels the running export; it reports [ExportCancelledException]. */
  fun cancel() {
    if (!isRunning) return
    cancelled = true
    transformer?.cancel()
    finish(Result.failure(ExportCancelledException()))
  }

  companion object {
    private val worker = Executors.newSingleThreadExecutor()
  }
}
