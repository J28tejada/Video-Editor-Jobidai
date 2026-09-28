import { useEventListener } from 'expo';
import { Asset, requestPermissionsAsync } from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import VideoEngine from '../../modules/video-engine';
import { useEditor } from '../editor/EditorContext';
import { colors, radius } from '../ui/theme';
import type { SheetKind } from './EditSheets';
import { Chips, Label, Sheet } from './Sheet';

const RESOLUTIONS = [
  { label: 'Original', value: 0 },
  { label: '1080p', value: 1080 },
  { label: '720p', value: 720 },
];

type Status = { kind: 'idle' } | { kind: 'exporting'; progress: number } | { kind: 'done'; uri: string };

export function ExportSheet({ open, onClose }: { open: SheetKind; onClose: () => void }) {
  const { exportJSON, duration, pause } = useEditor();
  const [shortSide, setShortSide] = useState(1080);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  useEventListener(VideoEngine, 'onExportProgress', ({ progress }) => {
    setStatus((s) => (s.kind === 'exporting' ? { kind: 'exporting', progress } : s));
  });

  const start = async () => {
    if (duration <= 0) return;
    pause();
    setStatus({ kind: 'exporting', progress: 0 });
    try {
      const { uri } = await VideoEngine.exportAsync(exportJSON(), shortSide);
      setStatus({ kind: 'done', uri });
    } catch (e) {
      setStatus({ kind: 'idle' });
      const message = (e as Error).message;
      if (!/cancel/i.test(message)) Alert.alert('No se pudo exportar', message);
    }
  };

  const saveToGallery = async (uri: string) => {
    const { granted } = await requestPermissionsAsync(true);
    if (!granted) {
      Alert.alert('Permiso necesario', 'Permite guardar en la galería para descargar el video.');
      return;
    }
    await Asset.create(uri);
    Alert.alert('Guardado', 'El video está en tu galería.');
  };

  const close = () => {
    if (status.kind === 'exporting') return; // cancel explicitly
    setStatus({ kind: 'idle' });
    onClose();
  };

  return (
    <Sheet title="Exportar video" visible={open === 'export'} onClose={close}>
      {status.kind === 'idle' && (
        <>
          <Label>Resolución</Label>
          <Chips options={RESOLUTIONS} value={shortSide} onChange={setShortSide} />
          <Button label="Exportar MP4" onPress={start} disabled={duration <= 0} />
        </>
      )}
      {status.kind === 'exporting' && (
        <View style={styles.progress}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.progressText}>Exportando… {Math.round(status.progress * 100)}%</Text>
          <View style={styles.bar}>
            <View style={[styles.barFill, { width: `${Math.round(status.progress * 100)}%` }]} />
          </View>
          <Button label="Cancelar" secondary onPress={() => VideoEngine.cancelExportAsync()} />
        </View>
      )}
      {status.kind === 'done' && (
        <>
          <Text style={styles.progressText}>¡Listo!</Text>
          <Button
            label="Guardar en galería"
            onPress={() =>
              saveToGallery(status.uri).catch((e: Error) => Alert.alert('Error', e.message))
            }
          />
          <Button
            label="Compartir"
            secondary
            onPress={() => Sharing.shareAsync(status.uri, { mimeType: 'video/mp4' })}
          />
        </>
      )}
    </Sheet>
  );
}

function Button({
  label,
  onPress,
  disabled,
  secondary,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.button, secondary && styles.buttonSecondary, disabled && { opacity: 0.4 }]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  progress: { gap: 10, alignItems: 'stretch' },
  progressText: { color: colors.text, fontSize: 15, textAlign: 'center', fontWeight: '600' },
  bar: { height: 6, borderRadius: 3, backgroundColor: colors.panel, overflow: 'hidden' },
  barFill: { height: '100%', backgroundColor: colors.accent },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonSecondary: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
