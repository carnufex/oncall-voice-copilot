import { useEffect, useRef } from "react";

export type OrbState = "idle" | "connecting" | "listening" | "speaking" | "tool" | "ended";

type Palette = {
  /** Specular highlight near the simulated light source (brightest point on the sphere). */
  highlight: string;
  /** Body colour just past the highlight. */
  core: string;
  /** Body colour toward the terminator (far side of the sphere from the light). */
  edge: string;
  /** Warm accent blob offset from the highlight — the "amber kiss" the ElevenLabs orb has. */
  amber: string;
  /** Opacity of the amber accent (painted with normal blending so it reads as a warm tint,
   * not just added brightness that washes out into white). */
  amberAlpha: number;
  /** Soft ambient bloom drawn behind the sphere, beyond its silhouette. */
  rim: string;
  /** Thin rotating arc used only in the "tool" state. */
  ring?: string;
  /** Extra rim-light stroke colour, used for the "listening" teal rim. */
  edgeStroke?: string;
  /** Overall alpha multiplier — idle/ended sit dimmer than an active call. */
  intensity: number;
  /** 0 = full colour, 1 = fully desaturated (grey) — used for "ended". */
  desaturate?: number;
};

const PALETTES: Record<OrbState, Palette> = {
  idle: {
    highlight: "#bfe0ff",
    core: "#3f7fd6",
    edge: "#122544",
    amber: "#ff9d4d",
    amberAlpha: 0.5,
    rim: "rgba(79, 157, 255, 0.16)",
    intensity: 0.62,
  },
  connecting: {
    highlight: "#d8ecff",
    core: "#4f9dff",
    edge: "#16305a",
    amber: "#ffab5c",
    amberAlpha: 0.55,
    rim: "rgba(79, 157, 255, 0.28)",
    intensity: 0.85,
  },
  listening: {
    highlight: "#c9fff2",
    core: "#2dd4bf",
    edge: "#0f3d38",
    amber: "#ffab5c",
    amberAlpha: 0.4,
    rim: "rgba(45, 212, 191, 0.3)",
    edgeStroke: "rgba(45, 212, 191, 0.9)",
    intensity: 0.92,
  },
  speaking: {
    highlight: "#eef6ff",
    core: "#5fa8ff",
    edge: "#183462",
    amber: "#ffb266",
    amberAlpha: 0.6,
    rim: "rgba(79, 157, 255, 0.4)",
    intensity: 1,
  },
  tool: {
    highlight: "#ffe6bf",
    core: "#e0973f",
    edge: "#3a230a",
    amber: "#ffd9a3",
    amberAlpha: 0.5,
    rim: "rgba(240, 169, 66, 0.26)",
    ring: "rgba(240, 169, 66, 0.9)",
    intensity: 0.88,
  },
  ended: {
    highlight: "#b7bcc6",
    core: "#5a6272",
    edge: "#14161b",
    amber: "#8f8f8f",
    amberAlpha: 0.18,
    rim: "rgba(120, 130, 146, 0.12)",
    intensity: 0.5,
    desaturate: 1,
  },
};

function desaturateColor(hex: string, amount: number): string {
  if (amount <= 0) return hex;
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const grey = r * 0.3 + g * 0.59 + b * 0.11;
  const mix = (c: number) => Math.round(c + (grey - c) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/** Builds a small tileable monochrome noise pattern for the sphere's "slightly grainy" surface. */
function buildGrainPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const tile = document.createElement("canvas");
  const n = 64;
  tile.width = n;
  tile.height = n;
  const tctx = tile.getContext("2d");
  if (!tctx) return null;
  const img = tctx.createImageData(n, n);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * 255;
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  tctx.putImageData(img, 0, 0);
  return ctx.createPattern(tile, "repeat");
}

/**
 * Canvas-drawn voice orb — a soft, slightly grainy gradient sphere with slow organic drift,
 * standing in for the ElevenLabs widget orb without pulling in an external animation library.
 * Always renders as a full, clearly-lit sphere (dimmer/slower at idle, never a bare dot).
 * Reads live output volume (~30fps) to drive the speaking scale/glow; every other state
 * animates from time alone. Fully respects prefers-reduced-motion (single static frame,
 * no rAF loop, no rotation).
 */
export function VoiceOrb({ state, getOutputVolume, size = 260 }: { state: OrbState; getOutputVolume?: () => number; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const volumeGetterRef = useRef(getOutputVolume);
  volumeGetterRef.current = getOutputVolume;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rawCtx = canvas.getContext("2d");
    if (!rawCtx) return;
    // Re-bind to a fresh const so its non-null type is captured for the `draw` closure below —
    // TS control-flow narrowing on `rawCtx` doesn't extend into nested function bodies.
    const ctx: CanvasRenderingContext2D = rawCtx;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    const grainPattern = buildGrainPattern(ctx);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let smoothedVolume = 0;
    let lastFrameTime = 0;
    const FRAME_MS = 1000 / 30; // ~30fps volume sampling, per spec

    function draw(tMs: number) {
      const st = stateRef.current;
      const pal = PALETTES[st];
      const cx = size / 2;
      const cy = size / 2;
      const baseR = size * 0.4;

      let volume = 0;
      if (st === "speaking" && volumeGetterRef.current) {
        try {
          volume = volumeGetterRef.current() ?? 0;
        } catch {
          volume = 0;
        }
      }
      smoothedVolume += (volume - smoothedVolume) * 0.35;

      const t = reduceMotion ? 0 : tMs;
      // Idle drifts slowly and dimly; connecting/tool churn faster; speaking tracks the voice.
      const speed = st === "connecting" ? 0.0018 : st === "listening" ? 0.001 : st === "idle" ? 0.00035 : st === "tool" ? 0.0009 : 0.0014;
      const drift = st === "idle" ? size * 0.02 : st === "ended" ? 0 : size * 0.045;
      const breathe = st === "ended" ? 0 : Math.sin(t * speed) * 0.5 + 0.5;
      const scale = st === "speaking" ? 1 + smoothedVolume * 0.34 : st === "connecting" ? 1 + breathe * 0.05 : st === "listening" ? 1 + breathe * 0.03 : st === "idle" ? 1 + breathe * 0.012 : 1;

      const desat = pal.desaturate ?? 0;
      const highlight = desaturateColor(pal.highlight, desat);
      const core = desaturateColor(pal.core, desat);
      const edge = desaturateColor(pal.edge, desat);
      const amberColor = desaturateColor(pal.amber, desat);

      ctx.clearRect(0, 0, size, size);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);

      // Slow swirl of the internal "light source" — sells the organic drift without ever
      // moving the sphere's silhouette or losing its edge.
      const lightX = -baseR * 0.34 + Math.cos(t * speed * 1.15) * drift;
      const lightY = -baseR * 0.36 + Math.sin(t * speed * 0.85 + 1.4) * drift * 0.8;

      // 1. Ambient bloom behind the sphere.
      const glowBoost = st === "speaking" ? 1 + smoothedVolume * 0.9 : 1;
      const rimR = baseR * (1.55 + (glowBoost - 1) * 0.5);
      const rimGrad = ctx.createRadialGradient(0, 0, baseR * 0.6, 0, 0, rimR);
      rimGrad.addColorStop(0, pal.rim);
      rimGrad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalAlpha = pal.intensity * glowBoost;
      ctx.fillStyle = rimGrad;
      ctx.beginPath();
      ctx.arc(0, 0, rimR, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // 2. The sphere body itself: everything below is clipped to a hard circle so it always
      // reads as a solid ball, never a soft unbounded blob.
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, baseR, 0, Math.PI * 2);
      ctx.clip();

      ctx.globalAlpha = pal.intensity;
      const bodyGrad = ctx.createRadialGradient(lightX, lightY, baseR * 0.04, 0, 0, baseR * 1.05);
      bodyGrad.addColorStop(0, highlight);
      bodyGrad.addColorStop(0.42, core);
      bodyGrad.addColorStop(1, edge);
      ctx.fillStyle = bodyGrad;
      ctx.fillRect(-baseR, -baseR, baseR * 2, baseR * 2);

      // 3. Warm amber kiss, offset from the white-blue highlight — the ElevenLabs orb's
      // signature accent. Painted with normal (not additive) blending so it reads as a
      // distinct warm patch instead of just bleaching the highlight toward white.
      const amberAngle = Math.atan2(lightY, lightX) + 0.95;
      const amberDist = baseR * 0.5;
      const amberX = Math.cos(amberAngle) * amberDist;
      const amberY = Math.sin(amberAngle) * amberDist;
      ctx.globalAlpha = pal.intensity * pal.amberAlpha * (1 - desat * 0.6);
      const amberGrad = ctx.createRadialGradient(amberX, amberY, 0, amberX, amberY, baseR * 0.75);
      amberGrad.addColorStop(0, amberColor);
      amberGrad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = amberGrad;
      ctx.fillRect(-baseR, -baseR, baseR * 2, baseR * 2);

      // 4. Subtle grain so the surface isn't a flat gradient.
      if (grainPattern) {
        ctx.globalAlpha = 0.05;
        ctx.globalCompositeOperation = "overlay";
        ctx.fillStyle = grainPattern;
        ctx.fillRect(-baseR, -baseR, baseR * 2, baseR * 2);
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.globalAlpha = 1;
      ctx.restore(); // undo clip

      // 5. Listening: a thin teal rim traces the sphere's silhouette.
      if (pal.edgeStroke) {
        ctx.beginPath();
        ctx.arc(0, 0, baseR - 1, 0, Math.PI * 2);
        ctx.strokeStyle = pal.edgeStroke;
        ctx.lineWidth = 1.6;
        ctx.globalAlpha = 0.8;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      ctx.restore(); // undo scale/translate

      // 6. Tool-running ring: thin rotating arc, drawn outside the scaled sphere transform.
      if (st === "tool" && pal.ring) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(reduceMotion ? 0 : t * 0.0022);
        ctx.beginPath();
        ctx.arc(0, 0, baseR * 1.28, -0.5, 0.75);
        ctx.strokeStyle = pal.ring;
        ctx.lineWidth = 2.2;
        ctx.lineCap = "round";
        ctx.shadowColor = pal.ring;
        ctx.shadowBlur = 10;
        ctx.stroke();
        if (!reduceMotion) {
          ctx.rotate(Math.PI);
          ctx.globalAlpha = 0.5;
          ctx.beginPath();
          ctx.arc(0, 0, baseR * 1.28, -0.3, 0.4);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    if (reduceMotion) {
      draw(0);
      return () => {};
    }

    function loop(t: number) {
      if (t - lastFrameTime >= FRAME_MS) {
        lastFrameTime = t;
        draw(t);
      }
      raf = requestAnimationFrame(loop);
    }
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // Intentionally mount-once: state/volume are read from refs every frame so the loop
    // never restarts (and therefore never desyncs its timers) as props change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  return (
    <div className={`voice-orb voice-orb-${state}`} style={{ width: size, height: size }}>
      <canvas ref={canvasRef} style={{ width: size, height: size, display: "block" }} />
    </div>
  );
}
