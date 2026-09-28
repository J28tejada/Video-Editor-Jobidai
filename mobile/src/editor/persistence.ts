/** Saves the open project (and its media file map) to the documents directory. */
import { File, Paths } from 'expo-file-system';

import { normalizeProject } from '@timeline/project';
import type { Project } from '@timeline/types';
import type { MediaFiles } from '../media/mediaLibrary';

export type SavedState = { project: Project; media: MediaFiles };

const stateFile = () => new File(Paths.document, 'project.json');

export async function loadState(): Promise<SavedState | null> {
  const file = stateFile();
  if (!file.exists) return null;
  try {
    const data = JSON.parse(await file.text()) as SavedState;
    return { project: normalizeProject(data.project), media: data.media ?? {} };
  } catch {
    return null;
  }
}

export function saveState(state: SavedState): void {
  const file = stateFile();
  try {
    if (!file.exists) file.create();
    file.write(JSON.stringify(state));
  } catch (e) {
    console.warn('No se pudo guardar el proyecto', e);
  }
}
