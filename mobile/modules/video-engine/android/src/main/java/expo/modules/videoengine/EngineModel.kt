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
  /** 3×4 row-major affine color matrix on RGB, or null. */
  val colorMatrix: DoubleArray?,
  /** Zoom / reframe after fitting, or null. */
  val transform: EngineTransform?,
  /** Animated zoom / reframe keyed by source seconds, or null. */
  val transformKeys: List<TransformKey>?,
  val srcWidth: Double,
  val srcHeight: Double,
) {
  /** Timeline duration of the clip (source range compressed by speed). */
  val duration: Double get() = (outPoint - inPoint) / speed
  val end: Double get() = start + duration
}

data class EngineTransform(val scale: Double, val xNorm: Double, val yNorm: Double)

data class TransformKey(val t: Double, val scale: Double, val xNorm: Double, val yNorm: Double)

data class EngineWord(val text: String, val start: Double, val end: Double)

/** Transition across the cut after clips[index], centered on the cut. */
data class EngineTransition(val index: Int, val kind: String, val half: Double)

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
  val words: List<EngineWord>? = null,
  val highlightColor: String? = null,
)

data class GainPoint(val t: Double, val gain: Double)

/** Music or sound-effect layer; fades/ducking/volume are baked into `envelope`. */
data class EngineAudio(
  val id: String,
  val uri: String,
  val start: Double,
  val end: Double,
  val inPoint: Double,
  val outPoint: Double,
  val loop: Boolean,
  val envelope: List<GainPoint>,
) {
  /** Linear interpolation over the sorted points; holds the ends. */
  fun gainAt(t: Double): Double {
    if (envelope.isEmpty()) return 1.0
    if (t <= envelope.first().t) return envelope.first().gain
    for (i in 1 until envelope.size) {
      val a = envelope[i - 1]
      val b = envelope[i]
      if (t <= b.t) {
        val span = b.t - a.t
        return if (span <= 0) b.gain else a.gain + (b.gain - a.gain) * (t - a.t) / span
      }
    }
    return envelope.last().gain
  }
}

data class EngineComposition(
  val width: Int,
  val height: Int,
  val fps: Double,
  val clips: List<EngineClip>,
  val texts: List<EngineText>,
  val audio: List<EngineAudio>,
  val transitions: List<EngineTransition>,
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
            colorMatrix = c.optJSONArray("colorMatrix")?.let { m ->
              if (m.length() == 12) DoubleArray(12) { k -> m.getDouble(k) } else null
            },
            transform = c.optJSONObject("transform")?.let { t ->
              EngineTransform(t.getDouble("scale"), t.getDouble("xNorm"), t.getDouble("yNorm"))
            },
            transformKeys = c.optJSONArray("transformKeys")?.let { arr ->
              (0 until arr.length()).map { k ->
                val o = arr.getJSONObject(k)
                TransformKey(o.getDouble("t"), o.getDouble("scale"), o.getDouble("xNorm"), o.getDouble("yNorm"))
              }
            },
            srcWidth = c.optDouble("srcWidth", 0.0),
            srcHeight = c.optDouble("srcHeight", 0.0),
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
            words = t.optJSONArray("words")?.let { arr ->
              (0 until arr.length()).map { k ->
                val w = arr.getJSONObject(k)
                EngineWord(w.getString("text"), w.getDouble("start"), w.getDouble("end"))
              }
            },
            highlightColor = if (t.isNull("highlightColor")) null else t.optString("highlightColor", "#ffe600"),
          )
        }
      } ?: emptyList()
      val audio = o.optJSONArray("audio")?.let { arr ->
        (0 until arr.length()).map { i ->
          val a = arr.getJSONObject(i)
          val env = a.getJSONArray("envelope")
          EngineAudio(
            id = a.getString("id"),
            uri = a.getString("uri"),
            start = a.getDouble("start"),
            end = a.getDouble("end"),
            inPoint = a.getDouble("inPoint"),
            outPoint = a.getDouble("outPoint"),
            loop = a.optBoolean("loop", false),
            envelope = (0 until env.length()).map { j ->
              val p = env.getJSONObject(j)
              GainPoint(p.getDouble("t"), p.getDouble("gain"))
            },
          )
        }
      } ?: emptyList()
      val transitions = o.optJSONArray("transitions")?.let { arr ->
        (0 until arr.length()).map { i ->
          val t = arr.getJSONObject(i)
          EngineTransition(t.getInt("index"), t.optString("kind", "crossfade"), t.getDouble("half"))
        }
      } ?: emptyList()
      return EngineComposition(
        width = o.getInt("width"),
        height = o.getInt("height"),
        fps = o.optDouble("fps", 30.0),
        clips = clips,
        texts = texts,
        audio = audio,
        transitions = transitions,
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
