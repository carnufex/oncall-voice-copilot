import { useEffect, useRef } from "react";

export type OrbState = "idle" | "connecting" | "listening" | "speaking" | "tool" | "ended";

type RGB = [number, number, number];

// ---------- Auros palette (see docs/SPEC.md — "abyssal, bioluminescent, water-like") ----------
const TEAL: RGB = [0, 130, 124]; // deep bioluminescent teal — unlit / back of the sphere
const CYAN: RGB = [203, 255, 252]; // bioluminescent gradient end / aurora gradient start
const MIST: RGB = [237, 255, 254]; // aurora gradient 26% stop
const NEAR_WHITE: RGB = [255, 253, 250]; // aurora gradient 48% stop — brightest lit point
const LAVENDER: RGB = [250, 209, 255]; // aurora gradient 89% stop / lavender phosphor rim accent

// Brightness ramp a single dot travels along as it turns toward the light / the viewer:
// deep teal -> cyan -> mist -> near-white. The lavender rim accent is mixed in separately,
// keyed off how edge-on ("limb") a dot is, not off brightness.
const BRIGHTNESS_STOPS: Array<[number, RGB]> = [
  [0, TEAL],
  [0.5, CYAN],
  [0.78, MIST],
  [1, NEAR_WHITE],
];

function sampleBrightness(t: number): RGB {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 0; i < BRIGHTNESS_STOPS.length - 1; i++) {
    const [t0, c0] = BRIGHTNESS_STOPS[i]!;
    const [t1, c1] = BRIGHTNESS_STOPS[i + 1]!;
    if (c <= t1 || i === BRIGHTNESS_STOPS.length - 2) {
      const localT = t1 === t0 ? 0 : (c - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * localT, c0[1] + (c1[1] - c0[1]) * localT, c0[2] + (c1[2] - c0[2]) * localT];
    }
  }
  return NEAR_WHITE;
}

function mixRGB(a: RGB, b: RGB, t: number): RGB {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return [a[0] + (b[0] - a[0]) * c, a[1] + (b[1] - a[1]) * c, a[2] + (b[2] - a[2]) * c];
}

function desaturateRGB(c: RGB, amount: number): RGB {
  if (amount <= 0) return c;
  const grey = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
  const mix = (v: number) => v + (grey - v) * amount;
  return [mix(c[0]), mix(c[1]), mix(c[2])];
}

// ---------- Per-state motion & mood config ----------
type StateConfig = {
  /** Sphere spin, radians/ms. */
  rotSpeed: number;
  /** Overall alpha multiplier — idle/ended sit dimmer than an active call. */
  intensity: number;
  /** How strongly the limb (silhouette edge) picks up the lavender phosphor accent. */
  rim: number;
  /** 0 = full colour, 1 = fully desaturated (grey-teal) — used for "ended". */
  desaturate: number;
  /** Ambient bloom / inner glow tint. */
  glow: RGB;
};

const STATE_CONFIG: Record<OrbState, StateConfig> = {
  idle: { rotSpeed: 0.00011, intensity: 0.48, rim: 0.5, desaturate: 0, glow: [0, 130, 124] },
  connecting: { rotSpeed: 0.00026, intensity: 0.74, rim: 0.65, desaturate: 0, glow: [30, 165, 158] },
  listening: { rotSpeed: 0.0002, intensity: 0.95, rim: 1.2, desaturate: 0, glow: [70, 214, 199] },
  speaking: { rotSpeed: 0.00024, intensity: 1, rim: 0.85, desaturate: 0, glow: [130, 236, 226] },
  tool: { rotSpeed: 0.00052, intensity: 0.86, rim: 0.7, desaturate: 0, glow: [150, 170, 210] },
  ended: { rotSpeed: 0.00004, intensity: 0.34, rim: 0.22, desaturate: 0.88, glow: [80, 92, 94] },
};

const POINT_COUNT = 2400;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const TILT = 0.44; // fixed tilt of the rotation axis, radians (~25deg)
const CAM_FACTOR = 2.7; // camera distance as a multiple of the sphere's screen radius
const DRIFT_MAG = 0.018; // "current" drift — subtle per-dot radius jitter for the liquid feel
const DRIFT_FREQ = 0.0011;

/**
 * Builds the static per-point layout: Fibonacci-lattice positions on the unit sphere plus a
 * random phase used for the slow per-dot "current" drift. Computed once per mount.
 */
function buildLattice(n: number) {
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const phase = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const yy = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - yy * yy));
    const theta = GOLDEN_ANGLE * i;
    x[i] = Math.cos(theta) * r;
    y[i] = yy;
    z[i] = Math.sin(theta) * r;
    phase[i] = Math.random() * Math.PI * 2;
  }
  return { x, y, z, phase };
}

/**
 * Canvas-drawn 3D particle sphere in the "Auros" style — thousands of small dots on a
 * Fibonacci lattice, rotated on a tilted axis and perspective-projected, coloured from deep
 * teal through cyan to white on the lit/near side with a lavender-pink phosphor accent
 * picked up at the silhouette edge. No external library.
 *
 * Reads live output volume (~30fps) to drive the "speaking" surge; every other state
 * animates from time alone. Fully respects prefers-reduced-motion (single static frame, no
 * rAF loop, no rotation).
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

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const { x: baseX, y: baseY, z: baseZ, phase } = buildLattice(POINT_COUNT);
    // Scratch buffers reused every frame to avoid GC churn: rotated+drifted unit-sphere
    // coordinates, and a depth-sort index (painter's algorithm — back dots drawn first).
    const rx = new Float32Array(POINT_COUNT);
    const ry = new Float32Array(POINT_COUNT);
    const rz = new Float32Array(POINT_COUNT);
    const order = new Int32Array(POINT_COUNT);
    for (let i = 0; i < POINT_COUNT; i++) order[i] = i;

    let raf = 0;
    let smoothedVolume = 0;
    let lastFrameTime = 0;
    const FRAME_MS = 1000 / 30; // ~30fps, per spec — also caps total per-frame work

    function draw(tMs: number) {
      const st = stateRef.current;
      const cfg = STATE_CONFIG[st];
      const cx = size / 2;
      const cy = size / 2;
      const t = reduceMotion ? 0 : tMs;

      let volume = 0;
      if (st === "speaking" && volumeGetterRef.current) {
        try {
          volume = volumeGetterRef.current() ?? 0;
        } catch {
          volume = 0;
        }
      }
      smoothedVolume += (volume - smoothedVolume) * 0.35;

      // ---- Per-state breathing / surge on the sphere's overall scale ----
      let scale = 1;
      if (st === "connecting") scale = 1 + Math.sin(t * 0.0022) * 0.045;
      else if (st === "listening") scale = 1 + Math.sin(t * 0.0012) * 0.012;
      else if (st === "idle") scale = 1 + Math.sin(t * 0.0006) * 0.01;
      else if (st === "speaking") scale = 1 + smoothedVolume * 0.32;

      const baseR = size * 0.36 * scale;
      const camD = baseR * CAM_FACTOR;

      const intensity = st === "speaking" ? cfg.intensity * Math.min(1.35, 0.82 + smoothedVolume * 0.62) : cfg.intensity;

      // ---- Rotation: spin around a tilted axis ----
      const angle = reduceMotion ? 0.5 : t * cfg.rotSpeed;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const cosT = Math.cos(TILT);
      const sinT = Math.sin(TILT);

      // Slowly orbiting light source — sells the organic shimmer across the surface.
      const lightAngle = t * 0.00015;
      let lx = Math.cos(lightAngle) * 0.6;
      let ly = 0.38;
      let lz = Math.sin(lightAngle) * 0.55 + 0.45;
      const lLen = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
      lx /= lLen;
      ly /= lLen;
      lz /= lLen;

      ctx.clearRect(0, 0, size, size);

      // 1. Ambient bloom behind the sphere — soft, unbounded, water-like.
      const bloomR = baseR * (1.6 + (intensity - cfg.intensity) * 0.4);
      const [gr, gg, gb] = desaturateRGB(cfg.glow, cfg.desaturate);
      const bloomGrad = ctx.createRadialGradient(cx, cy, baseR * 0.55, cx, cy, bloomR);
      bloomGrad.addColorStop(0, `rgba(${gr | 0}, ${gg | 0}, ${gb | 0}, ${0.22 * intensity})`);
      bloomGrad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = bloomGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, bloomR, 0, Math.PI * 2);
      ctx.fill();

      // 2. Faint inner volumetric glow, clipped to the sphere's silhouette, so it reads as a
      // solid, lit-from-within body rather than a hollow point cloud.
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
      ctx.clip();
      const innerGrad = ctx.createRadialGradient(cx - baseR * 0.15, cy - baseR * 0.2, 0, cx, cy, baseR * 1.05);
      innerGrad.addColorStop(0, `rgba(${gr | 0}, ${gg | 0}, ${gb | 0}, ${0.16 * intensity})`);
      innerGrad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = innerGrad;
      ctx.fillRect(cx - baseR, cy - baseR, baseR * 2, baseR * 2);
      ctx.restore();

      // 3. Transform every point: spin around Y, tilt around X, then a slow per-dot radial
      // "current" drift so the surface never looks perfectly rigid.
      for (let i = 0; i < POINT_COUNT; i++) {
        const x0 = baseX[i]!;
        const y0 = baseY[i]!;
        const z0 = baseZ[i]!;

        // Spin (around Y axis).
        const x1 = x0 * cosA + z0 * sinA;
        const z1 = -x0 * sinA + z0 * cosA;

        // Tilt (around X axis) — fixed viewing angle onto the spin axis.
        const y2 = y0 * cosT - z1 * sinT;
        const z2 = y0 * sinT + z1 * cosT;

        const drift = reduceMotion ? 1 : 1 + Math.sin(t * DRIFT_FREQ + phase[i]!) * DRIFT_MAG;
        rx[i] = x1 * drift;
        ry[i] = y2 * drift;
        rz[i] = z2 * drift;
      }

      // 4. Depth-sort (painter's algorithm: back dots first, front dots last/on top).
      order.sort((a, b) => rz[a]! - rz[b]!);

      // 5. Project + draw. Front dots are brighter/larger; back dots fade toward the deep
      // teal and shrink. Limb (edge-on) dots pick up the lavender phosphor accent.
      for (let k = 0; k < POINT_COUNT; k++) {
        const i = order[k]!;
        const dx = rx[i]!;
        const dy = ry[i]!;
        const dz = rz[i]!;

        const wz = dz * baseR;
        const persp = camD / (camD - wz);
        const sx = cx + dx * baseR * persp;
        const sy = cy + dy * baseR * persp;

        const depthT = Math.min(1, Math.max(0, (dz + 1) / 2));
        const litDot = Math.min(1, Math.max(0, dx * lx + dy * ly + dz * lz));
        const brightness = Math.min(1, depthT * 0.6 + litDot * 0.55);
        const rimFactor = Math.pow(Math.max(0, 1 - Math.abs(dz)), 5);

        let [r, g, b] = mixRGB(sampleBrightness(brightness), LAVENDER, rimFactor * cfg.rim * 0.9);
        [r, g, b] = desaturateRGB([r, g, b], cfg.desaturate);

        const alpha = (0.05 + 0.95 * depthT) * intensity;
        if (alpha <= 0.012) continue; // skip near-invisible back dots — cheap frame-cost cap

        const dotHalf = (0.35 + 1.55 * depthT) * persp * 0.5;
        ctx.fillStyle = `rgba(${r | 0}, ${g | 0}, ${b | 0}, ${alpha.toFixed(3)})`;
        ctx.fillRect(sx - dotHalf, sy - dotHalf, dotHalf * 2, dotHalf * 2);
      }

      // 6. State-specific overlays.
      if (st === "listening") {
        const period = 2000;
        const ringT = (t % period) / period;
        ctx.beginPath();
        ctx.arc(cx, cy, baseR * (1 + ringT * 0.55), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(203, 255, 252, ${(0.4 * (1 - ringT)).toFixed(3)})`;
        ctx.lineWidth = 1.4;
        ctx.stroke();
      } else if (st === "connecting") {
        const period = 1400;
        const ringT = (t % period) / period;
        ctx.beginPath();
        ctx.arc(cx, cy, baseR * (1 + ringT * 0.5), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(130, 220, 210, ${(0.32 * (1 - ringT)).toFixed(3)})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      } else if (st === "tool") {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(reduceMotion ? 0 : t * 0.0026);
        ctx.beginPath();
        ctx.arc(0, 0, baseR * 1.24, -0.5, 0.75);
        ctx.strokeStyle = "rgba(250, 209, 255, 0.85)";
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.shadowColor = "rgba(250, 209, 255, 0.6)";
        ctx.shadowBlur = 9;
        ctx.stroke();
        if (!reduceMotion) {
          ctx.rotate(Math.PI);
          ctx.globalAlpha = 0.45;
          ctx.beginPath();
          ctx.arc(0, 0, baseR * 1.24, -0.3, 0.4);
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
