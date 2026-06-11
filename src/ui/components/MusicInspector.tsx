/**
 * Inspector for the selected background-music item: volume, fades, loop, ducking.
 * Renders nothing when no music item is selected.
 */
import { useEditor } from '../../state/EditorContext';

export function MusicInspector() {
  const { project, selectedMusicId, patchMusic, removeSelected, endGesture } = useEditor();
  const m = project.music.find((x) => x.id === selectedMusicId);
  if (!m) return null;

  const p = (patch: Parameters<typeof patchMusic>[1]) => patchMusic(m.id, patch);

  return (
    <aside className="inspector">
      <div className="inspector__head">
        <strong>Música</strong>
        <button onClick={removeSelected} title="Quitar música">🗑</button>
      </div>

      <label className="inspector__field">
        <span>Volumen {Math.round(m.volume * 100)}%</span>
        <input
          type="range" min={0} max={1} step={0.01}
          value={m.volume}
          onChange={(e) => p({ volume: Number(e.target.value) })}
          onPointerUp={endGesture}
        />
      </label>

      <div className="inspector__row">
        <label className="inspector__field">
          <span>Fade in {m.fadeInSec.toFixed(1)}s</span>
          <input
            type="range" min={0} max={5} step={0.1}
            value={m.fadeInSec}
            onChange={(e) => p({ fadeInSec: Number(e.target.value) })}
            onPointerUp={endGesture}
          />
        </label>
        <label className="inspector__field">
          <span>Fade out {m.fadeOutSec.toFixed(1)}s</span>
          <input
            type="range" min={0} max={5} step={0.1}
            value={m.fadeOutSec}
            onChange={(e) => p({ fadeOutSec: Number(e.target.value) })}
            onPointerUp={endGesture}
          />
        </label>
      </div>

      <label className="inspector__field inspector__field--inline">
        <span>Repetir (loop)</span>
        <input type="checkbox" checked={m.loop} onChange={(e) => p({ loop: e.target.checked })} />
      </label>

      <label className="inspector__field inspector__field--inline">
        <span>Bajar con la voz (ducking)</span>
        <input type="checkbox" checked={m.duck} onChange={(e) => p({ duck: e.target.checked })} />
      </label>

      {m.duck && (
        <label className="inspector__field">
          <span>Nivel con voz {Math.round(m.duckLevel * 100)}%</span>
          <input
            type="range" min={0} max={1} step={0.05}
            value={m.duckLevel}
            onChange={(e) => p({ duckLevel: Number(e.target.value) })}
            onPointerUp={endGesture}
          />
        </label>
      )}

      <p className="inspector__note">
        El ducking baja la música automáticamente cuando hay voz en el video.
      </p>
    </aside>
  );
}
