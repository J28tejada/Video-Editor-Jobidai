/**
 * Inspector for the selected transition: type and duration.
 * Renders nothing when no transition is selected.
 */
import { useMemo } from 'react';
import { Trash2 } from 'lucide-react';
import { useEditor } from '../../state/EditorContext';
import type { TransitionKind } from '../../core/timeline/types';
import { listGlTransitions } from '../../core/compositor/glTransitions';

export function TransitionInspector() {
  const glList = useMemo(() => listGlTransitions(), []);
  const { project, selectedTransitionId, patchTransition, removeSelected } = useEditor();
  const tr = project.transitions.find((t) => t.id === selectedTransitionId);
  if (!tr) return null;

  return (
    <aside className="inspector">
      <div className="inspector__head">
        <strong>Transición</strong>
        <button onClick={removeSelected} title="Quitar transición"><Trash2 size={16} /></button>
      </div>

      <label className="inspector__field inspector__field--inline">
        <span>Tipo</span>
        <select
          value={tr.kind}
          onChange={(e) => patchTransition(tr.id, { kind: e.target.value as TransitionKind })}
        >
          <optgroup label="Básicas">
            <option value="crossfade">Crossfade</option>
            <option value="fade">Fundido a negro</option>
            <option value="slide">Deslizar</option>
            <option value="wipe">Barrido</option>
            <option value="zoom">Zoom</option>
            <option value="blur">Desenfoque</option>
          </optgroup>
          <optgroup label={`GL Transitions (${glList.length})`}>
            {glList.map((g) => (
              <option key={g.name} value={`gl:${g.name}`}>{g.name}</option>
            ))}
          </optgroup>
        </select>
      </label>

      <label className="inspector__field">
        <span>Duración {tr.durationSec.toFixed(2)}s</span>
        <input
          type="range" min={0.1} max={2} step={0.05}
          value={tr.durationSec}
          onChange={(e) => patchTransition(tr.id, { durationSec: Number(e.target.value) })}
        />
      </label>

      <p className="inspector__note">
        La transición está centrada en el corte y se reparte mitad y mitad entre
        los dos clips.
      </p>
    </aside>
  );
}
