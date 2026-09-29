import type { ClipFilters } from './types';

/** Named color looks shared by the web and mobile editors. */
export const FILTER_PRESETS: [string, ClipFilters][] = [
  ['Ninguno', {}],
  ['Vívido', { contrast: 1.15, saturate: 1.3 }],
  ['Cálido', { sepia: 0.25, saturate: 1.1, brightness: 1.05 }],
  ['Frío', { hueRotate: -12, saturate: 1.05, brightness: 1.02 }],
  ['B/N', { grayscale: 1, contrast: 1.1 }],
  ['Cine', { contrast: 1.2, saturate: 0.85, sepia: 0.1 }],
];
