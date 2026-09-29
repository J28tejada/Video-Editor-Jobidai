/**
 * Bottom tool row. Context-sensitive like CapCut: project tools by default,
 * clip tools when a clip is selected, text tools when a text is selected.
 */
import { Alert, Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { useEditor } from '../editor/EditorContext';
import { Icon, type IconName } from '../ui/Icon';
import { colors } from '../ui/theme';
import type { SheetKind } from './EditSheets';

type Tool = { icon: IconName; label: string; onPress: () => void; danger?: boolean };

export function Toolbar({ openSheet }: { openSheet: (s: SheetKind) => void }) {
  const {
    selection,
    select,
    split,
    removeSelected,
    addText,
    importVideos,
    duration,
    moveSelectedToPlayhead,
  } = useEditor();

  const importTool: Tool = {
    icon: 'import',
    label: 'Importar',
    onPress: () =>
      importVideos().catch((e: Error) => Alert.alert('No se pudo importar', e.message)),
  };

  let tools: Tool[];
  if (selection?.kind === 'clip') {
    tools = [
      { icon: 'split', label: 'Cortar', onPress: split },
      { icon: 'filters', label: 'Filtros', onPress: () => openSheet('filters') },
      { icon: 'speed', label: 'Velocidad', onPress: () => openSheet('speed') },
      { icon: 'volume', label: 'Volumen', onPress: () => openSheet('volume') },
      { icon: 'zoom', label: 'Zoom', onPress: () => openSheet('zoom') },
      { icon: 'fit', label: 'Encuadre', onPress: () => openSheet('fit') },
      { icon: 'delete', label: 'Borrar', onPress: removeSelected, danger: true },
      { icon: 'close', label: 'Cerrar', onPress: () => select(null) },
    ];
  } else if (selection?.kind === 'music' || selection?.kind === 'sfx') {
    const sheet = selection.kind;
    tools = [
      { icon: 'edit', label: 'Editar', onPress: () => openSheet(sheet) },
      { icon: 'toPlayhead', label: 'Al cursor', onPress: moveSelectedToPlayhead },
      { icon: 'delete', label: 'Borrar', onPress: removeSelected, danger: true },
      { icon: 'close', label: 'Cerrar', onPress: () => select(null) },
    ];
  } else if (selection?.kind === 'transition') {
    tools = [
      { icon: 'edit', label: 'Editar', onPress: () => openSheet('transition') },
      { icon: 'delete', label: 'Quitar', onPress: removeSelected, danger: true },
      { icon: 'close', label: 'Cerrar', onPress: () => select(null) },
    ];
  } else if (selection?.kind === 'text') {
    tools = [
      { icon: 'edit', label: 'Editar', onPress: () => openSheet('text') },
      { icon: 'delete', label: 'Borrar', onPress: removeSelected, danger: true },
      { icon: 'close', label: 'Cerrar', onPress: () => select(null) },
    ];
  } else {
    tools = [
      importTool,
      { icon: 'split', label: 'Cortar', onPress: split },
      {
        icon: 'text',
        label: 'Texto',
        onPress: () => {
          if (duration <= 0) return;
          addText();
          openSheet('text');
        },
      },
      {
        icon: 'music',
        label: 'Audio',
        onPress: () => {
          if (duration > 0) openSheet('audio');
        },
      },
      { icon: 'format', label: 'Formato', onPress: () => openSheet('format') },
    ];
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      style={styles.bar}
    >
      {tools.map((t) => (
        <Pressable key={t.label} onPress={t.onPress} style={styles.tool}>
          <Icon name={t.icon} size={22} color={t.danger ? colors.danger : colors.text} />
          <Text style={[styles.label, t.danger && { color: colors.danger }]}>{t.label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bar: { flexGrow: 0, backgroundColor: colors.bg },
  row: { paddingHorizontal: 8, paddingVertical: 8, gap: 4 },
  tool: { width: 68, alignItems: 'center', gap: 4, paddingVertical: 4 },
  label: { color: colors.text, fontSize: 11, fontWeight: '500' },
});
