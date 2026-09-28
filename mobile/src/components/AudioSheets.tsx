/** Add / edit background music and sound effects. */
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { SYNTH_SFX } from '@audio/sfxList';
import { useEditor } from '../editor/EditorContext';
import { Icon } from '../ui/Icon';
import { colors, radius } from '../ui/theme';
import type { SheetKind } from './EditSheets';
import { Chips, Label, Sheet } from './Sheet';

const failed = (e: Error) => Alert.alert('No se pudo importar', e.message);

export function AudioAddSheet({
  open,
  onClose,
  openSheet,
}: {
  open: SheetKind;
  onClose: () => void;
  openSheet: (s: SheetKind) => void;
}) {
  const { importMusic, importSfx, addBuiltInSfx } = useEditor();
  return (
    <Sheet title="Audio" visible={open === 'audio'} onClose={onClose}>
      <Pressable
        style={styles.row}
        onPress={() =>
          importMusic()
            .then((ok) => ok && openSheet('music'))
            .catch(failed)
        }
      >
        <Icon name="music" />
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle}>Añadir música</Text>
          <Text style={styles.rowHint}>Suena de fondo en todo el video, baja cuando hay voz</Text>
        </View>
      </Pressable>
      <Label>Efectos de sonido (se colocan en el cursor)</Label>
      <Chips
        options={SYNTH_SFX.map((s) => ({ label: s.label, value: s.name }))}
        value={null}
        onChange={(name) => {
          addBuiltInSfx(name);
          onClose();
        }}
      />
      <Pressable
        style={styles.row}
        onPress={() =>
          importSfx()
            .then((ok) => ok && onClose())
            .catch(failed)
        }
      >
        <Icon name="sfx" />
        <Text style={styles.rowTitle}>Importar efecto…</Text>
      </Pressable>
    </Sheet>
  );
}

const MUSIC_VOLUMES = [0.05, 0.1, 0.15, 0.25, 0.5, 0.75, 1];
const FADES = [0, 0.5, 1, 2, 3];
const DUCKS = [
  { label: 'No', value: 1 },
  { label: 'Suave', value: 0.5 },
  { label: 'Media', value: 0.25 },
  { label: 'Fuerte', value: 0.1 },
];
const SFX_VOLUMES = [0.25, 0.5, 0.8, 1];

export function MusicSheet({ open, onClose }: { open: SheetKind; onClose: () => void }) {
  const { project, selection, patchMusic } = useEditor();
  const m = selection?.kind === 'music' ? project.music.find((x) => x.id === selection.id) : undefined;
  if (!m) return null;
  return (
    <Sheet title="Música" visible={open === 'music'} onClose={onClose}>
      <Label>Volumen</Label>
      <Chips
        options={MUSIC_VOLUMES.map((v) => ({ label: `${Math.round(v * 100)}%`, value: v }))}
        value={MUSIC_VOLUMES.find((v) => Math.abs(v - m.volume) < 0.005) ?? null}
        onChange={(volume) => patchMusic(m.id, { volume })}
      />
      <Label>Entrada gradual</Label>
      <Chips
        options={FADES.map((f) => ({ label: f === 0 ? 'No' : `${f}s`, value: f }))}
        value={m.fadeInSec}
        onChange={(fadeInSec) => patchMusic(m.id, { fadeInSec })}
      />
      <Label>Salida gradual</Label>
      <Chips
        options={FADES.map((f) => ({ label: f === 0 ? 'No' : `${f}s`, value: f }))}
        value={m.fadeOutSec}
        onChange={(fadeOutSec) => patchMusic(m.id, { fadeOutSec })}
      />
      <Label>Bajar cuando hay voz</Label>
      <Chips
        options={DUCKS}
        value={m.duck ? (DUCKS.find((d) => Math.abs(d.value - m.duckLevel) < 0.005)?.value ?? null) : 1}
        onChange={(level) =>
          patchMusic(m.id, level >= 1 ? { duck: false } : { duck: true, duckLevel: level })
        }
      />
      <Label>Repetir hasta el final</Label>
      <Chips
        options={[
          { label: 'Sí', value: 'yes' },
          { label: 'No', value: 'no' },
        ]}
        value={m.loop ? 'yes' : 'no'}
        onChange={(v) => patchMusic(m.id, { loop: v === 'yes' })}
      />
    </Sheet>
  );
}

export function SfxSheet({ open, onClose }: { open: SheetKind; onClose: () => void }) {
  const { project, selection, patchSfx } = useEditor();
  const s = selection?.kind === 'sfx' ? project.sfx.find((x) => x.id === selection.id) : undefined;
  if (!s) return null;
  return (
    <Sheet title="Efecto de sonido" visible={open === 'sfx'} onClose={onClose}>
      <Label>Volumen</Label>
      <Chips
        options={SFX_VOLUMES.map((v) => ({ label: `${Math.round(v * 100)}%`, value: v }))}
        value={SFX_VOLUMES.find((v) => Math.abs(v - s.volume) < 0.005) ?? null}
        onChange={(volume) => patchSfx(s.id, { volume })}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowHint: { color: colors.textDim, fontSize: 12, marginTop: 2 },
});
