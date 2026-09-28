package expo.modules.videoengine

import android.graphics.Color
import org.json.JSONObject

// Mirror of the TypeScript `EngineComposition` contract (src/VideoEngine.types.ts).

data class EngineClip(
  val id: String,
  val uri: String,
  val inPoint: Double,
  val outPoint: Double,
  val start: Double,
  val speed: Double,
  val volume: Double,
  val fit: String,
) {
  /** Timeline duration of the clip (source range compressed by speed). */
  val duration: Double get() = (outPoint - inPoint) / speed
  val end: Double get() = start + duration
}

data class EngineText(
  val id: String,
  val text: String,
  val start: Double,
  val end: Double,
  val xNorm: Double,
  val yNorm: Double,
  val fontSizeNorm: Double,
  val color: String,
  val fontWeight: Double,
  val background: String?,
  val align: String,
)

data class EngineComposition(
  val width: Int,
  val height: Int,
  val fps: Double,
  val clips: List<EngineClip>,
  val texts: List<EngineText>,
) {
  val duration: Double get() = clips.lastOrNull()?.end ?: 0.0

  /** Index of the clip playing at timeline time `t` (clamped to the ends). */
  fun clipIndexAt(t: Double): Int {
    if (clips.isEmpty()) return -1
    for (i in clips.indices) if (t < clips[i].end) return i
    return clips.lastIndex
  }

  companion object {
    fun parse(json: String): EngineComposition {
      val o = try {
        JSONObject(json)
      } catch (e: Exception) {
        throw InvalidCompositionException(e.message ?: "bad JSON")
      }
      val clips = o.getJSONArray("clips").let { arr ->
        (0 until arr.length()).map { i ->
          val c = arr.getJSONObject(i)
          val speed = c.optDouble("speed", 1.0).let { if (it > 0) it else 1.0 }
          EngineClip(
            id = c.getString("id"),
            uri = c.getString("uri"),
            inPoint = c.getDouble("inPoint"),
            outPoint = c.getDouble("outPoint"),
            start = c.getDouble("start"),
            speed = speed,
            volume = c.optDouble("volume", 1.0),
            fit = c.optString("fit", "contain"),
          )
        }
      }
      val texts = o.optJSONArray("texts")?.let { arr ->
        (0 until arr.length()).map { i ->
          val t = arr.getJSONObject(i)
          EngineText(
            id = t.getString("id"),
            text = t.getString("text"),
            start = t.getDouble("start"),
            end = t.getDouble("end"),
            xNorm = t.getDouble("xNorm"),
            yNorm = t.getDouble("yNorm"),
            fontSizeNorm = t.getDouble("fontSizeNorm"),
            color = t.optString("color", "#ffffff"),
            fontWeight = t.optDouble("fontWeight", 700.0),
            background = if (t.isNull("background")) null else t.optString("background"),
            align = t.optString("align", "center"),
          )
        }
      } ?: emptyList()
      return EngineComposition(
        width = o.getInt("width"),
        height = o.getInt("height"),
        fps = o.optDouble("fps", 30.0),
        clips = clips,
        texts = texts,
      )
    }
  }
}

/** Output size, optionally scaled so the short side equals `shortSide`; always even. */
fun renderSize(spec: EngineComposition, shortSide: Double = 0.0): Pair<Int, Int> {
  var w = spec.width.coerceAtLeast(2).toDouble()
  var h = spec.height.coerceAtLeast(2).toDouble()
  if (shortSide > 0) {
    val scale = shortSide / minOf(w, h)
    w *= scale
    h *= scale
  }
  fun even(v: Double) = (Math.round(v / 2) * 2).toInt().coerceAtLeast(2)
  return even(w) to even(h)
}

/**
 * Parses the CSS-style colors the editor uses: #rgb, #rrggbb, #rrggbbaa,
 * rgb(r,g,b) and rgba(r,g,b,a). Falls back to white.
 */
fun parseColor(value: String?): Int {
  val s = value?.trim()?.lowercase().orEmpty()
  if (s.isEmpty()) return Color.WHITE
  try {
    if (s.startsWith("#")) {
      var hex = s.substring(1)
      if (hex.length == 3) hex = hex.map { "$it$it" }.joinToString("")
      val n = hex.toLong(16)
      return if (hex.length == 8) {
        Color.argb(
          (n and 0xff).toInt(), ((n shr 24) and 0xff).toInt(),
          ((n shr 16) and 0xff).toInt(), ((n shr 8) and 0xff).toInt(),
        )
      } else {
        Color.rgb(((n shr 16) and 0xff).toInt(), ((n shr 8) and 0xff).toInt(), (n and 0xff).toInt())
      }
    }
    if (s.startsWith("rgb")) {
      val parts = s.substringAfter("(").substringBefore(")").split(",").map { it.trim().toDouble() }
      if (parts.size >= 3) {
        val a = if (parts.size >= 4) parts[3] else 1.0
        return Color.argb(
          (a * 255).toInt().coerceIn(0, 255), parts[0].toInt(), parts[1].toInt(), parts[2].toInt(),
        )
      }
    }
  } catch (_: Exception) {
  }
  return Color.WHITE
}
