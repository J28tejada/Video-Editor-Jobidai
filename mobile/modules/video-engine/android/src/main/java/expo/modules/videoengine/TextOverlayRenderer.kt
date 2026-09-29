package expo.modules.videoengine

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.BitmapOverlay
import kotlin.math.ceil
import kotlin.math.min

/** Draws text boxes with the same padding/box rules as the web compositor. */
object TextPainter {
  fun draw(canvas: Canvas, text: EngineText, width: Int, height: Int, activeWord: Int = -1) {
    val fontPx = (text.fontSizeNorm * height).toFloat().coerceAtLeast(1f)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = parseColor(text.color)
      textSize = fontPx
      typeface = typefaceFor(text.fontWeight)
    }
    val words = text.words.orEmpty()
    val display = if (words.isEmpty()) text.text else words.joinToString(" ") { it.text }
    val textWidth = paint.measureText(display)
    if (textWidth <= 0f) return
    val padX = fontPx * 0.35f
    val padY = fontPx * 0.25f
    val cx = (text.xNorm * width).toFloat()
    val cy = (text.yNorm * height).toFloat()
    val boxW = ceil(textWidth + padX * 2)
    val boxH = ceil(fontPx + padY * 2)
    val left = when (text.align) {
      "left" -> cx - padX
      "right" -> cx + padX - boxW
      else -> cx - boxW / 2
    }
    val top = cy - boxH / 2

    if (text.background != null) {
      val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = parseColor(text.background) }
      val r = min(fontPx * 0.2f, 16f)
      canvas.drawRoundRect(RectF(left, top, left + boxW, top + boxH), r, r, bg)
    } else {
      paint.setShadowLayer(fontPx * 0.12f, 0f, fontPx * 0.04f, Color.argb(153, 0, 0, 0))
    }
    // Vertically center the glyphs in the box.
    val fm = paint.fontMetrics
    val baseline = cy - (fm.ascent + fm.descent) / 2
    if (words.isEmpty() || activeWord < 0) {
      canvas.drawText(display, left + padX, baseline, paint)
      return
    }
    // Karaoke: draw word by word, the spoken one in the highlight color.
    val space = paint.measureText(" ")
    val base = paint.color
    val highlight = parseColor(text.highlightColor ?: "#ffe600")
    var x = left + padX
    words.forEachIndexed { i, w ->
      paint.color = if (i == activeWord) highlight else base
      canvas.drawText(w.text, x, baseline, paint)
      x += paint.measureText(w.text) + space
    }
  }

  private fun typefaceFor(weight: Double): Typeface =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      Typeface.create(Typeface.DEFAULT, weight.toInt().coerceIn(100, 900), false)
    } else {
      Typeface.create(Typeface.DEFAULT, if (weight >= 600) Typeface.BOLD else Typeface.NORMAL)
    }
}

/**
 * Full-frame overlay drawing every text active at the frame's time. Applied
 * as a composition-level effect, so frame times are composition-timeline
 * times and the text sits above clips and transitions. Bitmaps are cached per
 * set of active texts, so they are rasterized only when one appears or
 * disappears.
 */
@UnstableApi
class TimedTextOverlay(
  private val texts: List<EngineText>,
  private val width: Int,
  private val height: Int,
) : BitmapOverlay() {
  private var cachedKey: String? = null
  private val bitmap: Bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
  private val canvas = Canvas(bitmap)

  override fun getBitmap(presentationTimeUs: Long): Bitmap {
    val t = presentationTimeUs / 1e6
    val active = texts.filter { t >= it.start && t < it.end }
    val words = active.map { text -> text.words?.indexOfLast { t >= it.start } ?: -1 }
    val key = active.indices.joinToString("|") { "${active[it].id}:${words[it]}" }
    if (key != cachedKey) {
      cachedKey = key
      bitmap.eraseColor(Color.TRANSPARENT)
      active.forEachIndexed { i, text -> TextPainter.draw(canvas, text, width, height, words[i]) }
    }
    return bitmap
  }
}
