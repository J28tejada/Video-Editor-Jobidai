/**
 * Inspector for the selected sound effect: volume and timing.
 * Renders nothing when no SFX is selected.
 */
import { Trash2 } from 'lucide-react';
import { useEditor } from '../../state/EditorContext';

export function SfxInspector() {
  const { project, selectedSfxId, patchSfx, removeSelected, endGesture, seek } = useEditor();
  const sfx = project.sfx.find((s) => s.id === selectedSfxId);
  if (!sfx) return null;

  return (
    <aside className="inspector">
      <div className="inspector__head">
        <strong>Efecto de sonido</strong>
        <button onClick={removeSelected} title="Quitar SFX"><Trash2 size={16} /></button>
      </div>

      <p className="inspector__note">{sfx.synth ? `Sintetizado: ${sfx.synth}` : 'Audio importado'}</p>

      <label className="inspector__field">
        <span>Volumen {Math.round(sfx.volume * 100)}%</span>
        <input
          type="range" min={0} max={2} step={0.05}
          value={sfx.volume}
          onChange={(e) => patchSfx(sfx.id, { volume: Number(e.target.value) })}
          onPointerUp={endGesture}
        />
      </label>

      <label className="inspector__field">
        <span>Inicio (s)</span>
        <input
          type="number" min={0} step={0.1}
          value={Math.round(sfx.startSec * 100) / 100}
          onChange={(e) => {
            const start = Math.max(0, Number(e.target.value));
            patchSfx(sfx.id, { startSec: start });
            seek(start);
          }}
        />
      </label>
    </aside>
  );
}
