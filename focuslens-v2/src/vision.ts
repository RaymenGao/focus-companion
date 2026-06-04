import type { FrontSignal } from "./types";

declare global {
  interface Window {
    FaceMesh?: new (options: { locateFile: (file: string) => string }) => {
      setOptions: (options: Record<string, unknown>) => void;
      onResults: (callback: (results: FaceMeshResults) => void) => void;
      send: (input: { image: HTMLVideoElement }) => Promise<void>;
    };
  }
}

type Landmark = { x: number; y: number; z?: number };
type FaceMeshResults = { image: CanvasImageSource; multiFaceLandmarks?: Landmark[][] };

export type FaceTracker = {
  start: () => Promise<void>;
  stop: () => void;
};

export type VisionThresholds = {
  up: number;
  down: number;
  yaw: number;
  gaze: number;
};

export const defaultVisionThresholds: VisionThresholds = {
  up: 0.25,
  down: 0.5,
  yaw: 0.22,
  gaze: 0.18
};

export function createFaceTracker(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  onSignal: (signal: FrontSignal) => void,
  deviceId?: string,
  getThresholds: () => VisionThresholds = () => defaultVisionThresholds
): FaceTracker {
  const ctx = canvas.getContext("2d");
  let stream: MediaStream | null = null;
  let running = false;
  let frameTimer = 0;

  async function start() {
    if (!ctx) throw new Error("Canvas context unavailable");
    if (!window.FaceMesh) throw new Error("MediaPipe FaceMesh 未加载，请检查网络。");

    stop();
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    resizeCanvasToVideo(canvas, video);

    const faceMesh = new window.FaceMesh({
      locateFile: (file) => `https://fastly.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });
    faceMesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    faceMesh.onResults((results) => drawAndClassify(results, ctx, canvas, onSignal, getThresholds()));

    running = true;
    const loop = async () => {
      if (!running) return;
      if (video.readyState >= 2) {
        await faceMesh.send({ image: video });
      }
      frameTimer = window.setTimeout(loop, 120);
    };
    loop();
  }

  function stop() {
    running = false;
    window.clearTimeout(frameTimer);
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
  }

  return { start, stop };
}

function resizeCanvasToVideo(canvas: HTMLCanvasElement, video: HTMLVideoElement) {
  const width = video.videoWidth || canvas.width;
  const height = video.videoHeight || canvas.height;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

function drawAndClassify(
  results: FaceMeshResults,
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  onSignal: (signal: FrontSignal) => void,
  thresholds: VisionThresholds
) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);
  ctx.restore();

  const face = results.multiFaceLandmarks?.[0];
  if (!face) {
    onSignal({
      state: "DISTRACTED",
      reason: "未检测到孩子在座位上",
      pitchRatio: null,
      yawRatio: null,
      gazeRatio: null,
      paperFocused: false,
      absent: true
    });
    return;
  }

  const nose = face[1];
  const leftEye = face[33];
  const rightEye = face[263];
  const faceWidth = Math.abs(rightEye.x - leftEye.x);
  const eyeCenterX = (leftEye.x + rightEye.x) / 2;
  const yawRatio = (nose.x - eyeCenterX) / faceWidth;
  const eyeCenterY = (leftEye.y + rightEye.y) / 2;
  const pitchRatio = (nose.y - eyeCenterY) / faceWidth;

  let gazeRatio = 0.5;
  let gazeWandering = false;
  const leftIris = face[468];
  const rightIris = face[473];
  if (leftIris) {
    const leftInner = face[133];
    const leftOuter = face[33];
    const leftRatio = normalizeEyePosition(leftIris, leftInner, leftOuter);
    const ratios = [leftRatio];
    if (rightIris) {
      const rightInner = face[362];
      const rightOuter = face[263];
      ratios.push(normalizeEyePosition(rightIris, rightInner, rightOuter));
    }
    gazeRatio = ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
    gazeWandering = ratios.some((ratio) => Math.abs(ratio - 0.5) > thresholds.gaze);
  }

  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.fillStyle = "#38bdf8";
  ctx.beginPath();
  ctx.arc(nose.x * canvas.width, nose.y * canvas.height, 7, 0, Math.PI * 2);
  ctx.fill();
  if (leftIris) {
    ctx.fillStyle = "#22c55e";
    ctx.beginPath();
    ctx.arc(leftIris.x * canvas.width, leftIris.y * canvas.height, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  if (rightIris) {
    ctx.fillStyle = "#22c55e";
    ctx.beginPath();
    ctx.arc(rightIris.x * canvas.width, rightIris.y * canvas.height, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  if (Math.abs(yawRatio) > thresholds.yaw) {
    onSignal({ state: "DISTRACTED", reason: "头部明显偏离学习区域", pitchRatio, yawRatio, gazeRatio, paperFocused: false, absent: false });
  } else if (pitchRatio < thresholds.up) {
    onSignal({ state: "DISTRACTED", reason: "抬头或后仰过久", pitchRatio, yawRatio, gazeRatio, paperFocused: false, absent: false });
  } else if (gazeWandering) {
    onSignal({ state: "DISTRACTED", reason: "眼神偏离当前任务", pitchRatio, yawRatio, gazeRatio, paperFocused: false, absent: false });
  } else if (pitchRatio > thresholds.down) {
    onSignal({ state: "READING", reason: "低头看卷面或书本", pitchRatio, yawRatio, gazeRatio, paperFocused: true, absent: false });
  } else {
    onSignal({ state: "FOCUSED", reason: "正视学习区域", pitchRatio, yawRatio, gazeRatio, paperFocused: false, absent: false });
  }
}

function normalizeEyePosition(iris: Landmark, cornerA: Landmark, cornerB: Landmark) {
  const minX = Math.min(cornerA.x, cornerB.x);
  const maxX = Math.max(cornerA.x, cornerB.x);
  return (iris.x - minX) / Math.max(maxX - minX, 0.0001);
}
