/**
 * In-memory registry of live media (non-serializable), keyed by source id.
 *
 * The project JSON only stores SourceMeta; the decoded inputs/sinks/blobs live
 * here. When a project is reloaded from JSON, sources start "unlinked" until
 * the user re-imports the matching file (matched by name) — see relinkByName.
 */
import type { SourceMeta } from '../timeline/types';
import { loadMediaFile, loadAudioFile, loadImageFile, type LoadedMedia } from './source';
import type { SourceKind } from '../timeline/types';

const registry = new Map<string, LoadedMedia>();

export function getMedia(sourceId: string): LoadedMedia | undefined {
  return registry.get(sourceId);
}

export function registerMedia(media: LoadedMedia): void {
  registry.set(media.meta.id, media);
}

/** Import a file and register it, returning its metadata. */
export async function importFile(file: File): Promise<SourceMeta> {
  const media = await loadMediaFile(file);
  registerMedia(media);
  return media.meta;
}

/** Import an audio-only file (background music) and register it. */
export async function importAudio(file: File): Promise<SourceMeta> {
  const media = await loadAudioFile(file);
  registerMedia(media);
  return media.meta;
}

/** Import a still image and register it. */
export async function importImage(file: File): Promise<SourceMeta> {
  const media = await loadImageFile(file);
  registerMedia(media);
  return media.meta;
}

/**
 * Relink an imported file to an existing (unlinked) source from a loaded
 * project, matching by file name. Returns the source id it linked to, or null.
 */
export async function relinkByName(
  file: File,
  unlinkedSources: SourceMeta[],
): Promise<string | null> {
  const match = unlinkedSources.find((s) => s.name === file.name);
  if (!match) return null;
  const media = await loadMediaFile(file);
  // Re-key the freshly loaded media under the project's existing source id.
  media.meta.id = match.id;
  registerMedia(media);
  return match.id;
}

export function isLinked(sourceId: string): boolean {
  return registry.has(sourceId);
}

/**
 * Load a previously-persisted media file and register it under an existing
 * source id (used when restoring a project from IndexedDB).
 */
export async function registerMediaForSource(
  sourceId: string,
  file: File | Blob,
  kind: SourceKind = 'video',
): Promise<void> {
  const asFile =
    file instanceof File ? file : new File([file], sourceId, { type: file.type });
  const media =
    kind === 'audio'
      ? await loadAudioFile(asFile)
      : kind === 'image'
        ? await loadImageFile(asFile)
        : await loadMediaFile(asFile);
  media.meta.id = sourceId;
  registerMedia(media);
}

export function clearRegistry(): void {
  registry.clear();
}
