/**
 * Imported media lives in the app's documents directory as
 * `media/<sourceId>.<ext>`. Only the file name is persisted: on iOS the app
 * container path changes between installs/updates, so absolute URIs would go
 * stale.
 */
import * as DocumentPicker from 'expo-document-picker';
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

export type ImportedMedia = { meta: SourceMeta; fileName: string; hasAudio: boolean };

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

  const imported: ImportedMedia[] = [];
  for (const asset of result.assets) {
    const media = await importFile(asset.uri, asset.fileName ?? null);
    if (media.meta.kind === 'video') imported.push(media);
  }
  return imported;
}

/** Pick an audio file (music or a sound effect) from the Files app. */
export async function pickAndImportAudio(): Promise<ImportedMedia | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['audio/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || result.assets.length === 0) return null;
  const asset = result.assets[0];
  const media = await importFile(asset.uri, asset.name);
  if (media.meta.kind !== 'audio' && !media.hasAudio) {
    throw new Error('El archivo no tiene audio.');
  }
  return media;
}

/** Copy a picked file into app storage and probe it with the engine. */
async function importFile(uri: string, name: string | null): Promise<ImportedMedia> {
  const dir = mediaDir();
  if (!dir.exists) dir.create({ intermediates: true });
  const id = uid('src');
  const ext = extensionOf(name ?? uri) ?? 'mp4';
  const fileName = `${id}.${ext}`;
  const dest = new File(dir, fileName);
  await new File(uri).copy(dest);

  const info = await VideoEngine.getMediaInfoAsync(dest.uri);
  return {
    fileName,
    hasAudio: info.hasAudio,
    meta: {
      id,
      name: name ?? fileName,
      durationSec: info.durationSec,
      width: info.width,
      height: info.height,
      fps: info.fps ?? null,
      codec: info.codec ?? null,
      kind: info.hasVideo ? 'video' : 'audio',
    },
  };
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
