/**
 * App shell: detects capabilities, wires the editor store, and lays out the
 * toolbar / preview / timeline. Whole-window drag-and-drop imports video files.
 */
import { useEffect, useRef, useState } from 'react';
import { EditorProvider, useEditor } from './state/EditorContext';
import { detectCapabilities, type Capabilities } from './lib/capabilities';
import { Toolbar } from './ui/components/Toolbar';
import { Preview } from './ui/components/Preview';
import { Timeline } from './ui/components/Timeline';
import { OverlayInspector } from './ui/components/OverlayInspector';
import { TransitionInspector } from './ui/components/TransitionInspector';
import { ClipInspector } from './ui/components/ClipInspector';
import { MusicInspector } from './ui/components/MusicInspector';
import { SfxInspector } from './ui/components/SfxInspector';
import { PwaStatus } from './ui/components/PwaStatus';

export default function App() {
  return (
    <EditorProvider>
      <Editor />
    </EditorProvider>
  );
}

function Editor() {
  const editor = useEditor();
  const { importFiles, project } = editor;
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    detectCapabilities(project.width, project.height).then(setCaps);
    // Probe once at startup against the default output size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Keyboard shortcuts ----
  const editorRef = useRef(editor);
  editorRef.current = editor;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable);
      if (typing) return;

      const ed = editorRef.current;
      const mod = e.metaKey || e.ctrlKey;

      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) ed.redo();
        else ed.undo();
        return;
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        ed.redo();
        return;
      }
      if (mod) return; // leave other shortcuts (copy/paste/etc.) alone

      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (ed.duration > 0) ed.togglePlay();
          break;
        case 'c':
        case 'C':
          ed.split();
          break;
        case 'Delete':
        case 'Backspace':
          if (
            ed.selectedClipId ||
            ed.selectedOverlayId ||
            ed.selectedTransitionId ||
            ed.selectedMusicId ||
            ed.selectedSfxId
          ) {
            e.preventDefault();
            ed.removeSelected();
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          ed.seek(Math.max(0, ed.playhead - 1 / ed.project.fps));
          break;
        case 'ArrowRight':
          e.preventDefault();
          ed.seek(Math.min(ed.duration, ed.playhead + 1 / ed.project.fps));
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(
      (f) => f.type.startsWith('video/') || f.type.startsWith('image/'),
    );
    if (files.length) await importFiles(files);
  };

  return (
    <div
      className="app"
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="app__header">
        <h1>Editor de Video Web</h1>
        <span className="app__phase">beta</span>
        <PwaStatus />
      </header>

      {caps?.blockingReason && (
        <div className="banner banner--warn">{caps.blockingReason}</div>
      )}

      <Toolbar codec={caps?.encodableCodec ?? null} />
      <div className="stage">
        <Preview />
        <OverlayInspector />
        <TransitionInspector />
        <ClipInspector />
        <MusicInspector />
        <SfxInspector />
      </div>
      <Timeline />

      {dragging && (
        <div className="dropzone-overlay">Suelta videos o imágenes aquí para importar</div>
      )}
    </div>
  );
}
