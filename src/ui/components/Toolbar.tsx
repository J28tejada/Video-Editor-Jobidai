/**
 * Top toolbar: import, transport, editing actions, project save/load, export.
 */
import { useRef, useState } from 'react';
import {
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  QUALITY_LOW,
  type Quality,
  type VideoCodec,
} from 'mediabunny';
import { useEditor } from '../../state/EditorContext';
import { exportProject } from '../../core/export/export';
import { SYNTH_SFX } from '../../core/audio/sfx';
import { unlockAudio } from '../../lib/audioContext';

const QUALITY_MAP: Record<string, Quality> = {
  high: QUALITY_HIGH,
  medium: QUALITY_MEDIUM,
  low: QUALITY_LOW,
};

type Props = { codec: VideoCodec | null };

export function Toolbar({ codec }: Props) {
  const {
    project,
    isPlaying,
    togglePlay,
    split,
    removeSelected,
    selectedClipId,
    selectedOverlayId,
    addText,
    importMusic,
    addSfx,
    importSfx,
    setFormat,
    generateCaptions,
    removeSilences,
    undo,
    redo,
    canUndo,
    canRedo,
    importFiles,
    saveProject,
    loadProject,
    newProject,
    duration,
  } = useEditor();

  const importRef = useRef<HTMLInputElement>(null);
  const loadRef = useRef<HTMLInputElement>(null);
  const musicRef = useRef<HTMLInputElement>(null);
  const sfxRef = useRef<HTMLInputElement>(null);
  const [sfxOpen, setSfxOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportShort, setExportShort] = useState<'orig' | '1080' | '720' | '480'>('orig');
  const [exportQuality, setExportQuality] = useState<'high' | 'medium' | 'low'>('high');

  const onImport = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy('Importando…');
    try {
      await importFiles(files);
    } catch (e) {
      alert(`Error al importar: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      if (importRef.current) importRef.current.value = '';
    }
  };

  const onLoadProject = async (file: File | undefined) => {
    if (!file) return;
    setBusy('Cargando proyecto…');
    try {
      await loadProject(file);
    } catch (e) {
      alert(`Error al cargar el proyecto: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      if (loadRef.current) loadRef.current.value = '';
    }
  };

  const onExport = async () => {
    if (!codec) {
      alert('No hay un codec de video codificable disponible en este dispositivo.');
      return;
    }
    if (duration <= 0) {
      alert('La línea de tiempo está vacía.');
      return;
    }
    setExportOpen(false);

    // Resolution is expressed by the short side (1080p/720p/480p), orientation-aware.
    let resolutionHeight: number | undefined;
    if (exportShort !== 'orig') {
      const shortSide = Math.min(project.width, project.height);
      const s = Number(exportShort) / shortSide;
      resolutionHeight = Math.round(project.height * s);
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy('Exportando…');
    setProgress(0);
    try {
      const result = await exportProject(project, {
        codec,
        resolutionHeight,
        quality: QUALITY_MAP[exportQuality],
        signal: ctrl.signal,
        onProgress: setProgress,
      });
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        alert(`Error al exportar: ${(e as Error).message}`);
      }
    } finally {
      setBusy(null);
      abortRef.current = null;
    }
  };

  const [silenceOpen, setSilenceOpen] = useState(false);
  const [thresholdDb, setThresholdDb] = useState(-40);
  const [minSilenceSec, setMinSilenceSec] = useState(0.4);
  const [paddingSec, setPaddingSec] = useState(0.08);

  const onRemoveSilences = async () => {
    setSilenceOpen(false);
    setBusy('Silencios…');
    try {
      const { removedSec, removedCount } = await removeSilences({
        thresholdDb,
        minSilenceSec,
        paddingSec,
      });
      if (removedCount === 0 && removedSec < 0.05) {
        alert('No se detectaron silencios que recortar con estos ajustes.');
      } else {
        alert(`Listo: ${removedCount} corte(s), ${removedSec.toFixed(1)}s de silencio eliminados.`);
      }
    } catch (e) {
      alert(`Error al quitar silencios: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const captionAbortRef = useRef<AbortController | null>(null);
  const [captionMsg, setCaptionMsg] = useState<string | null>(null);
  const [captionLang, setCaptionLang] = useState<string>('spanish');
  const [captionModel, setCaptionModel] = useState<string>('Xenova/whisper-small');

  const onCaptions = async () => {
    const ctrl = new AbortController();
    captionAbortRef.current = ctrl;
    setBusy('Subtítulos…');
    setCaptionMsg('Iniciando…');
    try {
      const count = await generateCaptions({
        language: captionLang === 'auto' ? undefined : captionLang,
        model: captionModel,
        signal: ctrl.signal,
        onProgress: (p) => {
          const pct = p.value != null ? ` ${Math.round(p.value * 100)}%` : '';
          setCaptionMsg((p.message ?? p.stage) + pct);
        },
      });
      setCaptionMsg(null);
      if (count === 0) alert('No se detectó voz en el audio.');
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        alert(`Error al generar subtítulos: ${(e as Error).message}`);
      }
      setCaptionMsg(null);
    } finally {
      setBusy(null);
      captionAbortRef.current = null;
    }
  };

  const exporting = busy === 'Exportando…';
  const captioning = busy === 'Subtítulos…';

  return (
    <div className="toolbar">
      <div className="toolbar__group">
        <button onClick={() => importRef.current?.click()} disabled={!!busy}>
          Importar
        </button>
        <input
          ref={importRef}
          type="file"
          accept="video/*,image/*"
          multiple
          hidden
          onChange={(e) => onImport(e.target.files)}
        />
      </div>

      <div className="toolbar__group">
        <button onClick={undo} disabled={!!busy || !canUndo} title="Deshacer (Cmd+Z)">
          ↶
        </button>
        <button onClick={redo} disabled={!!busy || !canRedo} title="Rehacer (Cmd+Shift+Z)">
          ↷
        </button>
      </div>

      <div className="toolbar__group">
        <button
          onClick={() => { unlockAudio(); togglePlay(); }}
          disabled={!!busy || duration <= 0}
        >
          {isPlaying ? '❚❚ Pausa' : '▶ Reproducir'}
        </button>
        <button onClick={split} disabled={!!busy} title="Cortar en el cursor">
          ✂ Cortar
        </button>
        <button onClick={addText} disabled={!!busy} title="Añadir texto en el cursor">
          T+ Texto
        </button>
        <button onClick={() => musicRef.current?.click()} disabled={!!busy} title="Música de fondo">
          🎵 Música
        </button>
        <input
          ref={musicRef}
          type="file"
          accept="audio/*"
          hidden
          multiple
          onChange={(e) => {
            if (e.target.files?.length) importMusic(e.target.files);
            e.target.value = '';
          }}
        />
        <div className="toolbar__group--silence" style={{ display: 'inline-block' }}>
          <button onClick={() => setSfxOpen((o) => !o)} disabled={!!busy} title="Efectos de sonido en el cursor">
            🔊 SFX
          </button>
          {sfxOpen && (
            <div className="popover">
              <span className="popover__note">Se colocan en el cursor. Cmd+Z para deshacer.</span>
              <div className="inspector__presets">
                {SYNTH_SFX.map((s) => (
                  <button
                    key={s.name}
                    onClick={() => {
                      addSfx(s.name, s.durationSec);
                      setSfxOpen(false);
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <button
                className="popover__apply"
                onClick={() => {
                  setSfxOpen(false);
                  sfxRef.current?.click();
                }}
              >
                Importar SFX…
              </button>
            </div>
          )}
        </div>
        <input
          ref={sfxRef}
          type="file"
          accept="audio/*"
          hidden
          multiple
          onChange={(e) => {
            if (e.target.files?.length) importSfx(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          onClick={removeSelected}
          disabled={!!busy || (!selectedClipId && !selectedOverlayId)}
        >
          🗑 Borrar
        </button>
      </div>

      <div className="toolbar__group toolbar__group--silence">
        <button onClick={() => setSilenceOpen((o) => !o)} disabled={!!busy} title="Detectar y quitar silencios">
          ✂️ Silencios
        </button>
        {silenceOpen && (
          <div className="popover">
            <label className="popover__field">
              <span>Umbral {thresholdDb} dB</span>
              <input type="range" min={-60} max={-20} step={1} value={thresholdDb}
                onChange={(e) => setThresholdDb(Number(e.target.value))} />
            </label>
            <label className="popover__field">
              <span>Cortar pausas ≥ {minSilenceSec.toFixed(2)}s</span>
              <input type="range" min={0.05} max={2} step={0.05} value={minSilenceSec}
                onChange={(e) => setMinSilenceSec(Number(e.target.value))} />
              <small className="popover__hint">Menor = más agresivo (corta pausas cortas)</small>
            </label>
            <label className="popover__field">
              <span>Margen {Math.round(paddingSec * 1000)}ms</span>
              <input type="range" min={0} max={0.3} step={0.01} value={paddingSec}
                onChange={(e) => setPaddingSec(Number(e.target.value))} />
            </label>
            <button className="popover__apply" onClick={onRemoveSilences}>
              Aplicar
            </button>
            <p className="popover__note">Se aplica a la pista base. Puedes deshacer con Cmd+Z.</p>
          </div>
        )}
      </div>

      <div className="toolbar__group">
        <select
          className="toolbar__select"
          value={
            project.width > project.height ? '16:9' : project.width === project.height ? '1:1' : '9:16'
          }
          onChange={(e) => {
            const v = e.target.value;
            if (v === '9:16') setFormat(1080, 1920);
            else if (v === '1:1') setFormat(1080, 1080);
            else setFormat(1920, 1080);
          }}
          disabled={!!busy}
          title="Formato / relación de aspecto"
        >
          <option value="9:16">Vertical 9:16</option>
          <option value="1:1">Cuadrado 1:1</option>
          <option value="16:9">Horizontal 16:9</option>
        </select>
      </div>

      <div className="toolbar__group">
        {captioning ? (
          <>
            <span className="toolbar__progress">{captionMsg}</span>
            <button onClick={() => captionAbortRef.current?.abort()}>Cancelar</button>
          </>
        ) : (
          <>
            <select
              className="toolbar__select"
              value={captionLang}
              onChange={(e) => setCaptionLang(e.target.value)}
              disabled={!!busy}
              title="Idioma del audio"
            >
              <option value="spanish">Español</option>
              <option value="english">English</option>
              <option value="portuguese">Português</option>
              <option value="french">Français</option>
              <option value="italian">Italiano</option>
              <option value="german">Deutsch</option>
              <option value="auto">Auto-detectar</option>
            </select>
            <select
              className="toolbar__select"
              value={captionModel}
              onChange={(e) => setCaptionModel(e.target.value)}
              disabled={!!busy}
              title="Calidad del modelo (más preciso = más pesado)"
            >
              <option value="Xenova/whisper-tiny">Rápido (tiny)</option>
              <option value="Xenova/whisper-base">Equilibrado (base)</option>
              <option value="Xenova/whisper-small">Preciso (small)</option>
            </select>
            <button onClick={onCaptions} disabled={!!busy} title="Transcribir el audio con IA (on-device)">
              ✨ Subtítulos IA
            </button>
          </>
        )}
      </div>

      <div className="toolbar__group">
        <button onClick={saveProject} disabled={!!busy}>
          Guardar proyecto
        </button>
        <button onClick={() => loadRef.current?.click()} disabled={!!busy}>
          Cargar proyecto
        </button>
        <button
          onClick={() => {
            if (confirm('¿Empezar un proyecto nuevo? Se borrará el proyecto guardado y la media.')) {
              void newProject();
            }
          }}
          disabled={!!busy}
          title="Nuevo proyecto (borra lo guardado)"
        >
          Nuevo
        </button>
        <input
          ref={loadRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => onLoadProject(e.target.files?.[0])}
        />
      </div>

      <div className="toolbar__group toolbar__group--right toolbar__group--silence">
        {exporting ? (
          <>
            <span className="toolbar__progress">{Math.round(progress * 100)}%</span>
            <button onClick={() => abortRef.current?.abort()}>Cancelar</button>
          </>
        ) : (
          <button
            className="toolbar__export"
            onClick={() => setExportOpen((o) => !o)}
            disabled={!!busy || !codec}
          >
            ⬇ Exportar MP4
          </button>
        )}
        {exportOpen && !exporting && (
          <div className="popover popover--right">
            <label className="popover__field">
              <span>Resolución</span>
              <select value={exportShort} onChange={(e) => setExportShort(e.target.value as typeof exportShort)}>
                <option value="orig">Original</option>
                <option value="1080">1080p</option>
                <option value="720">720p</option>
                <option value="480">480p</option>
              </select>
            </label>
            <label className="popover__field">
              <span>Calidad</span>
              <select value={exportQuality} onChange={(e) => setExportQuality(e.target.value as typeof exportQuality)}>
                <option value="high">Alta</option>
                <option value="medium">Media</option>
                <option value="low">Baja (archivo pequeño)</option>
              </select>
            </label>
            <button className="popover__apply" onClick={onExport}>
              Exportar
            </button>
          </div>
        )}
      </div>

      {busy && !exporting && <span className="toolbar__busy">{busy}</span>}
    </div>
  );
}
