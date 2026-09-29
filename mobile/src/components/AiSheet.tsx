/** On-device AI: auto-captions (Whisper) and silence removal. */
import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import type { CaptionProgress } from '../ai/captions';
import { DEFAULT_SILENCE_OPTIONS, type SilenceOptions } from '../ai/silences';
import { isModelDownloaded, MODELS, type ModelId } from '../ai/whisperModel';
import { useEditor } from '../editor/EditorContext';
import { colors, radius } from '../ui/theme';
import type { SheetKind } from './EditSheets';
import { Chips, Label, Sheet } from './Sheet';

const LANGUAGES = [
  { label: 'Español', value: 'es' },
  { label: 'English', value: 'en' },
  { label: 'Português', value: 'pt' },
  { label: 'Auto', value: 'auto' },
];

const INTENSITY: { label: string; value: string; opts: SilenceOptions }[] = [
  { label: 'Suave', value: 'soft', opts: { ...DEFAULT_SILENCE_OPTIONS, thresholdDb: -45, minSilenceSec: 0.7 } },
  { label: 'Normal', value: 'normal', opts: DEFAULT_SILENCE_OPTIONS },
  {
    label: 'Agresivo',
    value: 'strong',
    opts: { ...DEFAULT_SILENCE_OPTIONS, thresholdDb: -35, minSilenceSec: 0.25 },
  },
];

type Busy = { task: 'captions'; progress: CaptionProgress } | { task: 'silences'; value: number } | null;

export function AiSheet({ open, onClose }: { open: SheetKind; onClose: () => void }) {
  const { autoCaptions, removeSilences, duration } = useEditor();
  const [language, setLanguage] = useState('es');
  const [model, setModel] = useState<ModelId>('base');
  const [intensity, setIntensity] = useState('normal');
  const [busy, setBusy] = useState<Busy>(null);
  const abortRef = useRef<AbortController | null>(null);

  const runCaptions = async () => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy({ task: 'captions', progress: { stage: 'download', value: 0 } });
    try {
      const count = await autoCaptions({
        model,
        language,
        signal: ctrl.signal,
        onProgress: (progress) => setBusy({ task: 'captions', progress }),
      });
      setBusy(null);
      if (count === 0) Alert.alert('Sin voz', 'No se detectó voz en el audio de los clips.');
      else {
        onClose();
        Alert.alert('Subtítulos listos', `${count} líneas añadidas. Tócalas para editarlas.`);
      }
    } catch (e) {
      setBusy(null);
      if ((e as Error).name !== 'AbortError') Alert.alert('No se pudieron generar', (e as Error).message);
    } finally {
      abortRef.current = null;
    }
  };

  const runSilences = async () => {
    setBusy({ task: 'silences', value: 0 });
    try {
      const opts = INTENSITY.find((i) => i.value === intensity)!.opts;
      const r = await removeSilences(opts, (value) => setBusy({ task: 'silences', value }));
      setBusy(null);
      if (r.removedCount === 0 && r.removedSec < 0.05) {
        Alert.alert('Sin silencios', 'No se encontraron pausas que recortar con esta intensidad.');
      } else {
        onClose();
        Alert.alert('Listo', `${r.removedCount} cortes, ${r.removedSec.toFixed(1)} s de silencio quitados.`);
      }
    } catch (e) {
      setBusy(null);
      Alert.alert('No se pudo analizar', (e as Error).message);
    }
  };

  const close = () => {
    if (busy?.task === 'silences') return; // short, not cancellable
    abortRef.current?.abort();
    onClose();
  };

  return (
    <Sheet title="Herramientas IA" visible={open === 'ai'} onClose={close}>
      {busy ? (
        <View style={styles.progress}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.progressText}>{describe(busy)}</Text>
          <View style={styles.bar}>
            <View style={[styles.barFill, { width: `${Math.round(fraction(busy) * 100)}%` }]} />
          </View>
          {busy.task === 'captions' && (
            <Button label="Cancelar" secondary onPress={() => abortRef.current?.abort()} />
          )}
        </View>
      ) : (
        <>
          <Text style={styles.section}>Subtítulos automáticos</Text>
          <Text style={styles.hint}>Se transcriben en el teléfono; el audio no sale del dispositivo.</Text>
          <Label>Idioma</Label>
          <Chips options={LANGUAGES} value={language} onChange={setLanguage} />
          <Label>Modelo</Label>
          <Chips
            options={(Object.keys(MODELS) as ModelId[]).map((id) => ({
              label: `${MODELS[id].label} · ${isModelDownloaded(id) ? 'listo' : `${MODELS[id].sizeMB} MB`}`,
              value: id,
            }))}
            value={model}
            onChange={setModel}
          />
          <Button label="Generar subtítulos" onPress={runCaptions} disabled={duration <= 0} />

          <View style={styles.divider} />

          <Text style={styles.section}>Quitar silencios</Text>
          <Text style={styles.hint}>Corta las pausas largas de los clips (se puede deshacer).</Text>
          <Chips
            options={INTENSITY.map(({ label, value }) => ({ label, value }))}
            value={intensity}
            onChange={setIntensity}
          />
          <Button label="Quitar silencios" onPress={runSilences} disabled={duration <= 0} />
        </>
      )}
    </Sheet>
  );
}

function fraction(b: NonNullable<Busy>): number {
  return b.task === 'captions' ? b.progress.value : b.value;
}

function describe(b: NonNullable<Busy>): string {
  const pct = `${Math.round(fraction(b) * 100)}%`;
  if (b.task === 'silences') return `Analizando audio… ${pct}`;
  switch (b.progress.stage) {
    case 'download':
      return `Descargando modelo (una sola vez)… ${pct}`;
    case 'audio':
      return `Preparando audio… ${pct}`;
    case 'transcribe':
      return `Transcribiendo… ${pct}`;
  }
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
  section: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: 4 },
  hint: { color: colors.textDim, fontSize: 12 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 6 },
  progress: { gap: 10 },
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
