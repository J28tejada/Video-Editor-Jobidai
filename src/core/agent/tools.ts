/**
 * Tools the editing agent can call. Plain JSON-schema objects (no SDK types),
 * shared by the backend (sent to Claude) and the app (validated + executed).
 *
 * Times are timeline seconds unless the name says "source". Ids come from the
 * project description the app sends with every request.
 */
export type ToolDef = {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

const ids = (what: string) => ({
  type: 'array',
  items: { type: 'string' },
  description: `${what} ids, or ["all"] for every one.`,
});
const seconds = (what: string) => ({ type: 'number', minimum: 0, description: what });

const TEXT_STYLE = {
  position: { type: 'string', enum: ['top', 'center', 'bottom'] },
  size: { type: 'string', enum: ['s', 'm', 'l', 'xl'] },
  color: { type: 'string', description: 'CSS color, e.g. "#ffffff" or "#facc15".' },
  background: { type: 'string', enum: ['none', 'dark', 'light'] },
};

export const AGENT_TOOLS: ToolDef[] = [
  {
    name: 'split_at',
    description: 'Cut the base-track clip under a timeline time into two clips.',
    input_schema: {
      type: 'object',
      properties: { time: seconds('Timeline time of the cut.') },
      required: ['time'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_range',
    description:
      'Remove a span of the timeline (base track), closing the gap. Use it to cut out bad takes, pauses or unwanted moments.',
    input_schema: {
      type: 'object',
      properties: { start: seconds('Span start.'), end: seconds('Span end.') },
      required: ['start', 'end'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_clip',
    description: 'Delete a whole clip from the timeline.',
    input_schema: {
      type: 'object',
      properties: { clip_id: { type: 'string' } },
      required: ['clip_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'trim_clip',
    description:
      "Change which part of the source a clip shows. in_point/out_point are SOURCE seconds (see the clip's source range).",
    input_schema: {
      type: 'object',
      properties: {
        clip_id: { type: 'string' },
        in_point: seconds('New source in-point.'),
        out_point: seconds('New source out-point.'),
      },
      required: ['clip_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'move_clip',
    description: 'Reorder a base-track clip to a new position (0 = first).',
    input_schema: {
      type: 'object',
      properties: { clip_id: { type: 'string' }, to_index: { type: 'integer', minimum: 0 } },
      required: ['clip_id', 'to_index'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_speed',
    description: 'Set constant playback speed (0.25–4). Changes the clip length on the timeline.',
    input_schema: {
      type: 'object',
      properties: { clip_ids: ids('Clip'), speed: { type: 'number', minimum: 0.25, maximum: 4 } },
      required: ['clip_ids', 'speed'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_volume',
    description: "Set the clips' own audio volume (0 = mute, 1 = original, up to 2).",
    input_schema: {
      type: 'object',
      properties: { clip_ids: ids('Clip'), volume: { type: 'number', minimum: 0, maximum: 2 } },
      required: ['clip_ids', 'volume'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_look',
    description:
      'Color look. Either a preset or individual adjustments (1 = neutral for brightness/contrast/saturation; warmth 0..0.5).',
    input_schema: {
      type: 'object',
      properties: {
        clip_ids: ids('Clip'),
        preset: { type: 'string', enum: ['none', 'vivid', 'warm', 'cool', 'bw', 'cinematic'] },
        brightness: { type: 'number', minimum: 0.5, maximum: 1.5 },
        contrast: { type: 'number', minimum: 0.5, maximum: 1.6 },
        saturation: { type: 'number', minimum: 0, maximum: 2 },
        warmth: { type: 'number', minimum: 0, maximum: 0.5 },
      },
      required: ['clip_ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_framing',
    description:
      'How clips fill the frame: fit "contain" (whole image, bars) or "cover" (fill, crop); zoom 1–3 and the focus point (0..1, 0.5 = center).',
    input_schema: {
      type: 'object',
      properties: {
        clip_ids: ids('Clip'),
        fit: { type: 'string', enum: ['contain', 'cover'] },
        zoom: { type: 'number', minimum: 1, maximum: 3 },
        focus_x: { type: 'number', minimum: 0, maximum: 1 },
        focus_y: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['clip_ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_transition',
    description:
      'Transition on the cut after each given clip ("none" removes it). Use clip ids of the clip BEFORE the cut.',
    input_schema: {
      type: 'object',
      properties: {
        after_clip_ids: ids('Clip'),
        kind: { type: 'string', enum: ['none', 'crossfade', 'fade', 'slide'] },
        duration: { type: 'number', minimum: 0.1, maximum: 2 },
      },
      required: ['after_clip_ids', 'kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_text',
    description: 'Add a text overlay (titles, labels, calls to action).',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        start: seconds('When it appears.'),
        end: seconds('When it disappears.'),
        ...TEXT_STYLE,
      },
      required: ['text', 'start', 'end'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_text',
    description: 'Change a text overlay (only the given fields).',
    input_schema: {
      type: 'object',
      properties: {
        text_id: { type: 'string' },
        text: { type: 'string' },
        start: seconds('When it appears.'),
        end: seconds('When it disappears.'),
        ...TEXT_STYLE,
      },
      required: ['text_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_texts',
    description: 'Delete text overlays (including captions).',
    input_schema: {
      type: 'object',
      properties: { text_ids: ids('Text') },
      required: ['text_ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'style_captions',
    description: 'Restyle every auto-caption at once.',
    input_schema: {
      type: 'object',
      properties: { ...TEXT_STYLE, highlight_color: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'set_music',
    description:
      'Adjust background music: volume 0..1, fades in seconds, duck = lower it under speech, loop = repeat to the end, start = timeline position.',
    input_schema: {
      type: 'object',
      properties: {
        music_ids: ids('Music'),
        volume: { type: 'number', minimum: 0, maximum: 1 },
        fade_in: { type: 'number', minimum: 0, maximum: 10 },
        fade_out: { type: 'number', minimum: 0, maximum: 10 },
        duck: { type: 'boolean' },
        loop: { type: 'boolean' },
        start: seconds('Timeline start.'),
      },
      required: ['music_ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_music',
    description: 'Remove background music tracks.',
    input_schema: {
      type: 'object',
      properties: { music_ids: ids('Music') },
      required: ['music_ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_sound_effect',
    description: 'Add a built-in sound effect at a time (whoosh/swoosh for transitions, pop/ding/click for emphasis, riser/boom for reveals).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: ['whoosh', 'swoosh', 'pop', 'ding', 'click', 'riser', 'boom'] },
        time: seconds('Timeline time.'),
        volume: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['name', 'time'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_format',
    description: 'Output aspect ratio: 9:16 (Reels/TikTok/Shorts), 1:1, 4:5 (feed) or 16:9 (YouTube).',
    input_schema: {
      type: 'object',
      properties: { aspect: { type: 'string', enum: ['9:16', '1:1', '4:5', '16:9'] } },
      required: ['aspect'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_captions',
    description:
      'Transcribe the speech on the phone and replace the auto-captions. Slow (seconds to minutes); call it once, after cuts are final.',
    input_schema: {
      type: 'object',
      properties: { language: { type: 'string', enum: ['es', 'en', 'pt', 'auto'] } },
      required: ['language'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_silences',
    description: 'Detect pauses in the clips\' audio and cut them out (jump cuts).',
    input_schema: {
      type: 'object',
      properties: { intensity: { type: 'string', enum: ['soft', 'normal', 'strong'] } },
      required: ['intensity'],
      additionalProperties: false,
    },
  },
];

/** Tools the app runs asynchronously on the device (not pure project edits). */
export const DEVICE_TOOLS = new Set(['generate_captions', 'remove_silences']);
