/**
 * Capability detection for WebCodecs + codec support.
 *
 * Decision (doc §3): base codec is H.264 (AVC) for maximum compatibility.
 * VP9/AV1 only with explicit support detection. We probe encode capability
 * because some devices (old phones) cannot encode above Full HD and the
 * encoder does not warn — we validate before committing to a resolution.
 */
import {
  canEncodeVideo,
  getFirstEncodableVideoCodec,
  type VideoCodec,
} from 'mediabunny';
import { detectPlatform } from './platform';

export type Capabilities = {
  webcodecs: boolean;
  videoDecoder: boolean;
  videoEncoder: boolean;
  /** First codec we can actually encode at the target resolution, or null. */
  encodableCodec: VideoCodec | null;
  /** Human-readable reason when the editor cannot run fully. */
  blockingReason: string | null;
};

const PREFERRED_CODECS: VideoCodec[] = ['avc', 'vp9', 'av1'];

export async function detectCapabilities(
  targetWidth = 1920,
  targetHeight = 1080,
): Promise<Capabilities> {
  const hasVideoDecoder = typeof globalThis.VideoDecoder !== 'undefined';
  const hasVideoEncoder = typeof globalThis.VideoEncoder !== 'undefined';
  const webcodecs = hasVideoDecoder && hasVideoEncoder;

  let encodableCodec: VideoCodec | null = null;
  if (hasVideoEncoder) {
    try {
      encodableCodec = await getFirstEncodableVideoCodec(PREFERRED_CODECS, {
        width: targetWidth,
        height: targetHeight,
      });
    } catch {
      encodableCodec = null;
    }
  }

  const platform = detectPlatform();
  let blockingReason: string | null = null;
  if (!webcodecs) {
    if (platform.isIOS) {
      const v = platform.iosVersion ? ` (tienes iOS ${platform.iosVersion})` : '';
      blockingReason =
        `Tu versión de iOS no soporta WebCodecs${v}. Necesitas iOS con Safari 26 o superior. ` +
        'En iPhone todos los navegadores usan el motor de Safari, así que cambiar de navegador no ayuda — ' +
        'actualiza iOS desde Ajustes.';
    } else {
      blockingReason =
        'Este navegador no soporta WebCodecs. Usa Chrome/Edge actuales o Safari 26+.';
    }
  } else if (!encodableCodec) {
    blockingReason =
      `No se encontró un codec de video codificable a ${targetWidth}x${targetHeight}. ` +
      'El dispositivo puede tener un límite de resolución del encoder.';
  }

  return {
    webcodecs,
    videoDecoder: hasVideoDecoder,
    videoEncoder: hasVideoEncoder,
    encodableCodec,
    blockingReason,
  };
}

/** Quick check that a specific codec encodes at a given resolution. */
export async function canEncodeAt(
  codec: VideoCodec,
  width: number,
  height: number,
): Promise<boolean> {
  try {
    return await canEncodeVideo(codec, { width, height });
  } catch {
    return false;
  }
}
