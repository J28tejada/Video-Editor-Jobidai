import { SymbolView, type SymbolViewProps } from 'expo-symbols';

import { colors } from './theme';

/** Icon names mapped to SF Symbols (iOS) and Material Symbols (Android). */
const ICONS = {
  play: { ios: 'play.fill', android: 'play_arrow' },
  pause: { ios: 'pause.fill', android: 'pause' },
  undo: { ios: 'arrow.uturn.backward', android: 'undo' },
  redo: { ios: 'arrow.uturn.forward', android: 'redo' },
  add: { ios: 'plus', android: 'add' },
  import: { ios: 'photo.on.rectangle', android: 'video_library' },
  split: { ios: 'scissors', android: 'content_cut' },
  delete: { ios: 'trash', android: 'delete' },
  speed: { ios: 'speedometer', android: 'speed' },
  volume: { ios: 'speaker.wave.2', android: 'volume_up' },
  fit: { ios: 'crop', android: 'crop' },
  text: { ios: 'textformat', android: 'title' },
  format: { ios: 'aspectratio', android: 'aspect_ratio' },
  export: { ios: 'square.and.arrow.up', android: 'ios_share' },
  close: { ios: 'xmark', android: 'close' },
  edit: { ios: 'pencil', android: 'edit' },
  more: { ios: 'ellipsis', android: 'more_horiz' },
  start: { ios: 'backward.end.fill', android: 'skip_previous' },
  music: { ios: 'music.note', android: 'music_note' },
  sfx: { ios: 'waveform', android: 'graphic_eq' },
  toPlayhead: { ios: 'arrow.right.to.line', android: 'keyboard_tab' },
  filters: { ios: 'camera.filters', android: 'filter_vintage' },
  zoom: { ios: 'plus.magnifyingglass', android: 'zoom_in' },
  transition: { ios: 'square.split.2x1', android: 'compare' },
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 22,
  color = colors.text,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  return (
    <SymbolView
      name={ICONS[name] as SymbolViewProps['name']}
      size={size}
      tintColor={color}
      style={{ width: size, height: size }}
    />
  );
}
