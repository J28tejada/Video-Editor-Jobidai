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
  /** Render and encode the composition (JSON) to an MP4 in the cache dir. */
  exportAsync(composition: string, shortSide: number): Promise<ExportResult>;
  /** Cancel an in-flight export; the export promise rejects. */
  cancelExportAsync(): Promise<void>;
}

export default requireNativeModule<VideoEngineModule>('VideoEngine');
