import type { WritingSignal } from "./types";

export type PaperRegion = { x: number; y: number; width: number; height: number };

export const defaultPaperRegion: PaperRegion = { x: 0.12, y: 0.18, width: 0.76, height: 0.68 };

export type WritingDetector = {
  start: () => Promise<void>;
  stop: () => void;
  capturePaperImage: (mode?: "full" | "paper") => string | null;
  setRegion: (nextRegion: PaperRegion) => void;
  setFocus: (mode: "auto" | "manual", distance: number) => Promise<void>;
};

export function createWritingDetector(
  video: HTMLVideoElement,
  previewCanvas: HTMLCanvasElement,
  onSignal: (signal: WritingSignal) => void,
  deviceId?: string,
  region: PaperRegion = defaultPaperRegion,
  focusMode: "auto" | "manual" = "auto",
  focusDistance = 0.8
): WritingDetector {
  const previewCtx = previewCanvas.getContext("2d");
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = 160;
  sampleCanvas.height = 120;
  const sampleCtx = sampleCanvas.getContext("2d", { willReadFrequently: true });
  let stream: MediaStream | null = null;
  let previous: Uint8ClampedArray | null = null;
  let timer = 0;
  let lastActiveAt: number | null = null;
  let activeRegion = region;

  async function start() {
    if (!previewCtx || !sampleCtx) throw new Error("Canvas context unavailable");
    stop();
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { min: 1280, ideal: 2560 },
        height: { min: 720, ideal: 1440 },
        frameRate: { ideal: 30, max: 30 }
      },
      audio: false
    });
    await applyBestCameraConstraints(stream, focusMode, focusDistance);
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    resizeCanvasToVideo(previewCanvas, video);
    previous = null;
    tick();
  }

  function tick() {
    if (!previewCtx || !sampleCtx || video.readyState < 2) {
      timer = window.setTimeout(tick, 1000);
      return;
    }

    previewCtx.drawImage(video, 0, 0, previewCanvas.width, previewCanvas.height);
    drawRegion(previewCtx, previewCanvas, activeRegion);

    const sx = video.videoWidth * activeRegion.x;
    const sy = video.videoHeight * activeRegion.y;
    const sw = video.videoWidth * activeRegion.width;
    const sh = video.videoHeight * activeRegion.height;
    sampleCtx.drawImage(video, sx, sy, sw, sh, 0, 0, sampleCanvas.width, sampleCanvas.height);
    const image = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
    const score = previous ? frameDiff(previous, image.data) : 0;
    previous = new Uint8ClampedArray(image.data);
    const active = score > 8;
    if (active) lastActiveAt = Date.now();
    onSignal({ active, motionScore: score, lastActiveAt, calibrated: true });
    timer = window.setTimeout(tick, 1200);
  }

  function stop() {
    window.clearTimeout(timer);
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
  }

  function capturePaperImage(mode: "full" | "paper" = "full") {
    if (!previewCtx || video.readyState < 2) return null;
    const capture = document.createElement("canvas");
    const sourceWidth = video.videoWidth || 1920;
    const sourceHeight = video.videoHeight || 1080;
    const maxWidth = mode === "full" ? 1152 : 900;
    const maxHeight = mode === "full" ? 720 : 700;
    const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
    capture.width = Math.max(1, Math.round(sourceWidth * scale));
    capture.height = Math.max(1, Math.round(sourceHeight * scale));
    const ctx = capture.getContext("2d");
    if (!ctx) return null;
    if (mode === "full") {
      ctx.drawImage(video, 0, 0, sourceWidth, sourceHeight, 0, 0, capture.width, capture.height);
      return capture.toDataURL("image/jpeg", 0.76);
    }
    const sx = sourceWidth * activeRegion.x;
    const sy = sourceHeight * activeRegion.y;
    const sw = sourceWidth * activeRegion.width;
    const sh = sourceHeight * activeRegion.height;
    const cropScale = Math.min(1, maxWidth / sw, maxHeight / sh);
    capture.width = Math.max(1, Math.round(sw * cropScale));
    capture.height = Math.max(1, Math.round(sh * cropScale));
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, capture.width, capture.height);
    return capture.toDataURL("image/jpeg", 0.72);
  }

  function setRegion(nextRegion: PaperRegion) {
    activeRegion = clampRegion(nextRegion);
  }

  async function setFocus(mode: "auto" | "manual", distance: number) {
    const track = stream?.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return;
    await applyFocusConstraints(track, track.getCapabilities(), mode, distance);
  }

  return { start, stop, capturePaperImage, setRegion, setFocus };
}

function clampRegion(region: PaperRegion): PaperRegion {
  const x = Math.min(0.9, Math.max(0, region.x));
  const y = Math.min(0.9, Math.max(0, region.y));
  const width = Math.min(1 - x, Math.max(0.1, region.width));
  const height = Math.min(1 - y, Math.max(0.1, region.height));
  return { x, y, width, height };
}

async function applyBestCameraConstraints(stream: MediaStream, focusMode: "auto" | "manual", focusDistance: number) {
  const track = stream.getVideoTracks()[0];
  if (!track || !track.getCapabilities) return;
  const caps = track.getCapabilities();
  const width = typeof caps.width === "object" ? Math.min(caps.width.max ?? 2560, 2560) : 2560;
  const height = typeof caps.height === "object" ? Math.min(caps.height.max ?? 1440, 1440) : 1440;
  try {
    await track.applyConstraints({
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: 30, max: 30 }
    });
    await applyFocusConstraints(track, caps, focusMode, focusDistance);
  } catch {
    // Keep the browser-selected stream if the device rejects explicit high-res constraints.
  }
}

async function applyFocusConstraints(track: MediaStreamTrack, caps: MediaTrackCapabilities, mode: "auto" | "manual", distanceRatio: number) {
  const extendedCaps = caps as MediaTrackCapabilities & {
    focusMode?: string[];
    focusDistance?: { min?: number; max?: number };
  };
  const modes = extendedCaps.focusMode ?? [];
  const targetMode = mode === "manual" && modes.includes("manual") ? "manual" : modes.includes("continuous") ? "continuous" : modes.includes("auto") ? "auto" : "";
  if (!targetMode) return;
  const constraints: MediaTrackConstraints & {
    advanced?: Array<Record<string, unknown>>;
  } = { advanced: [{ focusMode: targetMode }] };
  const distance = extendedCaps.focusDistance;
  if (targetMode === "manual" && distance && typeof distance.min === "number" && typeof distance.max === "number") {
    const ratio = Math.min(1, Math.max(0, distanceRatio));
    const value = distance.min + (distance.max - distance.min) * ratio;
    constraints.advanced = [{
      focusMode: "manual",
      focusDistance: value
    }];
  }
  try {
    await track.applyConstraints(constraints);
  } catch {
    // Some browsers expose focus capabilities but reject setting them.
  }
}

function resizeCanvasToVideo(canvas: HTMLCanvasElement, video: HTMLVideoElement) {
  const width = video.videoWidth || canvas.width;
  const height = video.videoHeight || canvas.height;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

function frameDiff(previous: Uint8ClampedArray, next: Uint8ClampedArray) {
  let total = 0;
  let count = 0;
  for (let i = 0; i < next.length; i += 16) {
    const dr = Math.abs(previous[i] - next[i]);
    const dg = Math.abs(previous[i + 1] - next[i + 1]);
    const db = Math.abs(previous[i + 2] - next[i + 2]);
    total += (dr + dg + db) / 3;
    count++;
  }
  return total / Math.max(count, 1);
}

function drawRegion(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, region: PaperRegion) {
  const x = canvas.width * region.x;
  const y = canvas.height * region.y;
  const width = canvas.width * region.width;
  const height = canvas.height * region.height;
  ctx.save();
  ctx.fillStyle = "rgba(37, 99, 235, 0.08)";
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = "rgba(15, 23, 42, 0.95)";
  ctx.lineWidth = 8;
  ctx.setLineDash([]);
  ctx.strokeRect(x, y, width, height);
  ctx.strokeStyle = "#facc15";
  ctx.lineWidth = 5;
  ctx.setLineDash([18, 10]);
  ctx.strokeRect(x, y, width, height);
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(250, 204, 21, 0.96)";
  ctx.font = "bold 24px system-ui, sans-serif";
  ctx.fillText("AI 截图框", x + 14, Math.max(34, y + 34));
  ctx.restore();
}
