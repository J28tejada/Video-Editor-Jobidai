/**
 * Edit by text: the transcript of what's on the timeline; tap words to select
 * them and delete — the video is cut to match.
 */
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { cutSourceRanges } from '@agent/editOps';
import { findFillers, timelineWords } from '@agent/understanding';
import { useAgent } from '../agent/AgentContext';
import { useEditor } from '../editor/EditorContext';
import { colors, radius } from '../ui/theme';
import type { SheetKind } from './EditSheets';
import { Sheet } from './Sheet';

export function TranscriptSheet({ open, onClose }: { open: SheetKind; onClose: () => void }) {
  const { project, getProject, commitProject, seek } = useEditor();
  const { index, analyze, status } = useAgent();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const words = useMemo(() => timelineWords(project, index), [project, index]);
  const fillers = useMemo(() => findFillers(words), [words]);

  const toggle = (i: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const deleteSelected = () => {
    const cuts = [...selected].map((i) => ({
      sourceId: words[i].sourceId,
      start: words[i].srcStart,
      end: words[i].srcEnd,
    }));
    commitProject(cutSourceRanges(getProject(), cuts), null);
    setSelected(new Set());
  };

  return (
    <Sheet title="Transcripción" visible={open === 'transcript'} onClose={onClose}>
      {words.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.hint}>
            Analiza tus videos para editarlos como un texto: toca palabras y bórralas.
          </Text>
          {status ? (
            <View style={styles.row}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.hint}>{status}</Text>
            </View>
          ) : (
            <Pressable style={styles.button} onPress={analyze}>
              <Text style={styles.buttonText}>Analizar mis videos</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <>
          <Text style={styles.hint}>Toca palabras para seleccionarlas; mantén pulsado para ir a ese momento.</Text>
          <ScrollView style={styles.text} contentContainerStyle={styles.words}>
            {words.map((w, i) => (
              <Pressable
                key={`${w.clipId}-${i}`}
                onPress={() => toggle(i)}
                onLongPress={() => seek(w.start, true)}
                style={[styles.word, selected.has(i) && styles.wordSelected]}
              >
                <Text style={[styles.wordText, selected.has(i) && styles.wordTextSelected]}>{w.text}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <View style={styles.row}>
            <Pressable
              style={[styles.button, selected.size === 0 && { opacity: 0.4 }]}
              disabled={selected.size === 0}
              onPress={deleteSelected}
            >
              <Text style={styles.buttonText}>Borrar {selected.size || ''} palabra{selected.size === 1 ? '' : 's'}</Text>
            </Pressable>
            <Pressable
              style={[styles.button, styles.secondary, fillers.length === 0 && { opacity: 0.4 }]}
              disabled={fillers.length === 0}
              onPress={() => commitProject(cutSourceRanges(getProject(), fillers), null)}
            >
              <Text style={styles.buttonText}>Quitar {fillers.length} muletillas</Text>
            </Pressable>
          </View>
        </>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  empty: { gap: 12 },
  hint: { color: colors.textDim, fontSize: 13 },
  text: { maxHeight: 320 },
  words: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, paddingVertical: 6 },
  word: { paddingHorizontal: 4, paddingVertical: 2, borderRadius: 4 },
  wordSelected: { backgroundColor: colors.danger },
  wordText: { color: colors.text, fontSize: 16 },
  wordTextSelected: { color: '#fff', textDecorationLine: 'line-through' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  button: {
    flex: 1,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondary: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
