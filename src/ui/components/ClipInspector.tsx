/**
 * Inspector for the selected clip. On desktop shows all sections in a sidebar.
 * On mobile, renders only the section chosen via MobileNav (ClipSectionContext).
 * Renders nothing when no clip is selected.
 */
import {
  Scissors, RotateCcw,
  ArrowUpLeft, ArrowUpRight, ArrowDownLeft, ArrowDownRight, Crosshair,
} from 'lucide-react';
import { useEditor } from '../../state/EditorContext';
import { useClipSection } from '../../state/ClipSectionContext';
import { clipGain, DEFAULT_TRANSFORM, hasSpeedCurve, type ClipFilters, type SpeedKey } from '../../core/timeline/types';
import type { AnimType } from '../../core/timeline/anim';
import { ANIM_OPTIONS } from './OverlayInspector';

const SPEED_CURVES: [string, SpeedKey[]][] = [
  ['Constante', []],
  ['Rampa ↑', [{ t: 0, speed: 0.4 }, { t: 1, speed: 2.5 }]],
  ['Rampa ↓', [{ t: 0, speed: 2.5 }, { t: 1, speed: 0.4 }]],
  ['Slow medio', [{ t: 0, speed: 1.5 }, { t: 0.5, speed: 0.35 }, { t: 1, speed: 1.5 }]],
  ['Flash medio', [{ t: 0, speed: 0.8 }, { t: 0.5, speed: 3 }, { t: 1, speed: 0.8 }]],
];

const FILTER_PRESETS: [string, ClipFilters][] = [
  ['Ninguno', {}],
  ['Vívido', { contrast: 1.15, saturate: 1.3 }],
  ['Cálido', { sepia: 0.25, saturate: 1.1, brightness: 1.05 }],
  ['Frío', { hueRotate: -12, saturate: 1.05, brightness: 1.02 }],
  ['B/N', { grayscale: 1, contrast: 1.1 }],
  ['Cine', { contrast: 1.2, saturate: 0.85, sepia: 0.1 }],
];

export function ClipInspector() {
  const {
    project,
    selectedClipId,
    setClipAudio,
    setClipTransform,
    setClipAnim,
    setClipSpeed,
    setClipSpeedCurve,
    setClipFilters,
    setClipFiltersAll,
    setClipFit,
    setClipBg,
    setClipRemoveBg,
    endGesture,
  } = useEditor();
  const { section } = useClipSection();

  if (!selectedClipId) return null;

  const track = project.tracks.find((t) => t.clips.some((c) => c.id === selectedClipId));
  const clip = track?.clips.find((c) => c.id === selectedClipId);
  if (!clip || !track) return null;

  const isOverlay = track.role === 'overlay';
  const volume = clip.volume ?? 1;
  const muted = !!clip.muted;
  const tf = clip.transform ?? DEFAULT_TRANSFORM;
  const animDur = clip.enter?.durationSec ?? clip.exit?.durationSec ?? 0.3;
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const hasCurve = hasSpeedCurve(clip);
  const f = clip.filters ?? {};
  const bg = clip.bg ?? { type: 'black' as const };
  const setTf = (patch: Partial<typeof tf>) => setClipTransform(clip.id, patch);

  // On mobile: only render when a section is explicitly selected via MobileNav.
  // On desktop (section always null): show all sections in the sidebar.
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 760;
  if (isMobile && section === null) return null;

  // section === null only reaches here on desktop → show all sections
  const showAll = section === null;

  const removeBgSection = (
    <>
      <label className="inspector__field inspector__field--inline inspector__applyall">
        <span className="inspector__icon-label"><Scissors size={14} /> Quitar fondo (IA)</span>
        <input
          type="checkbox"
          checked={!!clip.removeBg}
          onChange={(e) => setClipRemoveBg(clip.id, e.target.checked)}
        />
      </label>
      <p className="inspector__note">
        Recorta a la persona. En pista base, el fondo usa el ajuste de Fondo
        (color/desenfoque); en overlay, se ve el video de la base detrás.
      </p>
    </>
  );

  const speedSection = (
    <>
      <label className="inspector__field">
        <span>Velocidad {speed.toFixed(2)}x</span>
        <input
          type="range" min={0.25} max={4} step={0.05}
          value={speed}
          onChange={(e) => setClipSpeed(clip.id, Number(e.target.value))}
          onPointerUp={endGesture}
        />
      </label>
      <div className="inspector__corners">
        {[0.5, 1, 1.5, 2].map((s) => (
          <button
            key={s}
            onClick={() => { setClipSpeed(clip.id, s); endGesture(); }}
            title={`${s}x`}
          >
            {s}x
          </button>
        ))}
      </div>
      <div className="inspector__corners">
        {SPEED_CURVES.map(([label, keys]) => (
          <button
            key={label}
            onClick={() => {
              if (keys.length === 0) setClipSpeed(clip.id, 1);
              else setClipSpeedCurve(clip.id, keys);
            }}
            style={hasCurve && label !== 'Constante' ? { borderColor: 'var(--accent-2)' } : undefined}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="inspector__note">
        {hasCurve
          ? 'Curva de tiempo activa — la velocidad varía a lo largo del clip.'
          : 'Cambiar la velocidad ajusta la duración del clip. El audio cambia de tono.'}
      </p>
    </>
  );

  const colorSection = (
    <>
      <div className="inspector__head">
        <strong>Color</strong>
        <button onClick={() => setClipFiltersAll(clip.id, undefined)} title="Restablecer color">
          <RotateCcw size={14} />
        </button>
      </div>
      <label className="inspector__field inspector__field--inline">
        <span>Preset</span>
        <select
          value=""
          onChange={(e) => {
            const found = FILTER_PRESETS.find(([n]) => n === e.target.value);
            if (found) setClipFiltersAll(clip.id, { ...found[1] });
          }}
        >
          <option value="" disabled>Elegir…</option>
          {FILTER_PRESETS.map(([name]) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </label>
      <label className="inspector__field">
        <span>Brillo {Math.round((f.brightness ?? 1) * 100)}%</span>
        <input type="range" min={0.3} max={1.7} step={0.01}
          value={f.brightness ?? 1}
          onChange={(e) => setClipFilters(clip.id, { brightness: Number(e.target.value) })}
          onPointerUp={endGesture} />
      </label>
      <label className="inspector__field">
        <span>Contraste {Math.round((f.contrast ?? 1) * 100)}%</span>
        <input type="range" min={0.3} max={1.7} step={0.01}
          value={f.contrast ?? 1}
          onChange={(e) => setClipFilters(clip.id, { contrast: Number(e.target.value) })}
          onPointerUp={endGesture} />
      </label>
      <label className="inspector__field">
        <span>Saturación {Math.round((f.saturate ?? 1) * 100)}%</span>
        <input type="range" min={0} max={2} step={0.01}
          value={f.saturate ?? 1}
          onChange={(e) => setClipFilters(clip.id, { saturate: Number(e.target.value) })}
          onPointerUp={endGesture} />
      </label>
      <label className="inspector__field">
        <span>Calidez {Math.round((f.sepia ?? 0) * 100)}%</span>
        <input type="range" min={0} max={1} step={0.01}
          value={f.sepia ?? 0}
          onChange={(e) => setClipFilters(clip.id, { sepia: Number(e.target.value) })}
          onPointerUp={endGesture} />
      </label>
    </>
  );

  const frameSection = !isOverlay ? (
    <>
      <div className="inspector__head"><strong>Encuadre</strong></div>
      <label className="inspector__field inspector__field--inline">
        <span>Ajuste</span>
        <select value={clip.fit ?? 'contain'}
          onChange={(e) => setClipFit(clip.id, e.target.value as 'contain' | 'cover')}>
          <option value="contain">Ajustar (con franjas)</option>
          <option value="cover">Llenar (recorta)</option>
        </select>
      </label>
      {(clip.fit ?? 'contain') === 'contain' && (
        <>
          <label className="inspector__field inspector__field--inline">
            <span>Fondo</span>
            <select value={bg.type} onChange={(e) => {
              const type = e.target.value as 'black' | 'blur' | 'color';
              setClipBg(clip.id, { type, color: bg.color ?? '#000000', blur: bg.blur ?? 24 });
            }}>
              <option value="black">Negro</option>
              <option value="blur">Desenfocado</option>
              <option value="color">Color</option>
            </select>
          </label>
          {bg.type === 'color' && (
            <label className="inspector__field inspector__field--inline">
              <span>Color de fondo</span>
              <input type="color" value={bg.color ?? '#000000'}
                onChange={(e) => setClipBg(clip.id, { ...bg, color: e.target.value })} />
            </label>
          )}
          {bg.type === 'blur' && (
            <label className="inspector__field">
              <span>Desenfoque {bg.blur ?? 24}px</span>
              <input type="range" min={4} max={60} step={1} value={bg.blur ?? 24}
                onChange={(e) => setClipBg(clip.id, { ...bg, blur: Number(e.target.value) })}
                onPointerUp={endGesture} />
            </label>
          )}
        </>
      )}
      {clip.fit === 'cover' && (
        <>
          <label className="inspector__field">
            <span>Zoom {Math.round(tf.scale * 100)}%</span>
            <input type="range" min={1} max={3} step={0.01} value={tf.scale}
              onChange={(e) => setClipTransform(clip.id, { scale: Number(e.target.value) })}
              onPointerUp={endGesture} />
          </label>
          <div className="inspector__row">
            <label className="inspector__field">
              <span>X {Math.round(tf.xNorm * 100)}%</span>
              <input type="range" min={0} max={1} step={0.01} value={tf.xNorm}
                onChange={(e) => setClipTransform(clip.id, { xNorm: Number(e.target.value) })}
                onPointerUp={endGesture} />
            </label>
            <label className="inspector__field">
              <span>Y {Math.round(tf.yNorm * 100)}%</span>
              <input type="range" min={0} max={1} step={0.01} value={tf.yNorm}
                onChange={(e) => setClipTransform(clip.id, { yNorm: Number(e.target.value) })}
                onPointerUp={endGesture} />
            </label>
          </div>
          <p className="inspector__note">Reencuadra para llenar el formato sin franjas.</p>
        </>
      )}
    </>
  ) : (
    <>
      <div className="inspector__head"><strong>Encuadre</strong></div>
      <label className="inspector__field">
        <span>Tamaño {Math.round(tf.scale * 100)}%</span>
        <input type="range" min={0.05} max={1.5} step={0.01} value={tf.scale}
          onChange={(e) => setTf({ scale: Number(e.target.value) })}
          onPointerUp={endGesture} />
      </label>
      <div className="inspector__row">
        <label className="inspector__field">
          <span>X {Math.round(tf.xNorm * 100)}%</span>
          <input type="range" min={0} max={1} step={0.01} value={tf.xNorm}
            onChange={(e) => setTf({ xNorm: Number(e.target.value) })}
            onPointerUp={endGesture} />
        </label>
        <label className="inspector__field">
          <span>Y {Math.round(tf.yNorm * 100)}%</span>
          <input type="range" min={0} max={1} step={0.01} value={tf.yNorm}
            onChange={(e) => setTf({ yNorm: Number(e.target.value) })}
            onPointerUp={endGesture} />
        </label>
      </div>
      <div className="inspector__corners">
        {(
          [
            [<ArrowUpLeft size={16} />, 'Esquina sup. izq.', 0.18, 0.12],
            [<ArrowUpRight size={16} />, 'Esquina sup. der.', 0.82, 0.12],
            [<Crosshair size={16} />, 'Centro', 0.5, 0.5],
            [<ArrowDownLeft size={16} />, 'Esquina inf. izq.', 0.18, 0.88],
            [<ArrowDownRight size={16} />, 'Esquina inf. der.', 0.82, 0.88],
          ] as const
        ).map(([icon, title, x, y]) => (
          <button key={title}
            onClick={() => { setClipTransform(clip.id, { xNorm: x, yNorm: y, scale: Math.min(tf.scale, 0.35) }); endGesture(); }}
            title={title}>
            {icon}
          </button>
        ))}
      </div>
      <div className="inspector__row">
        <label className="inspector__field">
          <span>Entrada</span>
          <select value={clip.enter?.type ?? 'none'}
            onChange={(e) => setClipAnim(clip.id, { enter: { type: e.target.value as AnimType, durationSec: animDur } })}>
            {ANIM_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="inspector__field">
          <span>Salida</span>
          <select value={clip.exit?.type ?? 'none'}
            onChange={(e) => setClipAnim(clip.id, { exit: { type: e.target.value as AnimType, durationSec: animDur } })}>
            {ANIM_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      <label className="inspector__field">
        <span>Duración anim. {animDur.toFixed(2)}s</span>
        <input type="range" min={0.1} max={1.5} step={0.05} value={animDur}
          onChange={(e) => {
            const d = Number(e.target.value);
            setClipAnim(clip.id, {
              enter: { type: clip.enter?.type ?? 'fade', durationSec: d },
              exit: { type: clip.exit?.type ?? 'none', durationSec: d },
            });
          }}
          onPointerUp={endGesture} />
      </label>
    </>
  );

  const audioSection = (
    <>
      <div className="inspector__head"><strong>Audio</strong></div>
      <label className="inspector__field inspector__field--inline">
        <span>Silenciar</span>
        <input type="checkbox" checked={muted}
          onChange={(e) => setClipAudio(clip.id, { muted: e.target.checked })} />
      </label>
      <label className="inspector__field">
        <span>Volumen {Math.round(volume * 100)}%</span>
        <input type="range" min={0} max={2} step={0.05} value={volume} disabled={muted}
          onChange={(e) => setClipAudio(clip.id, { volume: Number(e.target.value) })}
          onPointerUp={endGesture} />
      </label>
      <p className="inspector__note">
        {clipGain(clip) === 0 ? 'Este clip está en silencio.' : '100% = volumen original.'}
      </p>
    </>
  );

  // Section titles for mobile header
  const sectionTitle: Record<string, string> = {
    removeBg: 'Quitar fondo',
    speed: 'Velocidad',
    color: 'Color',
    frame: 'Encuadre',
    audio: 'Audio',
  };

  if (!showAll) {
    // Mobile: render only the active section
    const title = sectionTitle[section!] ?? 'Clip';
    let content: React.ReactNode = null;
    if (section === 'removeBg') content = removeBgSection;
    else if (section === 'speed') content = speedSection;
    else if (section === 'color') content = colorSection;
    else if (section === 'frame') content = frameSection;
    else if (section === 'audio') content = audioSection;

    return (
      <aside className="inspector inspector--section">
        <div className="inspector__head">
          <strong>{title}</strong>
        </div>
        {content}
      </aside>
    );
  }

  // Desktop: show all sections
  return (
    <aside className="inspector">
      <div className="inspector__head">
        <strong>Clip</strong>
      </div>
      {removeBgSection}
      <div className="inspector__divider" />
      <div className="inspector__head"><strong>Velocidad</strong></div>
      {speedSection}
      <div className="inspector__divider" />
      {colorSection}
      <div className="inspector__divider" />
      {frameSection}
      <div className="inspector__divider" />
      {audioSection}
    </aside>
  );
}
