import { NativeModule, requireNativeModule } from 'expo';

import type { ExportResult, MediaInfo, VideoEngineModuleEvents } from './VideoEngine.types';

declare class VideoEngineModule extends NativeModule<VideoEngineModuleEvents> {
  /** Probe a video file: duration, display size, fps, audio presence. */
  getMediaInfoAsync(uri: string): Promise<MediaInfo>;
  /**
   * Decode frames at the given source times and write them as JPEGs to the
   * cache directory. Returns one file:// URI per time ('' when a frame could
   * not be decoded).
   */
  generateThumbnailsAsync(uri: string, times: number[], maxSize: number): Promise<string[]>;
  /**
   * Decode [startSec, endSec] of a file's audio to raw mono float32 PCM
   * (little-endian) at `sampleRate` in the cache dir; returns its file:// URI.
   * Files without audio yield an empty file.
   */
  extractAudioAsync(uri: string, startSec: number, endSec: number, sampleRate: number): Promise<string>;
  /** Render and encode the composition (JSON) to an MP4 in the cache dir. */
  exportAsync(composition: string, shortSide: number): Promise<ExportResult>;
  /** Cancel an in-flight export; the export promise rejects. */
  cancelExportAsync(): Promise<void>;
}

export default requireNativeModule<VideoEngineModule>('VideoEngine');
