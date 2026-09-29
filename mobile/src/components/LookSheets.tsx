/** Color filters, zoom / reframe and transitions. */
import { findClip } from '@timeline/project';
import { FILTER_PRESETS } from '@timeline/filterPresets';
import type { ClipFilters } from '@timeline/types';
import { useEditor } from '../editor/EditorContext';
import type { SheetKind } from './EditSheets';
import { Chips, Label, Sheet } from './Sheet';

const same = (a: ClipFilters | undefined, b: ClipFilters) => {
  const keys: (keyof ClipFilters)[] = ['brightness', 'contrast', 'saturate', 'sepia', 'grayscale', 'hueRotate', 'blur'];
  const neutral: ClipFilters = { brightness: 1, contrast: 1, saturate: 1 };
  return keys.every((k) => (a?.[k] ?? neutral[k] ?? 0) === (b[k] ?? neutral[k] ?? 0));
};

const BRIGHTNESS = [
  { label: 'Menos', value: 0.85 },
  { label: 'Normal', value: 1 },
  { label: 'Más', value: 1.15 },
];
const CONTRAST = [
  { label: 'Suave', value: 0.85 },
  { label: 'Normal', value: 1 },
  { label: 'Fuerte', value: 1.2 },
];
const SATURATION = [
  { label: 'Apagada', value: 0.6 },
  { label: 'Normal', value: 1 },
  { label: 'Viva', value: 1.3 },
  { label: 'Intensa', value: 1.6 },
];
const WARMTH = [
  { label: 'Normal', value: 0 },
  { label: 'Cálida', value: 0.2 },
  { label: 'Muy cálida', value: 0.4 },
];

export function FilterSheet({ open, onClose }: { open: SheetKind; onClose: () => void }) {
  const { project, selection, setFilters, setAllFilters } = useEditor();
  const clip = selection?.kind === 'clip' ? findClip(project, selection.id)?.clip : undefined;
  if (!clip) return null;
  const f = clip.filters ?? {};
  const preset = FILTER_PRESETS.find(([, p]) => same(clip.filters, p))?.[0] ?? null;
  return (
    <Sheet title="Filtros" visible={open === 'filters'} onClose={onClose}>
      <Label>Estilo</Label>
      <Chips
        options={FILTER_PRESETS.map(([name]) => ({ label: name, value: name }))}
        value={preset}
        onChange={(name) => {
          const found = FILTER_PRESETS.find(([n]) => n === name);
          setAllFilters(clip.id, found && Object.keys(found[1]).length ? { ...found[1] } : undefined);
        }}
      />
      <Label>Brillo</Label>
      <Chips options={BRIGHTNESS} value={f.brightness ?? 1} onChange={(brightness) => setFilters(clip.id, { brightness })} />
      <Label>Contraste</Label>
      <Chips options={CONTRAST} value={f.contrast ?? 1} onChange={(contrast) => setFilters(clip.id, { contrast })} />
      <Label>Saturación</Label>
      <Chips options={SATURATION} value={f.saturate ?? 1} onChange={(saturate) => setFilters(clip.id, { saturate })} />
      <Label>Calidez</Label>
      <Chips options={WARMTH} value={f.sepia ?? 0} onChange={(sepia) => setFilters(clip.id, { sepia })} />
    </Sheet>
  );
}

const ZOOMS = [1, 1.25, 1.5, 2, 3];
const POSITIONS = [
  { label: 'Centro', value: '0.5,0.5' },
  { label: 'Arriba', value: '0.5,0.3' },
  { label: 'Abajo', value: '0.5,0.7' },
  { label: 'Izquierda', value: '0.3,0.5' },
  { label: 'Derecha', value: '0.7,0.5' },
];

export function ZoomSheet({ open, onClose }: { open: SheetKind; onClose: () => void }) {
  const { project, selection, setZoom } = useEditor();
  const clip = selection?.kind === 'clip' ? findClip(project, selection.id)?.clip : undefined;
  if (!clip) return null;
  const t = clip.transform ?? { scale: 1, xNorm: 0.5, yNorm: 0.5 };
  return (
    <Sheet title="Zoom" visible={open === 'zoom'} onClose={onClose}>
      <Label>Acercar</Label>
      <Chips
        options={ZOOMS.map((z) => ({ label: `${z}×`, value: z }))}
        value={t.scale}
        onChange={(scale) => setZoom(clip.id, scale === 1 ? { scale, xNorm: 0.5, yNorm: 0.5 } : { scale })}
      />
      <Label>Enfocar en</Label>
      <Chips
        options={POSITIONS}
        value={`${t.xNorm},${t.yNorm}`}
        onChange={(v) => {
          const [xNorm, yNorm] = v.split(',').map(Number);
          setZoom(clip.id, { xNorm, yNorm });
        }}
      />
    </Sheet>
  );
}

const KINDS = [
  { label: 'Fundido', value: 'crossfade' },
  { label: 'A negro', value: 'fade' },
  { label: 'Deslizar', value: 'slide' },
];
const DURATIONS = [0.3, 0.5, 1, 1.5];

export function TransitionSheet({ open, onClose }: { open: SheetKind; onClose: () => void }) {
  const { project, selection, patchTransition } = useEditor();
  const tr =
    selection?.kind === 'transition'
      ? project.transitions.find((t) => t.id === selection.id)
      : undefined;
  if (!tr) return null;
  return (
    <Sheet title="Transición" visible={open === 'transition'} onClose={onClose}>
      <Label>Tipo</Label>
      <Chips
        options={KINDS}
        value={KINDS.some((k) => k.value === tr.kind) ? tr.kind : 'crossfade'}
        onChange={(kind) => patchTransition(tr.id, { kind })}
      />
      <Label>Duración</Label>
      <Chips
        options={DURATIONS.map((d) => ({ label: `${d}s`, value: d }))}
        value={tr.durationSec}
        onChange={(durationSec) => patchTransition(tr.id, { durationSec })}
      />
    </Sheet>
  );
}
