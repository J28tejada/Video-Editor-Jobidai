import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useEditor } from '../editor/EditorContext';
import { clockTime } from '../engine/playbackClock';
import { Icon } from '../ui/Icon';
import { colors, formatTime } from '../ui/theme';

/** Time display + transport + undo/redo, between preview and timeline. */
export function Transport() {
  const { isPlaying, togglePlay, duration, seek, undo, redo, canUndo, canRedo } = useEditor();

  return (
    <View style={styles.row}>
      <View style={styles.side}>
        <LiveTime />
        <Text style={styles.total}> / {formatTime(duration)}</Text>
      </View>
      <View style={styles.center}>
        <Pressable onPress={() => seek(0, true)} hitSlop={10}>
          <Icon name="start" size={20} />
        </Pressable>
        <Pressable onPress={togglePlay} style={styles.play} disabled={duration <= 0}>
          <Icon name={isPlaying ? 'pause' : 'play'} size={24} color="#fff" />
        </Pressable>
      </View>
      <View style={[styles.side, styles.right]}>
        <Pressable onPress={undo} disabled={!canUndo} hitSlop={10}>
          <Icon name="undo" size={20} color={canUndo ? colors.text : colors.border} />
        </Pressable>
        <Pressable onPress={redo} disabled={!canRedo} hitSlop={10}>
          <Icon name="redo" size={20} color={canRedo ? colors.text : colors.border} />
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Current time, updated from the playback clock without re-rendering React:
 * the text is written straight to the native TextInput every few frames.
 */
function LiveTime() {
  const ref = useRef<TextInput>(null);
  useEffect(() => {
    let raf = 0;
    let last = '';
    const tick = () => {
      const label = formatTime(clockTime());
      if (label !== last) {
        last = label;
        ref.current?.setNativeProps({ text: label });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <TextInput
      ref={ref}
      editable={false}
      defaultValue={formatTime(0)}
      style={styles.time}
      pointerEvents="none"
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: colors.bg,
  },
  side: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  right: { justifyContent: 'flex-end', gap: 22 },
  center: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  play: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  time: {
    color: colors.text,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    padding: 0,
    minWidth: 44,
  },
  total: { color: colors.textDim, fontSize: 13, fontVariant: ['tabular-nums'] },
});
