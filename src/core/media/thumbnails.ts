/**
 * Timeline thumbnail service: decodes small preview frames on demand and caches
 * them as JPEG data URLs. Uses a dedicated low-resolution CanvasSink per source
 * (separate from the preview sink) so thumbnails are cheap to generate.
 */
import { CanvasSink } from 'mediabunny';
import { getMedia } from './registry';

const THUMB_H = 64; // thumbnail height in px

const cache = new Map<string, string>(); // key -> data URL
const inflight = new Map<string, Promise<string | null>>();
const sinks = new Map<string, CanvasSink>(); // sourceId -> small sink

/** Quantize source time so nearby requests share a cached thumbnail. */
const keyFor = (sourceId: string, sourceTime: number, isImage: boolean): string =>
  isImage ? `${sourceId}@img` : `${sourceId}@${Math.round(sourceTime)}`;

function getSink(sourceId: string): CanvasSink | null {
  const cached = sinks.get(sourceId);
  if (cached) return cached;
  const media = getMedia(sourceId);
  if (!media?.videoTrack) return null;
  const sink = new CanvasSink(media.videoTrack, {
    height: THUMB_H,
    fit: 'cover',
    poolSize: 1,
  });
  sinks.set(sourceId, sink);
  return sink;
}

/** Synchronously return a cached thumbnail data URL, if present. */
export function getCachedThumb(sourceId: string, sourceTime: number): string | null {
  const media = getMedia(sourceId);
  if (!media) return null;
  return cache.get(keyFor(sourceId, sourceTime, !!media.image)) ?? null;
}

/** Decode (or return cached) a thumbnail for a source at a given source time. */
export async function getThumb(sourceId: string, sourceTime: number): Promise<string | null> {
  const media = getMedia(sourceId);
  if (!media) return null;
  const key = keyFor(sourceId, sourceTime, !!media.image);
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  const job = (async (): Promise<string | null> => {
    let src: CanvasImageSource | null = null;
    if (media.image) {
      src = media.image;
    } else {
      const sink = getSink(sourceId);
      if (!sink) return null;
      const t = Math.max(0, Math.min(sourceTime, media.meta.durationSec));
      const wrapped = await sink.getCanvas(t);
      src = wrapped?.canvas ?? null;
    }
    if (!src) return null;

    const aspect = media.meta.width && media.meta.height ? media.meta.width / media.meta.height : 9 / 16;
    const w = Math.max(1, Math.round(THUMB_H * aspect));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = THUMB_H;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(src, 0, 0, w, THUMB_H);
    const url = c.toDataURL('image/jpeg', 0.6);
    cache.set(key, url);
    return url;
  })().finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}

/** Drop cached thumbnails/sinks for sources no longer present. */
export function pruneThumbnails(keepSourceIds: string[]): void {
  const keep = new Set(keepSourceIds);
  for (const sid of sinks.keys()) if (!keep.has(sid)) sinks.delete(sid);
  for (const k of cache.keys()) {
    const sid = k.split('@')[0];
    if (!keep.has(sid)) cache.delete(k);
  }
}
