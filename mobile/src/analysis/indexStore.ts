/** Persisted understanding index (per source, source-time based). */
import { File, Paths } from 'expo-file-system';

import type { SourceIndex } from '@agent/context';

const file = () => new File(Paths.document, 'analysis.json');

export async function loadIndex(): Promise<SourceIndex[]> {
  const f = file();
  if (!f.exists) return [];
  try {
    const data = JSON.parse(await f.text()) as SourceIndex[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function saveIndex(index: SourceIndex[]): void {
  const f = file();
  try {
    if (!f.exists) f.create();
    f.write(JSON.stringify(index));
  } catch (e) {
    console.warn('No se pudo guardar el análisis', e);
  }
}

const memoryFile = () => new File(Paths.document, 'memory.json');

/** Style / brand preferences the agent was asked to remember. */
export async function loadMemory(): Promise<string[]> {
  const f = memoryFile();
  if (!f.exists) return [];
  try {
    const data = JSON.parse(await f.text()) as unknown;
    return Array.isArray(data) ? data.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveMemory(memory: string[]): void {
  const f = memoryFile();
  try {
    if (!f.exists) f.create();
    f.write(JSON.stringify(memory));
  } catch (e) {
    console.warn('No se pudieron guardar las preferencias', e);
  }
}
