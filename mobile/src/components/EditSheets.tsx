/** Edit panels for the selected clip / text and project format. */
import { StyleSheet, TextInput } from 'react-native';

import { findClip } from '@timeline/project';
import { clipGain, clipSpeed } from '@timeline/types';
import { useEditor } from '../editor/EditorContext';
import { colors, radius } from '../ui/theme';
import { Chips, Label, Sheet } from './Sheet';

export type SheetKind =
  | 'speed'
  | 'volume'
  | 'fit'
  | 'text'
  | 'format'
  | 'export'
  | 'audio'
  | 'music'
  | 'sfx'
  | 'filters'
  | 'zoom'
  | 'transition'
  | null;

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const VOLUMES = [0, 0.25, 0.5, 0.75, 1];

export function ClipSheets({ open, onClose }: { open: SheetKind; onClose: () => void }) {
  const { project, selection, setSpeed, setVolume, setFit } = useEditor();
  const clip = selection?.kind === 'clip' ? findClip(project, selection.id)?.clip : undefined;
  if (!clip) return null;
  return (
    <>
      <Sheet title="Velocidad" visible={open === 'speed'} onClose={onClose}>
        <Chips
          options={SPEEDS.map((s) => ({ label: `${s}×`, value: s }))}
          value={clipSpeed(clip)}
          onChange={(s) => setSpeed(clip.id, s)}
        />
      </Sheet>
      <Sheet title="Volumen" visible={open === 'volume'} onClose={onClose}>
        <Chips
          options={VOLUMES.map((v) => ({ label: v === 0 ? 'Silencio' : `${v * 100}%`, value: v }))}
          value={clipGain(clip)}
          onChange={(v) => setVolume(clip.id, v)}
        />
      </Sheet>
      <Sheet title="Encuadre" visible={open === 'fit'} onClose={onClose}>
        <Chips
          options={[
            { label: 'Ajustar (con bordes)', value: 'contain' as const },
            { label: 'Llenar (recortar)', value: 'cover' as const },
          ]}
          value={clip.fit ?? 'contain'}
          onChange={(f) => setFit(clip.id, f)}
        />
      </Sheet>
    </>
  );
}

const TEXT_SIZES = [
  { label: 'S', value: 0.04 },
  { label: 'M', value: 0.06 },
  { label: 'L', value: 0.08 },
  { label: 'XL', value: 0.11 },
];
const TEXT_COLORS = ['#ffffff', '#000000', '#facc15', '#f43f5e', '#22d3ee', '#a3e635'];
const POSITIONS = [
  { label: 'Arriba', value: 0.15 },
  { label: 'Centro', value: 0.5 },
  { label: 'Abajo', value: 0.85 },
];
const DURATIONS = [2, 3, 5, 8];

export function TextSheet({ open, onClose }: { open: SheetKind; onClose: () => void }) {
  const { project, selection, patchText, duration } = useEditor();
  const overlay =
    selection?.kind === 'text' ? project.overlays.find((o) => o.id === selection.id) : undefined;
  if (!overlay) return null;
  const len = +(overlay.endSec - overlay.startSec).toFixed(1);
  return (
    <Sheet title="Texto" visible={open === 'text'} onClose={onClose}>
      <TextInput
        value={overlay.text}
        onChangeText={(text) => patchText(overlay.id, { text })}
        style={styles.input}
        placeholder="Escribe tu texto"
        placeholderTextColor={colors.textDim}
        autoFocus
      />
      <Label>Tamaño</Label>
      <Chips
        options={TEXT_SIZES}
        value={TEXT_SIZES.find((s) => Math.abs(s.value - overlay.fontSizeNorm) < 0.005)?.value ?? null}
        onChange={(fontSizeNorm) => patchText(overlay.id, { fontSizeNorm })}
      />
      <Label>Color</Label>
      <Chips
        options={TEXT_COLORS.map((c) => ({ label: c, value: c, swatch: c }))}
        value={overlay.color}
        onChange={(color) => patchText(overlay.id, { color })}
      />
      <Label>Fondo</Label>
      <Chips
        options={[
          { label: 'Sin fondo', value: 'none' },
          { label: 'Oscuro', value: 'rgba(0,0,0,0.5)' },
          { label: 'Claro', value: 'rgba(255,255,255,0.85)' },
        ]}
        value={overlay.background ?? 'none'}
        onChange={(bg) => patchText(overlay.id, { background: bg === 'none' ? null : bg })}
      />
      <Label>Posición</Label>
      <Chips
        options={POSITIONS}
        value={POSITIONS.find((p) => Math.abs(p.value - overlay.yNorm) < 0.02)?.value ?? null}
        onChange={(yNorm) => patchText(overlay.id, { yNorm, xNorm: 0.5 })}
      />
      <Label>Duración</Label>
      <Chips
        options={DURATIONS.map((d) => ({ label: `${d}s`, value: d }))}
        value={DURATIONS.includes(len) ? len : null}
        onChange={(d) =>
          patchText(overlay.id, {
            endSec: Math.min(overlay.startSec + d, Math.max(duration, overlay.startSec + 0.5)),
          })
        }
      />
    </Sheet>
  );
}

const FORMATS = [
  { label: '9:16', value: '1080x1920' },
  { label: '1:1', value: '1080x1080' },
  { label: '4:5', value: '1080x1350' },
  { label: '16:9', value: '1920x1080' },
];

export function FormatSheet({ open, onClose }: { open: SheetKind; onClose: () => void }) {
  const { project, setFormat } = useEditor();
  return (
    <Sheet title="Formato" visible={open === 'format'} onClose={onClose}>
      <Chips
        options={FORMATS}
        value={`${project.width}x${project.height}`}
        onChange={(v) => {
          const [w, h] = v.split('x').map(Number);
          setFormat(w, h);
        }}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  input: {
    backgroundColor: colors.panel,
    color: colors.text,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
});
