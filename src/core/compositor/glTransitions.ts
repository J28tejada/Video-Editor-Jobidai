/**
 * WebGL renderer for GL Transitions (https://gl-transitions.com), the open
 * collection of GLSL transition shaders. Each transition blends two frames
 * (from/to) by a `progress` uniform. We run the selected shader on an offscreen
 * WebGL canvas and hand the result back to the Canvas 2D compositor.
 *
 * Only used for transition kinds prefixed `gl:` — the built-in crossfade/fade/
 * slide/wipe/zoom/blur stay on the Canvas 2D path.
 */
import glTransitionsRaw from 'gl-transitions';

type GLTransition = {
  name: string;
  glsl: string;
  defaultParams: Record<string, number | number[] | boolean>;
  paramsTypes: Record<string, string>;
  license: string;
  author: string;
};

const ALL = glTransitionsRaw as unknown as GLTransition[];

// Permissive license + no extra image/sampler params (we can't supply those).
const USABLE = ALL.filter(
  (t) =>
    /MIT/i.test(t.license) &&
    !Object.values(t.paramsTypes).some((ty) => ty === 'sampler2D'),
);

export type GlTransitionInfo = { name: string; author: string };

/** List of usable GL transitions (name + author), sorted by name. */
export function listGlTransitions(): GlTransitionInfo[] {
  return USABLE.map((t) => ({ name: t.name, author: t.author })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

// ---- WebGL machinery ----

let gl: WebGLRenderingContext | null = null;
let glCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
const programs = new Map<string, WebGLProgram | null>();
let quadBuffer: WebGLBuffer | null = null;
let texFrom: WebGLTexture | null = null;
let texTo: WebGLTexture | null = null;

// Scratch 2D canvases to pre-fit each frame to the output size (contain).
let scratchA: HTMLCanvasElement | OffscreenCanvas | null = null;
let scratchB: HTMLCanvasElement | OffscreenCanvas | null = null;

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function ensureGl(w: number, h: number): WebGLRenderingContext | null {
  if (!glCanvas) glCanvas = makeCanvas(w, h);
  if (glCanvas.width !== w || glCanvas.height !== h) {
    glCanvas.width = w;
    glCanvas.height = h;
  }
  if (!gl) {
    gl = (glCanvas as HTMLCanvasElement).getContext('webgl', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    }) as WebGLRenderingContext | null;
    if (!gl) return null;
    quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    texFrom = gl.createTexture();
    texTo = gl.createTexture();
  }
  gl.viewport(0, 0, w, h);
  return gl;
}

const VERT = `
attribute vec2 position;
varying vec2 _uv;
void main() {
  _uv = (position + 1.0) / 2.0;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

function fragmentFor(t: GLTransition): string {
  return `
precision highp float;
varying vec2 _uv;
uniform sampler2D from, to;
uniform float progress, ratio;
vec4 getFromColor(vec2 uv) { return texture2D(from, uv); }
vec4 getToColor(vec2 uv) { return texture2D(to, uv); }
${t.glsl}
void main() {
  gl_FragColor = transition(_uv);
}`;
}

function compile(g: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = g.createShader(type);
  if (!sh) return null;
  g.shaderSource(sh, src);
  g.compileShader(sh);
  if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
    console.warn('GL transition shader error:', g.getShaderInfoLog(sh));
    g.deleteShader(sh);
    return null;
  }
  return sh;
}

function getProgram(g: WebGLRenderingContext, t: GLTransition): WebGLProgram | null {
  if (programs.has(t.name)) return programs.get(t.name) ?? null;
  const vs = compile(g, g.VERTEX_SHADER, VERT);
  const fs = compile(g, g.FRAGMENT_SHADER, fragmentFor(t));
  let program: WebGLProgram | null = null;
  if (vs && fs) {
    program = g.createProgram();
    if (program) {
      g.attachShader(program, vs);
      g.attachShader(program, fs);
      g.linkProgram(program);
      if (!g.getProgramParameter(program, g.LINK_STATUS)) {
        console.warn('GL transition link error:', g.getProgramInfoLog(program));
        program = null;
      }
    }
  }
  programs.set(t.name, program);
  return program;
}

function uploadTexture(
  g: WebGLRenderingContext,
  tex: WebGLTexture,
  unit: number,
  source: CanvasImageSource,
): void {
  g.activeTexture(g.TEXTURE0 + unit);
  g.bindTexture(g.TEXTURE_2D, tex);
  g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, true);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, source as TexImageSource);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
}

function setDefaultParams(g: WebGLRenderingContext, program: WebGLProgram, t: GLTransition): void {
  for (const [key, type] of Object.entries(t.paramsTypes)) {
    const loc = g.getUniformLocation(program, key);
    if (!loc) continue;
    const v = t.defaultParams[key];
    switch (type) {
      case 'float':
        g.uniform1f(loc, Number(v ?? 0));
        break;
      case 'int':
        g.uniform1i(loc, Number(v ?? 0));
        break;
      case 'bool':
        g.uniform1i(loc, v ? 1 : 0);
        break;
      case 'vec2':
        g.uniform2fv(loc, (v as number[]) ?? [0, 0]);
        break;
      case 'vec3':
        g.uniform3fv(loc, (v as number[]) ?? [0, 0, 0]);
        break;
      case 'vec4':
        g.uniform4fv(loc, (v as number[]) ?? [0, 0, 0, 0]);
        break;
    }
  }
}

function drawContain(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  frame: CanvasImageSource | null,
  w: number,
  h: number,
): void {
  const ctx = (canvas as HTMLCanvasElement).getContext('2d') as
    | CanvasRenderingContext2D
    | null;
  if (!ctx) return;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (!frame) return;
  const fw = (frame as { width?: number; videoWidth?: number }).width ?? 0;
  const fh = (frame as { height?: number; videoHeight?: number }).height ?? 0;
  if (!fw || !fh) return;
  const s = Math.min(w / fw, h / fh);
  const dw = fw * s;
  const dh = fh * s;
  ctx.drawImage(frame, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/**
 * Render a GL transition between two frames at `progress`. Returns the WebGL
 * canvas (project-sized) to be drawn by the compositor, or null on failure.
 */
export function renderGlTransition(
  name: string,
  from: CanvasImageSource | null,
  to: CanvasImageSource | null,
  progress: number,
  w: number,
  h: number,
): HTMLCanvasElement | OffscreenCanvas | null {
  const t = USABLE.find((x) => x.name === name);
  if (!t) return null;
  const g = ensureGl(w, h);
  if (!g || !texFrom || !texTo || !quadBuffer || !glCanvas) return null;

  const program = getProgram(g, t);
  if (!program) return null;

  // Pre-fit frames to the output size so aspect ratios are correct.
  if (!scratchA || scratchA.width !== w || scratchA.height !== h) scratchA = makeCanvas(w, h);
  if (!scratchB || scratchB.width !== w || scratchB.height !== h) scratchB = makeCanvas(w, h);
  drawContain(scratchA, from, w, h);
  drawContain(scratchB, to, w, h);

  g.useProgram(program);

  const posLoc = g.getAttribLocation(program, 'position');
  g.bindBuffer(g.ARRAY_BUFFER, quadBuffer);
  g.enableVertexAttribArray(posLoc);
  g.vertexAttribPointer(posLoc, 2, g.FLOAT, false, 0, 0);

  uploadTexture(g, texFrom, 0, scratchA);
  uploadTexture(g, texTo, 1, scratchB);
  g.uniform1i(g.getUniformLocation(program, 'from'), 0);
  g.uniform1i(g.getUniformLocation(program, 'to'), 1);
  g.uniform1f(g.getUniformLocation(program, 'progress'), progress);
  g.uniform1f(g.getUniformLocation(program, 'ratio'), w / h);
  setDefaultParams(g, program, t);

  g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
  return glCanvas;
}
