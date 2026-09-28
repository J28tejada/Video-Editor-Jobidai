/**
 * Imported media lives in the app's documents directory as
 * `media/<sourceId>.<ext>`. Only the file name is persisted: on iOS the app
 * container path changes between installs/updates, so absolute URIs would go
 * stale.
 */
import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import { uid } from '@timeline/project';
import type { SourceMeta } from '@timeline/types';
import VideoEngine from '../../modules/video-engine';

const mediaDir = () => new Directory(Paths.document, 'media');

export type MediaFiles = Record<string, string>; // sourceId → file name

export function mediaUri(fileName: string): string {
  return new File(mediaDir(), fileName).uri;
}

export type ImportedMedia = { meta: SourceMeta; fileName: string };

/** Pick videos from the gallery and copy them into the app's storage. */
export async function pickAndImportVideos(): Promise<ImportedMedia[]> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Necesitamos acceso a tu galería para importar videos.');
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    allowsMultipleSelection: true,
    // Keep the original file (no re-encode) — the engine handles HEVC/H.264.
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
  });
  if (result.canceled) return [];

  const dir = mediaDir();
  if (!dir.exists) dir.create({ intermediates: true });

  const imported: ImportedMedia[] = [];
  for (const asset of result.assets) {
    const id = uid('src');
    const ext = extensionOf(asset.fileName ?? asset.uri) ?? 'mp4';
    const fileName = `${id}.${ext}`;
    const dest = new File(dir, fileName);
    await new File(asset.uri).copy(dest);

    const info = await VideoEngine.getMediaInfoAsync(dest.uri);
    imported.push({
      fileName,
      meta: {
        id,
        name: asset.fileName ?? fileName,
        durationSec: info.durationSec,
        width: info.width,
        height: info.height,
        fps: info.fps ?? null,
        codec: info.codec ?? null,
        kind: 'video',
      },
    });
  }
  return imported;
}

/** Delete media files no longer referenced by the project. */
export function pruneMedia(keep: MediaFiles): void {
  const dir = mediaDir();
  if (!dir.exists) return;
  const wanted = new Set(Object.values(keep));
  for (const entry of dir.list()) {
    if (entry instanceof File && !wanted.has(entry.name)) {
      try {
        entry.delete();
      } catch {
        /* best effort */
      }
    }
  }
}

function extensionOf(name: string): string | null {
  const m = /\.([a-z0-9]{2,5})(?:\?.*)?$/i.exec(name);
  return m ? m[1].toLowerCase() : null;
}
