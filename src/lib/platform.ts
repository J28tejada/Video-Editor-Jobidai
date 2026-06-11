/**
 * Platform & environment detection for PWA / iOS robustness.
 *
 * Note: on iOS every browser uses WebKit, so capabilities depend on the iOS
 * version, not the browser brand. We surface that in the messaging.
 */
export type PlatformInfo = {
  isIOS: boolean;
  isSafari: boolean;
  /** iOS major version if detectable, else null. */
  iosVersion: number | null;
  /** Running as an installed PWA (standalone display). */
  standalone: boolean;
  /** Page is cross-origin isolated (SharedArrayBuffer / threads available). */
  crossOriginIsolated: boolean;
};

export function detectPlatform(): PlatformInfo {
  const ua = navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as Mac; detect by touch.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua);

  let iosVersion: number | null = null;
  const m = ua.match(/OS (\d+)_/);
  if (m) iosVersion = Number(m[1]);

  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;

  return {
    isIOS,
    isSafari,
    iosVersion,
    standalone,
    crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true,
  };
}

export type StorageEstimate = { usage: number; quota: number; percent: number } | null;

export async function estimateStorage(): Promise<StorageEstimate> {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const percent = quota > 0 ? usage / quota : 0;
    return { usage, quota, percent };
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
