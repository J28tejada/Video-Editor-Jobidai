import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useEditor } from '../editor/EditorContext';
import { Icon } from '../ui/Icon';
import { colors, radius } from '../ui/theme';
import { AudioAddSheet, MusicSheet, SfxSheet } from './AudioSheets';
import { ClipSheets, FormatSheet, TextSheet, type SheetKind } from './EditSheets';
import { ExportSheet } from './ExportSheet';
import { FilterSheet, TransitionSheet, ZoomSheet } from './LookSheets';
import { Preview } from './Preview';
import { Timeline } from './Timeline';
import { Toolbar } from './Toolbar';
import { Transport } from './Transport';

export function EditorScreen() {
  const { ready, duration, newProject } = useEditor();
  const [sheet, setSheet] = useState<SheetKind>(null);
  const close = () => setSheet(null);

  if (!ready) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable
          hitSlop={10}
          onPress={() =>
            Alert.alert('Nuevo proyecto', 'Se borrará el proyecto actual y sus videos.', [
              { text: 'Cancelar', style: 'cancel' },
              { text: 'Borrar', style: 'destructive', onPress: newProject },
            ])
          }
        >
          <Icon name="add" size={22} />
        </Pressable>
        <Text style={styles.title}>Editor de Video</Text>
        <Pressable
          style={[styles.export, duration <= 0 && { opacity: 0.4 }]}
          disabled={duration <= 0}
          onPress={() => setSheet('export')}
        >
          <Text style={styles.exportText}>Exportar</Text>
        </Pressable>
      </View>

      <Preview />
      <Transport />
      <Timeline />
      <Toolbar openSheet={setSheet} />

      <ClipSheets open={sheet} onClose={close} />
      <TextSheet open={sheet} onClose={close} />
      <FormatSheet open={sheet} onClose={close} />
      <ExportSheet open={sheet} onClose={close} />
      <AudioAddSheet open={sheet} onClose={close} openSheet={setSheet} />
      <MusicSheet open={sheet} onClose={close} />
      <SfxSheet open={sheet} onClose={close} />
      <FilterSheet open={sheet} onClose={close} />
      <ZoomSheet open={sheet} onClose={close} />
      <TransitionSheet open={sheet} onClose={close} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  export: {
    backgroundColor: colors.accent,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.md,
  },
  exportText: { color: '#fff', fontWeight: '700', fontSize: 14 },
});
