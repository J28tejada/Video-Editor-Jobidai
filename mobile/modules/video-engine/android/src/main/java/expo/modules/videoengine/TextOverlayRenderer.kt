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
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.min

/** Draws text boxes with the same padding/box rules as the web compositor. */
object TextPainter {
  fun draw(canvas: Canvas, text: EngineText, width: Int, height: Int) {
    val fontPx = (text.fontSizeNorm * height).toFloat().coerceAtLeast(1f)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = parseColor(text.color)
      textSize = fontPx
      typeface = typefaceFor(text.fontWeight)
    }
    val textWidth = paint.measureText(text.text)
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
    canvas.drawText(text.text, left + padX, baseline, paint)
  }

  private fun typefaceFor(weight: Double): Typeface =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      Typeface.create(Typeface.DEFAULT, weight.toInt().coerceIn(100, 900), false)
    } else {
      Typeface.create(Typeface.DEFAULT, if (weight >= 600) Typeface.BOLD else Typeface.NORMAL)
    }
}

/**
 * Full-frame overlay for Transformer: draws every text active at the frame's
 * time. Bitmaps are cached per set of active texts, so they are rasterized
 * only when a text appears or disappears.
 *
 * Media3 has changed across versions whether per-item effects see
 * composition-timeline timestamps or item-relative ones, so the time base is
 * detected from the first frame of the item (it must land on the clip start).
 */
@UnstableApi
class TimedTextOverlay(
  private val texts: List<EngineText>,
  private val width: Int,
  private val height: Int,
  private val clip: EngineClip,
) : BitmapOverlay() {
  private var toTimeline: ((Long) -> Double)? = null
  private var cachedKey: String? = null
  private val bitmap: Bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
  private val canvas = Canvas(bitmap)

  override fun getBitmap(presentationTimeUs: Long): Bitmap {
    val t = timelineTime(presentationTimeUs)
    val active = texts.filter { t >= it.start && t < it.end }
    val key = active.joinToString("|") { it.id }
    if (key != cachedKey) {
      cachedKey = key
      bitmap.eraseColor(Color.TRANSPARENT)
      for (text in active) TextPainter.draw(canvas, text, width, height)
    }
    return bitmap
  }

  private fun timelineTime(ptsUs: Long): Double {
    val mapper = toTimeline ?: run {
      val candidates = listOf<(Long) -> Double>(
        { us -> us / 1e6 }, // already on the composition timeline
        { us -> clip.start + us / 1e6 }, // relative to the item, post-speed
        { us -> clip.start + (us / 1e6 - clip.inPoint) / clip.speed }, // source time
      )
      val best = candidates.minByOrNull { abs(it(ptsUs) - clip.start) }!!
      toTimeline = best
      best
    }
    return mapper(ptsUs)
  }
}
