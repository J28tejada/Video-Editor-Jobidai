/**
 * Preview stage: the native engine view sized to the project's aspect ratio,
 * with text overlays drawn on top in React Native (the export burns the same
 * texts natively with identical box/padding rules).
 */
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  PanResponder,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import { overlayActiveAt, type TextOverlay } from '@timeline/types';
import { VideoEngineView } from '../../modules/video-engine';
import { useEditor } from '../editor/EditorContext';
import { clockTime, setClockDuration, syncClock } from '../engine/playbackClock';
import { IntentStart } from './IntentStart';
import { colors, radius } from '../ui/theme';

export function Preview() {
  const { project, previewJSON, engineRef, setIsPlaying, duration } = useEditor();
  const [area, setArea] = useState({ w: 0, h: 0 });

  const aspect = project.width / project.height;
  let w = area.w;
  let h = w / aspect;
  if (h > area.h) {
    h = area.h;
    w = h * aspect;
  }

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setArea({ w: width, h: height });
  };

  const empty = project.tracks[0].clips.length === 0;

  return (
    <View style={styles.stage} onLayout={onLayout}>
      {area.w > 0 && (
        <View style={[styles.frame, { width: w, height: h }]}>
          <VideoEngineView
            ref={engineRef}
            style={StyleSheet.absoluteFill}
            composition={previewJSON}
            onReady={(e) => setClockDuration(e.nativeEvent.duration)}
            onTimeUpdate={(e) => syncClock(e.nativeEvent.time, e.nativeEvent.playing)}
            onEnded={() => {
              syncClock(duration, false);
              setIsPlaying(false);
            }}
            onError={(e) => Alert.alert('Error de reproducción', e.nativeEvent.message)}
          />
          <TextLayer width={w} height={h} />
        </View>
      )}
      {empty && (
        <View style={styles.start}>
          <IntentStart />
        </View>
      )}
    </View>
  );
}

/**
 * Texts active at the current time. Polls the playback clock every frame but
 * only re-renders when the set of visible texts changes.
 */
function TextLayer({ width, height }: { width: number; height: number }) {
  const { project, selection } = useEditor();
  const [visibleKey, setVisibleKey] = useState('');
  const overlaysRef = useRef(project.overlays);
  useEffect(() => {
    overlaysRef.current = project.overlays;
  }, [project.overlays]);

  useEffect(() => {
    let raf = 0;
    let lastKey = '';
    const tick = () => {
      const t = clockTime();
      // Include the spoken word so karaoke captions re-render per word only.
      const key = overlaysRef.current
        .filter((o) => overlayActiveAt(o, t))
        .map((o) => `${o.id}:${activeWord(o, t)}`)
        .join('|');
      if (key !== lastKey) {
        lastKey = key;
        setVisibleKey(key);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const active = new Map(
    visibleKey
      .split('|')
      .filter(Boolean)
      .map((entry) => {
        const [id, word] = entry.split(':');
        return [id, Number(word)] as const;
      }),
  );
  const selectedId = selection?.kind === 'text' ? selection.id : null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {project.overlays
        .filter((o) => active.has(o.id) || o.id === selectedId)
        .map((o) => (
          <TextBox
            key={o.id}
            overlay={o}
            width={width}
            height={height}
            selected={o.id === selectedId}
            activeWord={active.get(o.id) ?? -1}
          />
        ))}
    </View>
  );
}

/** One text, laid out like the web compositor: centered box at (x, y). */
function TextBox({
  overlay: o,
  width,
  height,
  selected,
  activeWord,
}: {
  overlay: TextOverlay;
  width: number;
  height: number;
  selected: boolean;
  activeWord: number;
}) {
  const { select, patchText } = useEditor();
  const fontPx = Math.max(1, o.fontSizeNorm * height);
  const padX = fontPx * 0.35;
  const padY = fontPx * 0.25;
  const boxH = fontPx * 1.25 + padY * 2;

  // Drag a text to reposition it (normalized coordinates).
  const sizeRef = useRef({ w: width, h: height });
  const start = useRef({ x: o.xNorm, y: o.yNorm });
  const latest = useRef(o);
  useEffect(() => {
    sizeRef.current = { w: width, h: height };
    latest.current = o;
  });
  // The handlers read refs only while a touch is in progress, never during
  // render; the responder must persist across renders to keep its gesture state.
  // eslint-disable-next-line react-hooks/refs
  const [responder] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) + Math.abs(g.dy) > 4,
      onPanResponderGrant: () => {
        start.current = { x: latest.current.xNorm, y: latest.current.yNorm };
        select({ kind: 'text', id: latest.current.id });
      },
      onPanResponderMove: (_, g) => {
        patchText(latest.current.id, {
          xNorm: clamp01(start.current.x + g.dx / sizeRef.current.w),
          yNorm: clamp01(start.current.y + g.dy / sizeRef.current.h),
        });
      },
    }),
  );

  const cx = o.xNorm * width;
  const rowStyle =
    o.align === 'left'
      ? { left: cx - padX, width, alignItems: 'flex-start' as const }
      : o.align === 'right'
        ? { left: cx + padX - width, width, alignItems: 'flex-end' as const }
        : { left: cx - width / 2, width, alignItems: 'center' as const };

  return (
    <View
      pointerEvents="box-none"
      style={[styles.textRow, rowStyle, { top: o.yNorm * height - boxH / 2, height: boxH }]}
    >
      <View
        {...responder.panHandlers}
        style={[
          {
            paddingHorizontal: padX,
            paddingVertical: padY,
            backgroundColor: o.background ?? 'transparent',
            borderRadius: Math.min(fontPx * 0.2, 16),
          },
          selected && styles.textSelected,
        ]}
      >
        <Text
          style={{
            color: o.color,
            fontSize: fontPx,
            lineHeight: fontPx * 1.25,
            fontWeight: String(o.fontWeight) as '800',
            textShadowColor: o.background ? 'transparent' : 'rgba(0,0,0,0.6)',
            textShadowRadius: fontPx * 0.12,
            textShadowOffset: { width: 0, height: fontPx * 0.04 },
          }}
          numberOfLines={1}
        >
          {o.words?.length
            ? o.words.map((w, i) => (
                <Text key={i} style={i === activeWord ? { color: o.highlightColor ?? '#ffe600' } : undefined}>
                  {i > 0 ? ' ' : ''}
                  {w.text}
                </Text>
              ))
            : o.text}
        </Text>
      </View>
    </View>
  );
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Index of the word being spoken (karaoke), or -1. */
function activeWord(o: TextOverlay, t: number): number {
  if (!o.words?.length) return -1;
  let idx = -1;
  for (let i = 0; i < o.words.length; i++) if (t >= o.words[i].start) idx = i;
  return idx;
}

const styles = StyleSheet.create({
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 8 },
  frame: { backgroundColor: '#000', overflow: 'hidden', borderRadius: radius.sm },
  start: { ...StyleSheet.absoluteFill, backgroundColor: colors.bg, justifyContent: 'center' },
  textRow: { position: 'absolute', justifyContent: 'center' },
  textSelected: { borderWidth: 1.5, borderColor: colors.clipSelected, borderStyle: 'dashed' },
});
