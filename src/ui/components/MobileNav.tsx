/**
 * Mobile-only bottom navigation + transport controls (CapCut style).
 * Hidden on desktop via CSS. Replaces the desktop Toolbar for touch devices.
 */
import { useRef, useState, useEffect } from 'react';
import {
  Scissors, Music, Type, Sparkles, Download,
  Undo2, Redo2, Play, Pause, Plus,
  Trash2, Volume2, FolderOpen, X,
  Gauge, Palette, LayoutTemplate, Mic,
} from 'lucide-react';
import { useEditor } from '../../state/EditorContext';
import { useClipSection, type ClipSection } from '../../state/ClipSectionContext';
import { exportProject } from '../../core/export/export';
import { SYNTH_SFX } from '../../core/audio/sfx';
import { unlockAudio } from '../../lib/audioContext';
import { QUALITY_HIGH, type VideoCodec } from 'mediabunny';

type Tab = 'edit' | 'audio' | 'text' | 'effects' | 'export';

const TABS: { id: Tab; icon: React.ReactNode; label: string }[] = [
  { id: 'edit',    icon: <Scissors size={20} />,  label: 'Editar' },
  { id: 'audio',   icon: <Music size={20} />,      label: 'Audio' },
  { id: 'text',    icon: <Type size={20} />,        label: 'Texto' },
  { id: 'effects', icon: <Sparkles size={20} />,   label: 'Efectos' },
  { id: 'export',  icon: <Download size={20} />,   label: 'Exportar' },
];

// Clip section definitions shown when a clip is selected
const CLIP_SECTIONS: { id: ClipSection; icon: React.ReactNode; label: string }[] = [
  { id: 'removeBg', icon: <Scissors size={18} />, label: 'Fondo IA' },
  { id: 'speed',    icon: <Gauge size={18} />,    label: 'Velocidad' },
  { id: 'color',    icon: <Palette size={18} />,  label: 'Color' },
  { id: 'frame',    icon: <LayoutTemplate size={18} />, label: 'Encuadre' },
  { id: 'audio',    icon: <Mic size={18} />,      label: 'Audio' },
];

export function MobileNav({ codec }: { codec: VideoCodec | null }) {
  const [activeTab, setActiveTab] = useState<Tab>('edit');
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const musicRef = useRef<HTMLInputElement>(null);
  const sfxRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const { section, setSection } = useClipSection();

  const {
    isPlaying, togglePlay, duration, playhead,
    split, removeSelected, selectedClipId, selectedOverlayId,
    selectedMusicId, selectedSfxId, selectedTransitionId,
    addText, importMusic, addSfx, importSfx, importFiles,
    undo, redo, canUndo, canRedo,
    project,
    removeSilences,
  } = useEditor();

  // Reset section when clip is deselected
  useEffect(() => {
    if (!selectedClipId) setSection(null);
  }, [selectedClipId, setSection]);

  const handlePlay = () => {
    unlockAudio();
    togglePlay();
  };

  const handleExport = async () => {
    if (!codec) { alert('No hay codec disponible en este dispositivo.'); return; }
    if (duration <= 0) { alert('La línea de tiempo está vacía.'); return; }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setIsExporting(true);
    setExportProgress(0);
    try {
      const result = await exportProject(project, {
        codec,
        quality: QUALITY_HIGH,
        signal: ctrl.signal,
        onProgress: setExportProgress,
      });
      const url = URL.createObjectURL(result.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') alert(`Error: ${(e as Error).message}`);
    } finally {
      setIsExporting(false);
      abortRef.current = null;
    }
  };

  const anySelected =
    !!selectedClipId || !!selectedOverlayId ||
    !!selectedMusicId || !!selectedSfxId || !!selectedTransitionId;

  const fmt = (s: number) => {
    const t = Math.max(0, s);
    const m = Math.floor(t / 60);
    return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`;
  };

  return (
    <div className="mnav">
      {/* ── Transport ── */}
      <div className="mnav__transport">
        <button className="mnav__tbtn" onClick={undo} disabled={!canUndo} title="Deshacer">
          <Undo2 size={18} />
        </button>
        <div className="mnav__times">
          <span>{fmt(playhead)}</span>
          <span className="mnav__times-sep">/</span>
          <span>{fmt(duration)}</span>
        </div>
        <button
          className={`mnav__play${isPlaying ? ' mnav__play--pause' : ''}`}
          onClick={handlePlay}
          disabled={duration <= 0}
          aria-label={isPlaying ? 'Pausa' : 'Reproducir'}
        >
          {isPlaying ? <Pause size={22} /> : <Play size={22} />}
        </button>
        <button className="mnav__tbtn" onClick={redo} disabled={!canRedo} title="Rehacer">
          <Redo2 size={18} />
        </button>
        <button
          className="mnav__tbtn"
          onClick={() => importRef.current?.click()}
          title="Importar video/imagen"
        >
          <Plus size={18} />
        </button>
      </div>

      {/* ── Contextual tool strip ── */}
      <div className="mnav__tools">
        {/* When clip selected: show clip-section chips + edit actions */}
        {selectedClipId && activeTab === 'edit' ? (
          <>
            <MBtn icon={<Scissors size={20} />} label="Cortar" onClick={split} />
            <MBtn icon={<Trash2 size={20} />} label="Borrar" onClick={removeSelected} />
            <div className="mnav__sep" />
            {CLIP_SECTIONS.map(({ id, icon, label }) => (
              <MBtn
                key={id}
                icon={icon}
                label={label}
                onClick={() => setSection(section === id ? null : id)}
                active={section === id}
              />
            ))}
          </>
        ) : activeTab === 'edit' ? (
          <>
            <MBtn icon={<Scissors size={20} />} label="Cortar" onClick={split} />
            <MBtn icon={<Trash2 size={20} />} label="Borrar" onClick={removeSelected} disabled={!anySelected} />
          </>
        ) : null}

        {activeTab === 'audio' && (
          <>
            <MBtn icon={<Music size={20} />} label="Música" onClick={() => musicRef.current?.click()} />
            {SYNTH_SFX.map((s) => (
              <MBtn key={s.name} icon={<Volume2 size={20} />} label={s.label} onClick={() => addSfx(s.name, s.durationSec)} />
            ))}
            <MBtn icon={<FolderOpen size={20} />} label="SFX" onClick={() => sfxRef.current?.click()} />
          </>
        )}

        {activeTab === 'text' && (
          <MBtn icon={<Type size={20} />} label="Añadir texto" onClick={addText} />
        )}

        {activeTab === 'effects' && (
          <MBtn
            icon={<Scissors size={20} />}
            label="Quitar silencios"
            onClick={async () => {
              try {
                const r = await removeSilences({ thresholdDb: -40, minSilenceSec: 0.4, paddingSec: 0.08 });
                if (r.removedCount === 0) alert('No se detectaron silencios.');
                else alert(`${r.removedCount} corte(s), ${r.removedSec.toFixed(1)}s eliminados.`);
              } catch (e) {
                alert(`Error: ${(e as Error).message}`);
              }
            }}
          />
        )}

        {activeTab === 'export' && (
          isExporting ? (
            <>
              <span className="mnav__progress">{Math.round(exportProgress * 100)}%</span>
              <MBtn icon={<X size={20} />} label="Cancelar" onClick={() => abortRef.current?.abort()} />
            </>
          ) : (
            <MBtn icon={<Download size={20} />} label="Exportar MP4" onClick={handleExport} disabled={!codec} accent />
          )
        )}
      </div>

      {/* ── Bottom tab bar ── */}
      <nav className="mnav__tabs">
        {TABS.map(({ id, icon, label }) => (
          <button
            key={id}
            className={`mnav__tab${activeTab === id ? ' mnav__tab--active' : ''}`}
            onClick={() => setActiveTab(id)}
          >
            <span className="mnav__tab-icon">{icon}</span>
            <span className="mnav__tab-label">{label}</span>
          </button>
        ))}
      </nav>

      {/* Hidden file inputs */}
      <input ref={importRef} type="file" accept="video/*,image/*" hidden multiple
        onChange={(e) => { if (e.target.files?.length) void importFiles(e.target.files); e.target.value = ''; }} />
      <input ref={musicRef} type="file" accept="audio/*" hidden multiple
        onChange={(e) => { if (e.target.files?.length) importMusic(e.target.files); e.target.value = ''; }} />
      <input ref={sfxRef} type="file" accept="audio/*" hidden multiple
        onChange={(e) => { if (e.target.files?.length) importSfx(e.target.files); e.target.value = ''; }} />
    </div>
  );
}

function MBtn({
  icon, label, onClick, disabled, accent, active,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  accent?: boolean;
  active?: boolean;
}) {
  return (
    <button
      className={`mnav__tool-btn${accent ? ' mnav__tool-btn--accent' : ''}${active ? ' mnav__tool-btn--active' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="mnav__tool-icon">{icon}</span>
      <span className="mnav__tool-label">{label}</span>
    </button>
  );
}
