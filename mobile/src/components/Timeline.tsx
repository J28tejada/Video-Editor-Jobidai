/**
 * CapCut-style timeline: the playhead is fixed at the center and the tracks
 * scroll under it.
 *
 *  - Playback: a requestAnimationFrame loop reads the playback clock and
 *    scrolls imperatively at the display rate (no React re-render per frame).
 *  - User drag: onScrollBeginDrag marks the gesture as the user's (pausing
 *    playback first), scroll events scrub the preview with fast keyframe
 *    seeks, and the final position gets one exact seek when the scroll settles.
 */
import { Image } from 'expo-image';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { primaryTrack, transitionAfterClip } from '@timeline/project';
import { clipDuration, clipSpeed, type Clip, type Project, type TextOverlay } from '@timeline/types';
import { useEditor } from '../editor/EditorContext';
import { clockPlaying, clockTime } from '../engine/playbackClock';
import { colors, formatTime, PPS, radius } from '../ui/theme';
import { useThumbnails } from './useThumbnails';

const CLIP_H = 56;
const TEXT_H = 28;
const AUDIO_H = 24;
const CUT_SIZE = 20;
const RULER_H = 20;
const HANDLE_W = 14;
const SCRUB_INTERVAL_MS = 50;

export function Timeline() {
  const { project, duration, seek, pause, isPlaying, selection, select } = useEditor();
  const scrollRef = useRef<ScrollView>(null);
  const [viewWidth, setViewWidth] = useState(0);
  const [trimming, setTrimming] = useState(false);

  // Gesture state (refs: read from native scroll callbacks and the rAF loop).
  const dragging = useRef(false);
  const momentum = useRef(false);
  const lastScrub = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  const half = viewWidth / 2;
  const contentWidth = Math.max(duration * PPS, 1);

  // Follow the playback clock whenever the user is not scrolling.
  useEffect(() => {
    let raf = 0;
    let lastX = -1;
    const tick = () => {
      if (!dragging.current && !momentum.current) {
        const x = Math.round(clockTime() * PPS * 2) / 2;
        if (x !== lastX) {
          lastX = x;
          scrollRef.current?.scrollTo({ x, animated: false });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const timeAt = (e: NativeSyntheticEvent<NativeScrollEvent>) =>
    Math.max(0, Math.min(duration, e.nativeEvent.contentOffset.x / PPS));

  const settle = (t: number) => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    seek(t, true);
  };

  const onScrollBeginDrag = () => {
    dragging.current = true;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    if (isPlayingRef.current || clockPlaying()) pause();
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!dragging.current && !momentum.current) return; // programmatic follow
    const now = Date.now();
    if (now - lastScrub.current >= SCRUB_INTERVAL_MS) {
      lastScrub.current = now;
      seek(timeAt(e), false);
    }
  };

  const onScrollEndDrag = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    dragging.current = false;
    const t = timeAt(e);
    // If no momentum phase follows, this is the final position.
    settleTimer.current = setTimeout(() => {
      if (!momentum.current) settle(t);
    }, 80);
  };

  const onMomentumScrollBegin = () => {
    momentum.current = true;
  };

  const onMomentumScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!momentum.current) return;
    momentum.current = false;
    settle(timeAt(e));
  };

  const clips = primaryTrack(project).clips;

  return (
    <View
      style={styles.root}
      onLayout={(e: LayoutChangeEvent) => setViewWidth(e.nativeEvent.layout.width)}
    >
      {viewWidth > 0 && (
        <ScrollView
          ref={scrollRef}
          horizontal
          scrollEnabled={!trimming}
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          decelerationRate="fast"
          onScrollBeginDrag={onScrollBeginDrag}
          onScroll={onScroll}
          onScrollEndDrag={onScrollEndDrag}
          onMomentumScrollBegin={onMomentumScrollBegin}
          onMomentumScrollEnd={onMomentumScrollEnd}
          contentContainerStyle={{ paddingHorizontal: half }}
        >
          <Pressable style={{ width: contentWidth }} onPress={() => select(null)}>
            <Ruler duration={duration} />
            <View style={styles.clipLane}>
              {clips.map((clip) => (
                <ClipBlock
                  key={clip.id}
                  clip={clip}
                  selected={selection?.kind === 'clip' && selection.id === clip.id}
                  onTrimActive={setTrimming}
                />
              ))}
              {clips.slice(0, -1).map((clip) => (
                <CutMarker key={`cut_${clip.id}`} clip={clip} />
              ))}
            </View>
            <TextLane overlays={project.overlays} />
            <AudioLanes project={project} duration={duration} />
          </Pressable>
        </ScrollView>
      )}
      <View pointerEvents="none" style={[styles.playhead, { left: half - 1 }]} />
    </View>
  );
}

function Ruler({ duration }: { duration: number }) {
  const step = PPS >= 48 ? 1 : 2;
  const marks = useMemo(() => {
    const out: number[] = [];
    for (let t = 0; t <= duration + 0.001; t += step) out.push(t);
    return out;
  }, [duration, step]);
  return (
    <View style={styles.ruler}>
      {marks.map((t) => (
        <View key={t} style={[styles.tick, { left: t * PPS }]}>
          {t % (step * 2) === 0 && <Text style={styles.tickLabel}>{formatTime(t).slice(0, -2)}</Text>}
        </View>
      ))}
    </View>
  );
}

function ClipBlock({
  clip,
  selected,
  onTrimActive,
}: {
  clip: Clip;
  selected: boolean;
  onTrimActive: (active: boolean) => void;
}) {
  const { select, trim, resolveUri } = useEditor();
  // Visual-only drag offsets while trimming; the edit is committed on release
  // so the engine rebuilds its composition once, not on every move.
  const [drag, setDrag] = useState({ in: 0, out: 0 });
  const width = Math.max(clipDuration(clip) * PPS, 4);
  const left = clip.startInTimeline * PPS;
  const uri = resolveUri(clip.sourceId);
  const thumbs = useThumbnails(uri, clip.inPoint, clip.outPoint, width, CLIP_H * 0.75);

  const latest = useRef(clip);
  useEffect(() => {
    latest.current = clip;
  }, [clip]);

  const makeHandle = (edge: 'in' | 'out') =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => onTrimActive(true),
      onPanResponderMove: (_, g) => setDrag(edge === 'in' ? { in: g.dx, out: 0 } : { in: 0, out: g.dx }),
      onPanResponderRelease: (_, g) => {
        const c = latest.current;
        const deltaSource = (g.dx / PPS) * clipSpeed(c);
        trim(c.id, edge, (edge === 'in' ? c.inPoint : c.outPoint) + deltaSource);
        setDrag({ in: 0, out: 0 });
        onTrimActive(false);
      },
      onPanResponderTerminate: () => {
        setDrag({ in: 0, out: 0 });
        onTrimActive(false);
      },
    });
  // Handlers read refs only during a touch, never during render; responders
  // must persist across renders to keep their gesture state.
  // eslint-disable-next-line react-hooks/refs
  const [inHandle] = useState(() => makeHandle('in'));
  // eslint-disable-next-line react-hooks/refs
  const [outHandle] = useState(() => makeHandle('out'));

  const visualLeft = left + drag.in;
  const visualWidth = Math.max(8, width - drag.in + drag.out);

  return (
    <Pressable
      onPress={() => select(selected ? null : { kind: 'clip', id: clip.id })}
      style={[
        styles.clip,
        { left: visualLeft, width: visualWidth },
        selected && styles.clipSelected,
      ]}
    >
      <View style={styles.thumbs}>
        {thumbs.map((u, i) =>
          u ? (
            <Image key={i} source={{ uri: u }} style={styles.thumb} contentFit="cover" />
          ) : (
            <View key={i} style={[styles.thumb, styles.thumbEmpty]} />
          ),
        )}
      </View>
      <Text style={styles.clipLabel}>
        {clipDuration(clip).toFixed(1)}s{clipSpeed(clip) !== 1 ? ` · ${clipSpeed(clip)}×` : ''}
      </Text>
      {selected && (
        <>
          <View {...inHandle.panHandlers} style={[styles.handle, { left: 0 }]}>
            <View style={styles.handleGrip} />
          </View>
          <View {...outHandle.panHandlers} style={[styles.handle, { right: 0 }]}>
            <View style={styles.handleGrip} />
          </View>
        </>
      )}
    </Pressable>
  );
}

/** Button on the cut after a clip: adds or opens its transition. */
function CutMarker({ clip }: { clip: Clip }) {
  const { project, selection, openTransitionAfter } = useEditor();
  const tr = transitionAfterClip(project, clip.id);
  const selected = !!tr && selection?.kind === 'transition' && selection.id === tr.id;
  const x = (clip.startInTimeline + clipDuration(clip)) * PPS;
  return (
    <Pressable
      hitSlop={8}
      onPress={() => openTransitionAfter(clip.id)}
      style={[
        styles.cut,
        { left: x - CUT_SIZE / 2 },
        tr && styles.cutActive,
        selected && styles.cutSelected,
      ]}
    >
      <Text style={styles.cutLabel}>{tr ? '⇄' : '+'}</Text>
    </Pressable>
  );
}

function TextLane({ overlays }: { overlays: TextOverlay[] }) {
  const { selection, select } = useEditor();
  return (
    <View style={styles.textLane}>
      {overlays.map((o) => {
        const selected = selection?.kind === 'text' && selection.id === o.id;
        return (
          <Pressable
            key={o.id}
            onPress={() => select(selected ? null : { kind: 'text', id: o.id })}
            style={[
              styles.textBlock,
              { left: o.startSec * PPS, width: Math.max(12, (o.endSec - o.startSec) * PPS) },
              selected && styles.clipSelected,
            ]}
          >
            <Text style={styles.textBlockLabel} numberOfLines={1}>
              T {o.text}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Music and sound-effect lanes (shown only when the project has them). */
function AudioLanes({ project, duration }: { project: Project; duration: number }) {
  const { selection, select } = useEditor();
  const block = (
    kind: 'music' | 'sfx',
    id: string,
    start: number,
    end: number,
    label: string,
    color: string,
  ) => {
    const selected = selection?.kind === kind && selection.id === id;
    return (
      <Pressable
        key={id}
        onPress={() => select(selected ? null : { kind, id })}
        style={[
          styles.audioBlock,
          { left: start * PPS, width: Math.max(10, (end - start) * PPS), backgroundColor: color },
          selected && styles.clipSelected,
        ]}
      >
        <Text style={styles.textBlockLabel} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    );
  };
  return (
    <>
      {project.music.length > 0 && (
        <View style={styles.audioLane}>
          {project.music.map((m) => {
            const end = m.loop ? duration : Math.min(duration, m.startSec + (m.outPoint - m.inPoint));
            const name = project.sources.find((s) => s.id === m.sourceId)?.name ?? 'Música';
            return block('music', m.id, m.startSec, end, `♪ ${name}`, colors.musicClip);
          })}
        </View>
      )}
      {project.sfx.length > 0 && (
        <View style={styles.audioLane}>
          {project.sfx.map((s) => {
            const name = s.synth ?? project.sources.find((x) => x.id === s.sourceId)?.name ?? 'SFX';
            return block('sfx', s.id, s.startSec, s.startSec + s.durationSec, name, colors.sfxClip);
          })}
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: colors.panel, paddingBottom: 8 },
  audioLane: { height: AUDIO_H, marginTop: 4 },
  audioBlock: {
    position: 'absolute',
    top: 0,
    height: AUDIO_H - 2,
    borderRadius: radius.sm,
    justifyContent: 'center',
    paddingHorizontal: 6,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  ruler: { height: RULER_H },
  tick: { position: 'absolute', top: 0, width: 1, height: 6, backgroundColor: colors.border },
  tickLabel: { position: 'absolute', top: 6, left: 3, fontSize: 9, color: colors.textDim },
  clipLane: { height: CLIP_H, marginTop: 4 },
  clip: {
    position: 'absolute',
    top: 0,
    height: CLIP_H,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: colors.clip,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  clipSelected: { borderColor: colors.clipSelected },
  thumbs: { ...StyleSheet.absoluteFill, flexDirection: 'row' },
  thumb: { width: CLIP_H * 0.75, height: '100%' },
  thumbEmpty: { backgroundColor: colors.panelHigh },
  clipLabel: {
    position: 'absolute',
    bottom: 3,
    left: 6,
    fontSize: 10,
    color: '#fff',
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowRadius: 3,
  },
  handle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: HANDLE_W,
    backgroundColor: colors.clipSelected,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleGrip: { width: 3, height: 18, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.5)' },
  textLane: { height: TEXT_H, marginTop: 6 },
  cut: {
    position: 'absolute',
    top: (CLIP_H - CUT_SIZE) / 2,
    width: CUT_SIZE,
    height: CUT_SIZE,
    borderRadius: CUT_SIZE / 2,
    backgroundColor: colors.panelHigh,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cutActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  cutSelected: { borderColor: colors.clipSelected },
  cutLabel: { color: '#fff', fontSize: 11, fontWeight: '800', lineHeight: 13 },
  textBlock: {
    position: 'absolute',
    top: 0,
    height: TEXT_H - 4,
    borderRadius: radius.sm,
    backgroundColor: colors.textClip,
    justifyContent: 'center',
    paddingHorizontal: 6,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  textBlockLabel: { color: '#fff', fontSize: 11, fontWeight: '600' },
  playhead: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: colors.playhead,
    borderRadius: 1,
  },
});
