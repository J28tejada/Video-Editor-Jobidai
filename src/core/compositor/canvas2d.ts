/**
 * Canvas 2D compositor — Phase 0 default.
 *
 * Draws one source frame per output frame with "contain" fit (letterboxed on
 * a black background) so portrait sources look correct in a 9:16 project and
 * landscape sources are letterboxed rather than stretched.
 */
import type { Compositor, DrawFrameOptions, FrameImage, TextDraw } from './types';

export class Canvas2DCompositor implements Compositor {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly width: number;
  readonly height: number;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

  constructor(width: number, height: number, canvas?: HTMLCanvasElement) {
    this.width = width;
    this.height = height;
    if (canvas) {
      canvas.width = width;
      canvas.height = height;
      this.canvas = canvas;
    } else if (typeof OffscreenCanvas !== 'undefined') {
      this.canvas = new OffscreenCanvas(width, height);
    } else {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      this.canvas = c;
    }
    const ctx = (this.canvas as HTMLCanvasElement).getContext('2d', {
      alpha: false,
    });
    if (!ctx) throw new Error('No se pudo crear el contexto 2D del compositor.');
    this.ctx = ctx as CanvasRenderingContext2D;
  }

  drawFrame(frame: FrameImage | null, opts?: DrawFrameOptions): void {
    const { ctx, width, height } = this;
    const clear = opts?.clear ?? true;
    const alpha = opts?.alpha ?? 1;

    if (clear) {
      ctx.fillStyle = opts?.clearColor ?? '#000';
      ctx.fillRect(0, 0, width, height);
    }
    if (!frame || alpha <= 0) return;

    const fw = intrinsicWidth(frame);
    const fh = intrinsicHeight(frame);
    if (!fw || !fh) return;

    // Fit (contain = letterbox, cover = fill+crop), then apply the optional
    // per-clip transform (scale + center) for zoom/pan.
    const baseScale =
      opts?.fit === 'cover'
        ? Math.max(width / fw, height / fh)
        : Math.min(width / fw, height / fh);
    const t = opts?.transform;
    const scaleMul = t ? t.scale : 1;
    const dw = fw * baseScale * scaleMul;
    const dh = fh * baseScale * scaleMul;
    const cx = (t ? t.xNorm : 0.5) * width;
    const cy = (t ? t.yNorm : 0.5) * height;
    const dx = cx - dw / 2;
    const dy = cy - dh / 2;

    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = Math.min(1, alpha);
    const prevFilter = ctx.filter;
    if (opts?.filter) ctx.filter = opts.filter;
    const clipR = opts?.clipRect;
    if (clipR) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(clipR.x, clipR.y, clipR.w, clipR.h);
      ctx.clip();
    }
    ctx.drawImage(frame, dx, dy, dw, dh);
    if (clipR) ctx.restore();
    ctx.filter = prevFilter;
    ctx.globalAlpha = prevAlpha;
  }

  drawText(draw: TextDraw): void {
    const { ctx, width, height } = this;
    const opacity = draw.opacity ?? 1;
    if (opacity <= 0) return;
    const sc = draw.animScale ?? 1;
    const ox = (draw.offsetXNorm ?? 0) * width;
    const oy = (draw.offsetYNorm ?? 0) * height;
    const cx = draw.xNorm * width;
    const cy = draw.yNorm * height;

    ctx.save();
    ctx.globalAlpha = opacity;
    if (sc !== 1) {
      ctx.translate(cx + ox, cy + oy);
      ctx.scale(sc, sc);
      ctx.translate(-cx, -cy);
    } else if (ox || oy) {
      ctx.translate(ox, oy);
    }
    if (draw.words && draw.words.length > 0) this.drawKaraoke(draw);
    else this.drawPlain(draw);
    ctx.restore();
  }

  private drawPlain(draw: TextDraw): void {
    const { ctx, width, height } = this;
    const fontPx = Math.max(1, draw.fontSizeNorm * height);
    const family = draw.fontFamily ?? 'ui-sans-serif, system-ui, -apple-system, sans-serif';
    ctx.font = `${draw.fontWeight} ${fontPx}px ${family}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = draw.align;

    const cx = draw.xNorm * width;
    const cy = draw.yNorm * height;

    const metrics = ctx.measureText(draw.text);
    const textW = metrics.width;
    const padX = fontPx * 0.35;
    const padY = fontPx * 0.25;

    // Anchor x by alignment.
    let boxLeft: number;
    if (draw.align === 'left') boxLeft = cx - padX;
    else if (draw.align === 'right') boxLeft = cx - textW - padX;
    else boxLeft = cx - textW / 2 - padX;

    if (draw.background) {
      ctx.fillStyle = draw.background;
      const radius = Math.min(fontPx * 0.2, 16);
      roundRect(
        ctx,
        boxLeft,
        cy - fontPx / 2 - padY,
        textW + padX * 2,
        fontPx + padY * 2,
        radius,
      );
      ctx.fill();
    }

    // Glow or subtle legibility shadow.
    if (draw.glow) {
      ctx.shadowColor = draw.glowColor ?? draw.color;
      ctx.shadowBlur = fontPx * 0.5;
      ctx.shadowOffsetY = 0;
    } else if (!draw.background) {
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = fontPx * 0.12;
      ctx.shadowOffsetY = fontPx * 0.04;
    }
    // Outline.
    if (draw.strokeColor && draw.strokeWidthNorm) {
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = draw.strokeWidthNorm * fontPx;
      ctx.strokeStyle = draw.strokeColor;
      ctx.strokeText(draw.text, cx, cy);
    }
    ctx.fillStyle = draw.color;
    ctx.fillText(draw.text, cx, cy);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }

  /** Render a caption line word-by-word, highlighting the active word. */
  private drawKaraoke(draw: TextDraw): void {
    const { ctx, width, height } = this;
    const words = draw.words ?? [];
    const fontPx = Math.max(1, draw.fontSizeNorm * height);
    const family = draw.fontFamily ?? 'ui-sans-serif, system-ui, -apple-system, sans-serif';
    ctx.font = `${draw.fontWeight} ${fontPx}px ${family}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    const space = ctx.measureText(' ').width;
    const widths = words.map((w) => ctx.measureText(w.text).width);
    const total = widths.reduce((a, b) => a + b, 0) + space * Math.max(0, words.length - 1);

    const cx = draw.xNorm * width;
    const cy = draw.yNorm * height;
    const padX = fontPx * 0.35;
    const padY = fontPx * 0.25;

    let startX: number;
    if (draw.align === 'left') startX = cx;
    else if (draw.align === 'right') startX = cx - total;
    else startX = cx - total / 2;

    // Whole-line background box.
    if (draw.background) {
      ctx.fillStyle = draw.background;
      roundRect(
        ctx,
        startX - padX,
        cy - fontPx / 2 - padY,
        total + padX * 2,
        fontPx + padY * 2,
        Math.min(fontPx * 0.2, 16),
      );
      ctx.fill();
    }

    const active = draw.activeWordIndex ?? -1;
    const highlight = draw.highlightColor ?? '#ffe600';

    const hasStroke = !!(draw.strokeColor && draw.strokeWidthNorm);
    if (hasStroke) {
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = (draw.strokeWidthNorm as number) * fontPx;
      ctx.strokeStyle = draw.strokeColor as string;
    }

    let x = startX;
    for (let i = 0; i < words.length; i++) {
      const isActive = i === active;
      const color = isActive ? highlight : draw.color;
      if (draw.glow) {
        ctx.shadowColor = draw.glowColor ?? color;
        ctx.shadowBlur = fontPx * 0.5;
        ctx.shadowOffsetY = 0;
      } else if (!draw.background) {
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = fontPx * 0.12;
        ctx.shadowOffsetY = fontPx * 0.04;
      }
      if (hasStroke) ctx.strokeText(words[i].text, x, cy);
      ctx.fillStyle = color;
      ctx.fillText(words[i].text, x, cy);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      x += widths[i] + space;
    }
  }

  dispose(): void {
    // Canvas 2D has no explicit GPU resources to free; the canvas is GC'd.
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function intrinsicWidth(frame: FrameImage): number {
  // videoWidth first: an <video>'s `.width` reflects the HTML attribute (0 by
  // default), while `.videoWidth` is the decoded frame size. `||` (not `??`)
  // so the 0-valued attribute falls through to the real dimension.
  const f = frame as { width?: number; videoWidth?: number };
  return f.videoWidth || f.width || 0;
}
function intrinsicHeight(frame: FrameImage): number {
  const f = frame as { height?: number; videoHeight?: number };
  return f.videoHeight || f.height || 0;
}
