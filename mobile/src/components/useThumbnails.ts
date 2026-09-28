import { useEffect, useState } from 'react';

import VideoEngine from '../../modules/video-engine';

const cache = new Map<string, string>();
const THUMB_SIZE = 160;

/** Quantize so trims and splits reuse already-decoded frames. */
const quantize = (t: number) => Math.round(t * 2) / 2;

/**
 * Frames for a clip strip: one thumbnail per `slotWidth` px across the clip,
 * sampled evenly over its source range. Decoded natively and cached on disk.
 */
export function useThumbnails(
  uri: string | null,
  inPoint: number,
  outPoint: number,
  widthPx: number,
  slotWidth: number,
): (string | null)[] {
  const count = Math.max(1, Math.ceil(widthPx / slotWidth));
  const times = Array.from({ length: count }, (_, i) =>
    quantize(inPoint + ((i + 0.5) / count) * (outPoint - inPoint)),
  );
  const key = `${uri}|${times.join(',')}`;
  const [urls, setUrls] = useState<(string | null)[]>(() =>
    times.map((t) => cache.get(`${uri}|${t}`) ?? null),
  );

  useEffect(() => {
    if (!uri) return;
    let cancelled = false;
    const missing = times.filter((t) => !cache.has(`${uri}|${t}`));
    const fill = () => setUrls(times.map((t) => cache.get(`${uri}|${t}`) ?? null));
    fill();
    if (missing.length === 0) return;
    VideoEngine.generateThumbnailsAsync(uri, missing, THUMB_SIZE)
      .then((result) => {
        result.forEach((u, i) => u && cache.set(`${uri}|${missing[i]}`, u));
        if (!cancelled) fill();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // `key` captures uri + times.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return urls;
}
