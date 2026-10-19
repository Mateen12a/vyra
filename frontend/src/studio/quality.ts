export type QualityMode = "auto" | "smooth" | "sharp";
export type UploadQuality = Exclude<QualityMode, "auto">;
export type VideoQuality = { width: number; height: number; frameRate: number; maxBitrate: number; maxFramerate: number };
export type QualityMetrics = {
  sendFps?: number | null; receiveFps?: number | null; rttMs?: number | null;
  jitterMs?: number | null; sendKbps?: number | null; receiveKbps?: number | null; lossPct?: number | null;
};
export type QualityReport = { metrics?: QualityMetrics; limitingFactor?: string; quality?: string };

export const VIDEO_QUALITY: Record<UploadQuality, VideoQuality> = {
  smooth: { width: 960, height: 540, frameRate: 24, maxBitrate: 1_200_000, maxFramerate: 24 },
  sharp: { width: 1280, height: 720, frameRate: 30, maxBitrate: 2_500_000, maxFramerate: 30 },
};

export const measured = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export function uplinkLimited(metrics: QualityMetrics) {
  if (measured(metrics.sendFps)) {
    if (metrics.sendFps < 15) return true;
    if (metrics.sendFps >= 20) return false;
  }
  return measured(metrics.sendKbps) && metrics.sendKbps > 0 && metrics.sendKbps < 1200;
}

export function qualityHint(metrics: QualityMetrics) {
  if (measured(metrics.rttMs) && metrics.rttMs > 400) return "High network delay to the AI service.";
  if (measured(metrics.receiveFps) && metrics.receiveFps < 12) {
    if (uplinkLimited(metrics)) return "Your upload is limiting smoothness. Try Smooth mode or a wired connection.";
    if (measured(metrics.sendFps) && metrics.sendFps >= 20) return "The AI service is slow right now. Smoothness may recover in a moment.";
  }
  return "";
}
