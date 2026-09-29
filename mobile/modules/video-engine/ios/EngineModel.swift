import UIKit

// Mirror of the TypeScript `EngineComposition` contract (src/VideoEngine.types.ts).

struct EngineClip: Decodable {
  let id: String
  let uri: String
  let inPoint: Double
  let outPoint: Double
  let start: Double
  let speed: Double
  let volume: Double
  let fit: String
  /// 3×4 row-major affine color matrix on sRGB, or nil.
  let colorMatrix: [Double]?
  /// Zoom / reframe after fitting, or nil.
  let transform: EngineTransform?
  /// Animated zoom / reframe keyed by source seconds, or nil.
  let transformKeys: [EngineTransformKey]?
  let srcWidth: Double?
  let srcHeight: Double?
}

struct EngineTransformKey: Decodable {
  let t: Double
  let scale: Double
  let xNorm: Double
  let yNorm: Double
}

struct EngineWord: Decodable {
  let text: String
  let start: Double
  let end: Double
}

struct EngineTransform: Decodable {
  let scale: Double
  let xNorm: Double
  let yNorm: Double
}

/// Transition across the cut after clips[index], centered on the cut.
struct EngineTransition: Decodable {
  let index: Int
  let kind: String
  let half: Double
}

struct EngineText: Decodable {
  let id: String
  let text: String
  let start: Double
  let end: Double
  let xNorm: Double
  let yNorm: Double
  let fontSizeNorm: Double
  let color: String
  let fontWeight: Double
  let background: String?
  let align: String
  /// Karaoke word timings (timeline seconds) and highlight color.
  let words: [EngineWord]?
  let highlightColor: String?
}

struct GainPoint: Decodable {
  let t: Double
  let gain: Double
}

struct EngineAudio: Decodable {
  let id: String
  let uri: String
  let start: Double
  let end: Double
  let inPoint: Double
  let outPoint: Double
  let loop: Bool
  let envelope: [GainPoint]
}

struct EngineComposition: Decodable {
  let width: Double
  let height: Double
  let fps: Double
  let clips: [EngineClip]
  let texts: [EngineText]
  let audio: [EngineAudio]
  let transitions: [EngineTransition]

  enum CodingKeys: String, CodingKey { case width, height, fps, clips, texts, audio, transitions }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    width = try c.decode(Double.self, forKey: .width)
    height = try c.decode(Double.self, forKey: .height)
    fps = try c.decode(Double.self, forKey: .fps)
    clips = try c.decode([EngineClip].self, forKey: .clips)
    texts = try c.decodeIfPresent([EngineText].self, forKey: .texts) ?? []
    audio = try c.decodeIfPresent([EngineAudio].self, forKey: .audio) ?? []
    transitions = try c.decodeIfPresent([EngineTransition].self, forKey: .transitions) ?? []
  }

  static func decode(_ json: String) throws -> EngineComposition {
    guard let data = json.data(using: .utf8) else {
      throw InvalidCompositionException("not UTF-8")
    }
    do {
      return try JSONDecoder().decode(EngineComposition.self, from: data)
    } catch {
      throw InvalidCompositionException(error.localizedDescription)
    }
  }
}

/// Parses the CSS-style colors the editor uses: #rgb, #rrggbb, #rrggbbaa,
/// rgb(r,g,b) and rgba(r,g,b,a). Falls back to white.
func parseColor(_ value: String?) -> UIColor {
  guard var s = value?.trimmingCharacters(in: .whitespaces).lowercased(), !s.isEmpty else {
    return .white
  }
  if s.hasPrefix("#") {
    s.removeFirst()
    if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
    guard let n = UInt64(s, radix: 16) else { return .white }
    if s.count == 8 {
      return UIColor(
        red: CGFloat((n >> 24) & 0xff) / 255, green: CGFloat((n >> 16) & 0xff) / 255,
        blue: CGFloat((n >> 8) & 0xff) / 255, alpha: CGFloat(n & 0xff) / 255)
    }
    return UIColor(
      red: CGFloat((n >> 16) & 0xff) / 255, green: CGFloat((n >> 8) & 0xff) / 255,
      blue: CGFloat(n & 0xff) / 255, alpha: 1)
  }
  if s.hasPrefix("rgb") {
    let inner = s.drop { $0 != "(" }.dropFirst().prefix { $0 != ")" }
    let parts = inner.split(separator: ",").compactMap {
      Double($0.trimmingCharacters(in: .whitespaces))
    }
    if parts.count >= 3 {
      return UIColor(
        red: parts[0] / 255, green: parts[1] / 255, blue: parts[2] / 255,
        alpha: parts.count >= 4 ? parts[3] : 1)
    }
  }
  return .white
}
