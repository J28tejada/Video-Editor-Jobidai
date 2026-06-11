/**
 * Inspector for the selected text overlay: content, position, style, timing.
 *
 * For auto-caption overlays, a "Aplicar a todos los subtítulos" toggle (on by
 * default, persisted) makes STYLE edits (position, size, color, background,
 * highlight, weight, alignment) propagate to every caption at once. Content and
 * timing always affect only the selected overlay.
 *
 * Renders nothing when no overlay is selected.
 */
import { useState } from 'react';
import { useEditor } from '../../state/EditorContext';
import type { TextOverlay } from '../../core/timeline/types';
import type { AnimType } from '../../core/timeline/anim';

/** One-click caption styles (TikTok-like). Applied to all captions when the
 * "apply to all" toggle is on. */
const CAPTION_PRESETS: [string, Partial<TextOverlay>][] = [
  ['Clásico', { color: '#ffffff', background: 'rgba(0,0,0,0.55)', fontWeight: 800, highlightColor: '#ffe600', strokeColor: null, strokeWidthNorm: 0, glow: false }],
  ['TikTok', { color: '#ffffff', background: null, fontWeight: 900, highlightColor: '#39E508', strokeColor: '#000000', strokeWidthNorm: 0.14, glow: false }],
  ['Contorno', { color: '#ffffff', background: null, fontWeight: 800, highlightColor: '#ffe600', strokeColor: '#000000', strokeWidthNorm: 0.09, glow: false }],
  ['Caja', { color: '#ffffff', background: 'rgba(0,0,0,0.85)', fontWeight: 700, highlightColor: '#ffffff', strokeColor: null, strokeWidthNorm: 0, glow: false }],
  ['Neón', { color: '#ffffff', background: null, fontWeight: 800, highlightColor: '#39E508', glow: true, glowColor: '#39E508', strokeColor: null, strokeWidthNorm: 0 }],
];

export const ANIM_OPTIONS: [AnimType, string][] = [
  ['none', 'Ninguna'],
  ['fade', 'Fundido'],
  ['pop', 'Pop'],
  ['slideUp', 'Subir'],
  ['slideDown', 'Bajar'],
  ['slideLeft', 'Izquierda'],
  ['slideRight', 'Derecha'],
];

export function OverlayInspector() {
  const { project, selectedOverlayId, patchOverlay, patchAllCaptions, removeSelected, seek } =
    useEditor();
  const [applyAll, setApplyAll] = useState(
    () => localStorage.getItem('captionApplyAll') !== '0',
  );

  const overlay = project.overlays.find((o) => o.id === selectedOverlayId);
  if (!overlay) return null;

  const isCaption = !!overlay.isCaption;
  const animDur = overlay.enter?.durationSec ?? overlay.exit?.durationSec ?? 0.3;
  // Style edits: all captions (when enabled) or just this one.
  const pStyle = (patch: Partial<TextOverlay>) =>
    isCaption && applyAll ? patchAllCaptions(patch) : patchOverlay(overlay.id, patch);
  // Content/timing edits: always only this overlay.
  const pOne = (patch: Partial<TextOverlay>) => patchOverlay(overlay.id, patch);

  const toggleApplyAll = (v: boolean) => {
    setApplyAll(v);
    localStorage.setItem('captionApplyAll', v ? '1' : '0');
  };

  return (
    <aside className="inspector">
      <div className="inspector__head">
        <strong>{isCaption ? 'Subtítulo' : 'Texto'}</strong>
        <button onClick={removeSelected} title="Borrar overlay">🗑</button>
      </div>

      {isCaption && (
        <>
          <label className="inspector__field inspector__field--inline inspector__applyall">
            <span>Aplicar estilo a todos los subtítulos</span>
            <input
              type="checkbox"
              checked={applyAll}
              onChange={(e) => toggleApplyAll(e.target.checked)}
            />
          </label>
          <label className="inspector__field">
            <span>Estilo</span>
            <div className="inspector__presets">
              {CAPTION_PRESETS.map(([name, style]) => (
                <button key={name} onClick={() => pStyle(style)} title={name}>
                  {name}
                </button>
              ))}
            </div>
          </label>
        </>
      )}

      <label className="inspector__field">
        <span>Contenido</span>
        <textarea
          rows={2}
          value={overlay.text}
          onChange={(e) => {
            const text = e.target.value;
            // Captions render word-by-word (karaoke), so rebuild the word list
            // from the edited text (timings spread across the caption span).
            if (isCaption && overlay.words) {
              pOne({ text, words: rebuildWords(text, overlay.startSec, overlay.endSec) });
            } else {
              pOne({ text });
            }
          }}
        />
      </label>

      <div className="inspector__row">
        <label className="inspector__field">
          <span>X {Math.round(overlay.xNorm * 100)}%</span>
          <input
            type="range" min={0} max={1} step={0.01}
            value={overlay.xNorm}
            onChange={(e) => pStyle({ xNorm: Number(e.target.value) })}
          />
        </label>
        <label className="inspector__field">
          <span>Y {Math.round(overlay.yNorm * 100)}%</span>
          <input
            type="range" min={0} max={1} step={0.01}
            value={overlay.yNorm}
            onChange={(e) => pStyle({ yNorm: Number(e.target.value) })}
          />
        </label>
      </div>

      <label className="inspector__field">
        <span>Tamaño {Math.round(overlay.fontSizeNorm * 100)}%</span>
        <input
          type="range" min={0.02} max={0.2} step={0.005}
          value={overlay.fontSizeNorm}
          onChange={(e) => pStyle({ fontSizeNorm: Number(e.target.value) })}
        />
      </label>

      <div className="inspector__row">
        <label className="inspector__field inspector__field--inline">
          <span>Color</span>
          <input type="color" value={overlay.color} onChange={(e) => pStyle({ color: e.target.value })} />
        </label>
        <label className="inspector__field inspector__field--inline">
          <span>Fondo</span>
          <input
            type="checkbox"
            checked={!!overlay.background}
            onChange={(e) => pStyle({ background: e.target.checked ? 'rgba(0,0,0,0.5)' : null })}
          />
        </label>
        {overlay.words && overlay.words.length > 0 && (
          <label className="inspector__field inspector__field--inline">
            <span>Resalte</span>
            <input
              type="color"
              value={overlay.highlightColor ?? '#ffe600'}
              onChange={(e) => pStyle({ highlightColor: e.target.value })}
            />
          </label>
        )}
        <label className="inspector__field inspector__field--inline">
          <span>Peso</span>
          <select value={overlay.fontWeight} onChange={(e) => pStyle({ fontWeight: Number(e.target.value) })}>
            <option value={400}>Normal</option>
            <option value={600}>Semi</option>
            <option value={800}>Bold</option>
            <option value={900}>Black</option>
          </select>
        </label>
      </div>

      <label className="inspector__field inspector__field--inline">
        <span>Alineación</span>
        <select
          value={overlay.align}
          onChange={(e) => pStyle({ align: e.target.value as 'left' | 'center' | 'right' })}
        >
          <option value="left">Izquierda</option>
          <option value="center">Centro</option>
          <option value="right">Derecha</option>
        </select>
      </label>

      <div className="inspector__row">
        <label className="inspector__field">
          <span>Entrada</span>
          <select
            value={overlay.enter?.type ?? 'none'}
            onChange={(e) =>
              pStyle({ enter: { type: e.target.value as AnimType, durationSec: animDur } })
            }
          >
            {ANIM_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
        <label className="inspector__field">
          <span>Salida</span>
          <select
            value={overlay.exit?.type ?? 'none'}
            onChange={(e) =>
              pStyle({ exit: { type: e.target.value as AnimType, durationSec: animDur } })
            }
          >
            {ANIM_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="inspector__field">
        <span>Duración anim. {animDur.toFixed(2)}s</span>
        <input
          type="range" min={0.1} max={1.5} step={0.05}
          value={animDur}
          onChange={(e) => {
            const d = Number(e.target.value);
            pStyle({
              enter: { type: overlay.enter?.type ?? 'fade', durationSec: d },
              exit: { type: overlay.exit?.type ?? 'none', durationSec: d },
            });
          }}
        />
      </label>

      <div className="inspector__row">
        <label className="inspector__field">
          <span>Inicio (s)</span>
          <input
            type="number" min={0} step={0.1}
            value={round2(overlay.startSec)}
            onChange={(e) => {
              const start = Math.max(0, Number(e.target.value));
              pOne({ startSec: start, endSec: Math.max(start + 0.1, overlay.endSec) });
              seek(start);
            }}
          />
        </label>
        <label className="inspector__field">
          <span>Fin (s)</span>
          <input
            type="number" min={0} step={0.1}
            value={round2(overlay.endSec)}
            onChange={(e) => pOne({ endSec: Math.max(overlay.startSec + 0.1, Number(e.target.value)) })}
          />
        </label>
      </div>
    </aside>
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Rebuild karaoke word timings for an edited caption, spread over its span. */
function rebuildWords(
  text: string,
  startSec: number,
  endSec: number,
): { text: string; start: number; end: number }[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const span = Math.max(0.001, endSec - startSec);
  const per = span / tokens.length;
  return tokens.map((t, i) => ({
    text: t,
    start: startSec + i * per,
    end: startSec + (i + 1) * per,
  }));
}
