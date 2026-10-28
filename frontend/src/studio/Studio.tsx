import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  BroadcastIcon, CameraIcon, CloseIcon, Dialog, ExpandIcon, Field, ImageIcon, MirrorIcon, RecordIcon, Spinner, StudioIcon, useToast,
} from "../components/ui";
import { api, EXTENSION_URL, minutes } from "../lib/api";
import { SetupTour, isPhone } from "./SetupTour";
import { useConsentGate } from "../components/Consent";
import { every } from "../lib/ticker";
import { useAuth } from "../lib/auth";
import { TopUp, type TopUpReason } from "./TopUp";
import { VIDEO_QUALITY, measured, qualityHint, uplinkLimited, type QualityMode, type QualityMetrics, type QualityReport, type UploadQuality } from "./quality";
import {
  characterPrompt, checkConnection, compositor, holdCard, videoStarted, connect, createLookPrompt, describePhoto, endMeter, endMeterOnUnload, fitToCamera, getStatus, heartbeat,
  loadScript, PLATFORMS, recorderType, startStream, withAiVoice, withProvenance,
  type AccentVoice, type LiveStatus, type OverlayConfig, type SceneRule, type Session, type StreamHandle, type VoiceRigHandle,
} from "./engine";

type Phase = "off" | "camera" | "connecting" | "live" | "stopping";
type Look = { label: string; prompt: string; image: Blob | null; imageUrl?: string };
type InspectorTab = "look" | "voice" | "scenes" | "vcam";

const SOURCE_FILE = "__file";
const SOURCE_SCREEN = "__screen";

const IDEAS = [
  { label: "Interview ready", prompt: "Change only the person's clothing to a tailored charcoal blazer over a crisp white top, neat and professional; keep the face and hair unchanged. Make the room behind them a calm, tidy home office with a plain light wall and soft daylight." },
  { label: "Brighter room", prompt: "Change only the background into a bright, modern, uncluttered room with soft window light, a light oak shelf and one green plant. Keep the person, their clothing and lighting on the face unchanged." },
  { label: "Creator setup", prompt: "Give the scene a polished creator setup: soft warm key light on the person's face, a small podcast microphone on an arm in the lower corner, a tasteful shelf with books and a warm lamp softly blurred behind them. Keep the person's clothing unchanged." },
  { label: "Hair and makeup", prompt: "Give the person an elegant evening look: natural makeup with defined brows and a soft lip colour, small gold hoop earrings and a black silk top; keep their own face shape and hair. Warm, softly lit room behind them." },
  { label: "Suit and tie", prompt: "Change only the person's clothing to a navy two-piece suit, white shirt and a subtle dark tie; keep the face and hair unchanged. Keep the background and lighting unchanged." },
  { label: "Cosy café", prompt: "Change only the background to a cosy café with warm pendant lights, a brick wall and softly blurred plants. Keep the person and their clothing unchanged." },
];

const LOCAL_VOICES = [
  { id: "off", name: "Off", note: "Silent mic" },
  { id: "natural", name: "Natural", note: "Your own voice" },
  { id: "male", name: "Male", note: "Lower pitch & tone" },
  { id: "female", name: "Female", note: "Higher pitch & tone" },
  { id: "deep", name: "Deep", note: "Heavy & warm" },
  { id: "cartoon", name: "Cartoon", note: "Small & bright" },
  { id: "robot", name: "Robot", note: "Metallic synth" },
  { id: "radio", name: "Radio", note: "Walkie-talkie" },
];

const SCENE_TRIGGERS = [
  { id: "gesture:Open_Palm", name: "You raise an open hand" },
  { id: "gesture:Thumb_Up", name: "You give a thumbs up" },
  { id: "gesture:Victory", name: "You make a peace sign" },
  { id: "gesture:Pointing_Up", name: "You point up" },
  { id: "gesture:Closed_Fist", name: "You make a fist" },
  { id: "object:cell phone", name: "A phone appears" },
  { id: "object:cup", name: "A cup appears" },
  { id: "absent:person", name: "You leave the frame" },
];

const HIDDEN_GRACE_MS = 60000;
const FIRST_FRAME_TIMEOUT_MS = 40000;
const HEARTBEAT_MS = 15000;
const LIVE_BLOCK = 30; // seconds bought per block; keep in step with pricing.LIVE_BLOCK_SECONDS
const probe = document.createElement("canvas");
probe.width = 32;
probe.height = 18;

function hasContent(video: HTMLVideoElement) {
  if (!video.videoWidth) return false;
  const ctx = probe.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0, 32, 18);
  const data = ctx.getImageData(0, 0, 32, 18).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
  return sum / (data.length / 4) / 3 > 12;
}

const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const metricNumber = (value: number | null | undefined) => measured(value) ? String(Math.round(value)) : "–";

// The go-live progress shown on the stage: where we are, roughly how long is left, and that waiting is free.
const WARM_STEPS = ["Checking connection", "Connecting to the AI", "Preparing your look"];
function warmStep(label: string) {
  if (/connection|camera/i.test(label)) return 0;
  if (/warming|reconnect/i.test(label)) return 2;
  return 1;
}
function WarmupProgress({ label, since }: { label: string; since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, []);
  const step = warmStep(label);
  const elapsed = since ? (now - since) / 1000 : 0;
  const expected = 20;
  const pct = Math.min(95, Math.max(step * 30, (elapsed / expected) * 100));
  const left = Math.max(0, Math.round(expected - elapsed));
  return (
    <div className="stage-warmup" role="status" aria-live="polite">
      <div className="warm-card">
        <ol className="warm-steps">
          {WARM_STEPS.map((s, i) => (
            <li key={s} className={i < step ? "is-done" : i === step ? "is-now" : ""}>{i < step ? "✓ " : ""}{s}</li>
          ))}
        </ol>
        <div className="warm-bar"><span style={{ width: `${pct}%` }} /></div>
        <p className="warm-note">{label}{elapsed > expected + 5 ? " · taking longer than usual" : left ? ` · about ${left} s` : ""}</p>
        <p className="warm-free">You're not charged until your AI look appears.</p>
      </div>
    </div>
  );
}

export default function Studio() {
  const { me, catalogue, setBalance } = useAuth();
  const toast = useToast();
  const [params] = useSearchParams();
  const perMinute = catalogue?.live_credits_per_minute || 60;

  const [tab, setTab] = useState<InspectorTab>("look");
  const [topUp, setTopUp] = useState<TopUpReason | null>(null);
  const lowShownRef = useRef(false);
  const [slowNet, setSlowNet] = useState<{ uploadMbps: number; latencyMs: number } | null>(null);
  const slowOkRef = useRef(false);
  const [warmStart, setWarmStart] = useState(0);
  const consentGate = useConsentGate();
  // After an unplanned stop, calls and streams show this card instead of the real camera until the user decides.
  // Before going live, calls see a "Starting soon" card instead of the real camera, so the other person never sees
  // the user's real face unless they choose to show it.
  const holdRef = useRef<HTMLCanvasElement | null>(holdCard(null, "Starting soon", "VYRANI"));
  const [realBeforeLive, setRealBeforeLive] = useState(false);
  const [holding, setHolding] = useState(false);
  // Credits left in this session, in seconds, as of `at` (from the last heartbeat).
  const [left, setLeft] = useState<{ seconds: number; at: number } | null>(null);
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!left) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [left]);
  const [phone] = useState(isPhone); // no browser extensions or OBS on phones
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("off");
  // Restart the warm-up clock each time a go-live attempt begins.
  useEffect(() => { if (phase === "connecting") setWarmStart(Date.now()); }, [phase]);
  const [sourceStarting, setSourceStarting] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [qualityMode, setQualityMode] = useState<QualityMode>(() => {
    const saved = localStorage.getItem("vyra.quality");
    return saved === "smooth" || saved === "sharp" ? saved : "auto";
  });
  const [uploadQuality, setUploadQuality] = useState<UploadQuality>(qualityMode === "smooth" ? "smooth" : "sharp");
  const [qualityMetrics, setQualityMetrics] = useState<QualityMetrics | null>(null);
  const qualityModeRef = useRef(qualityMode);
  qualityModeRef.current = qualityMode;
  const uploadQualityRef = useRef(uploadQuality);
  const desiredQualityRef = useRef(uploadQuality);
  const qualityQueueRef = useRef<Promise<void>>(Promise.resolve());
  const qualityMetricsRef = useRef<QualityMetrics | null>(null);
  const lowQualityReportsRef = useRef(0);
  const lastAutoSwitchRef = useRef(-Infinity);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState("");
  const [fileSourceName, setFileSourceName] = useState("");
  const [mirrored, setMirrored] = useState(true);
  const [warmup, setWarmup] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [recording, setRecording] = useState(false);
  const [convertingVoice, setConvertingVoice] = useState(false);
  const [streaming, setStreaming] = useState<"off" | "starting" | "on">("off");
  const [streamOpen, setStreamOpen] = useState(false);
  const liveStreamRef = useRef<{ handle: StreamHandle; stopDrawing: () => void; mic: MediaStream | null } | null>(null);

  // Composer & Photo Crop
  const [text, setText] = useState("");
  const [ideaInput, setIdeaInput] = useState("");
  const [creatingLook, setCreatingLook] = useState(false);
  const [photo, setPhoto] = useState<{ file: Blob; url: string; bitmap?: ImageBitmap } | null>(null);
  const [cropZoom, setCropZoom] = useState(1);
  const [cropOffset, setCropOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [consent, setConsent] = useState(false);
  const [describing, setDescribing] = useState(false);
  const [ideaLabel, setIdeaLabel] = useState<string | null>(null);
  const [look, setLook] = useState<Look | null>(null);
  const [applying, setApplying] = useState(false);

  // Voice & Lip-Sync
  const [voiceMode, setVoiceMode] = useState<string>(() => localStorage.getItem("vyra.voice") || "natural");
  const [accentVoiceId, setAccentVoiceId] = useState<string>("");
  const [monitorMic, setMonitorMic] = useState(false);
  const [syncOffsetMs, setSyncOffsetMs] = useState<number>(() => Number(localStorage.getItem("vyra.voiceSync") || "0") || 0);
  const [measuredLagMs, setMeasuredLagMs] = useState<number | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const voiceMeterFillRef = useRef<HTMLDivElement>(null);
  const voiceRigRef = useRef<VoiceRigHandle | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Scenes, Voice Commands, Broadcast Overlay & Watermark
  const [rulesEnabled, setRulesEnabled] = useState<boolean>(() => localStorage.getItem("vyra.rulesOn") === "1");
  const [rules, setRules] = useState<SceneRule[]>(() => {
    try { return JSON.parse(localStorage.getItem("vyra.rules") || "[]"); } catch { return []; }
  });
  const [newRuleTrigger, setNewRuleTrigger] = useState(SCENE_TRIGGERS[0].id);
  const [newRuleAction, setNewRuleAction] = useState("look:Anime character");
  const [commandMode, setCommandMode] = useState<"off" | "hold" | "handsfree">("off");
  const [commandState, setCommandState] = useState("off");
  const [lastCommand, setLastCommand] = useState("");

  const [overlayVisible, setOverlayVisible] = useState(false);
  const [overlayTitle, setOverlayTitle] = useState(() => localStorage.getItem("vyra.overlayTitle") || "");
  const [overlaySub, setOverlaySub] = useState(() => localStorage.getItem("vyra.overlaySub") || "");
  const [overlayLogoUrl, setOverlayLogoUrl] = useState<string | null>(null);
  const overlayLogoImgRef = useRef<HTMLImageElement | null>(null);

  const canRemoveWatermark = Boolean(me?.user.can_remove_watermark || status?.can_remove_watermark || me?.user.role === "admin");
  const [hideWatermark, setHideWatermark] = useState<boolean>(() => localStorage.getItem("vyra.hideWatermark") === "1");
  // Likeness Disclosure Rule: whenever a real person's likeness (reference photo) is active, the visible AI label
  // is ALWAYS on (never removable), with paid/admin users receiving a smaller compact label.
  const showWatermark = !status?.vyra_dev_mode && (canRemoveWatermark ? !hideWatermark && Boolean(status?.ai_label) : true);
  const compactWatermark = Boolean(canRemoveWatermark && !hideWatermark);

  // Virtual Camera Hub
  const [vcamActive, setVcamActive] = useState<boolean>(() => localStorage.getItem("vyra.vcamActive") !== "0");
  const vcamActiveRef = useRef(vcamActive);
  const [vcamFps, setVcamFps] = useState(0);
  const [vcamMethod, setVcamMethod] = useState<"frames" | "canvas" | "">("");
  vcamActiveRef.current = vcamActive;
  const [nativeCamConnected, setNativeCamConnected] = useState(false);
  const [obsStatus, setObsStatus] = useState<{ installed: boolean; path: string | null; window_title?: string } | null>(null);
  const [obsBusy, setObsBusy] = useState(false);
  const [extensionStatus, setExtensionStatus] = useState<"missing" | "outdated" | "ready" | "error">("missing");
  const extInstalled = extensionStatus === "ready";
  // First-run setup wizard: full-screen guide until the user skips it or marks it done.
  const [setupOpen, setSetupOpen] = useState<boolean>(() => localStorage.getItem("vyra.setupDone") !== "1");
  const dismissSetup = useCallback(() => {
    localStorage.setItem("vyra.setupDone", "1");
    setSetupOpen(false);
  }, []);
  const nativeWsRef = useRef<WebSocket | null>(null);
  const vcamTimerRef = useRef<number | null>(null);

  const camRef = useRef<HTMLVideoElement>(null);
  const aiRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const sourceVideoInputRef = useRef<HTMLInputElement>(null);
  const fileVideoElRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const billingRef = useRef<{ id: string | null }>({ id: null });
  const timersRef = useRef<{ stopBeat?: () => void; tick?: number; stall?: number; hidden?: number; startedAt?: number; streamGrace?: number }>({});
  const recorderRef = useRef<{ rec: MediaRecorder; chunks: Blob[]; stop: () => void; accentId: string } | null>(null);
  const lookRef = useRef<Look | null>(null);
  lookRef.current = look;

  const overlayConfigRef = useRef<OverlayConfig>({ visible: false, title: "", sub: "", logoImg: null });
  overlayConfigRef.current = {
    visible: overlayVisible,
    title: overlayTitle,
    sub: overlaySub,
    logoImg: overlayLogoImgRef.current,
  };

  const live = phase === "live";
  const busy = phase === "connecting" || phase === "stopping";
  const provider = status?.provider || "fal";

  // Serialize camera/sender updates so a manual selection always wins over an in-flight Auto change.
  const applyUploadQuality = useCallback((preset: UploadQuality, targetSession?: Session) => {
    desiredQualityRef.current = preset;
    const update = qualityQueueRef.current.catch(() => {}).then(async () => {
      if (desiredQualityRef.current !== preset) return;
      const profile = VIDEO_QUALITY[preset];
      const track = streamRef.current?.getVideoTracks()[0];
      if (track?.readyState === "live") {
        await track.applyConstraints({ width: profile.width, height: profile.height, frameRate: { ideal: profile.frameRate, max: profile.frameRate } });
      }
      if (desiredQualityRef.current !== preset) return;
      const session = targetSession || sessionRef.current;
      await session?.setVideoQuality?.({ maxBitrate: profile.maxBitrate, maxFramerate: profile.maxFramerate });
      uploadQualityRef.current = preset;
      setUploadQuality(preset);
    });
    qualityQueueRef.current = update;
    return update;
  }, []);

  function chooseQuality(mode: QualityMode) {
    qualityModeRef.current = mode;
    setQualityMode(mode);
    localStorage.setItem("vyra.quality", mode);
    lowQualityReportsRef.current = 0;
    applyUploadQuality(mode === "smooth" ? "smooth" : "sharp").catch(() => toast("Couldn't change upload quality. Your session is still running.", true));
  }

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      console.info("[VYRANI] quality", qualityMetricsRef.current || {});
    }, 10000);
    return () => clearInterval(timer);
  }, [live]);

  useEffect(() => {
    getStatus().then(setStatus).catch(() => setStatus(null));
    if (params.get("mode") === "photo") setTimeout(() => fileRef.current?.click(), 400);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const checkExtension = () => {
      const extension = window.VyraVirtualCam;
      const next = !extension ? "missing" :
        typeof extension.publishStream === "function" && typeof extension.stop === "function" ? "ready" : "outdated";
      setExtensionStatus(current => current === "error" && next === "ready" ? current : next);
    };
    checkExtension();
    const timer = window.setInterval(checkExtension, 1000);
    return () => clearInterval(timer);
  }, []);

  // ---------- Voice Rig & Lip-Sync ----------
  const ensureVoiceRig = useCallback(async () => {
    if (voiceMode === "off") {
      voiceRigRef.current?.close();
      voiceRigRef.current = null;
      setMicLevel(0);
      return null;
    }
    try {
      await loadScript("/assets/voice.js");
      if (!window.VyraVoice) return null;
      if (!voiceRigRef.current) {
        if (!audioCtxRef.current) {
          audioCtxRef.current = new AudioContext({ latencyHint: "interactive" });
        }
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        const rig = await window.VyraVoice.create(mic, audioCtxRef.current);
        voiceRigRef.current = rig;
      }
      const rig = voiceRigRef.current;
      rig.setEffect(voiceMode);
      rig.setMonitor(monitorMic);
      const totalDelay = Math.max(0, (measuredLagMs ?? 180) + syncOffsetMs);
      rig.setDelay(totalDelay);
      await rig.resume();
      return rig;
    } catch {
      return null;
    }
  }, [voiceMode, monitorMic, measuredLagMs, syncOffsetMs]);

  useEffect(() => {
    localStorage.setItem("vyra.voice", voiceMode);
    if (phase !== "off") ensureVoiceRig();
  }, [voiceMode, monitorMic, syncOffsetMs, measuredLagMs, phase, ensureVoiceRig]);

  useEffect(() => {
    let raf = 0;
    const updateMeter = () => {
      const lv = voiceRigRef.current && voiceMode !== "off" ? voiceRigRef.current.level() : 0;
      setMicLevel(lv);
      if (voiceMeterFillRef.current) {
        voiceMeterFillRef.current.style.setProperty("width", `${Math.round(lv * 100)}%`);
      }
      raf = requestAnimationFrame(updateMeter);
    };
    raf = requestAnimationFrame(updateMeter);
    return () => cancelAnimationFrame(raf);
  }, [voiceMode]);

  // LagMeter during live session
  useEffect(() => {
    if (!live || !camRef.current || !aiRef.current || !window.VyraVoice?.LagMeter) return;
    const meter = new window.VyraVoice.LagMeter(camRef.current, aiRef.current);
    meter.start();
    const timer = window.setInterval(() => {
      const est = meter.estimate();
      if (est && est.confidence >= 0.35) {
        setMeasuredLagMs(Math.round(est.ms));
      }
    }, 2000);
    return () => {
      meter.stop();
      clearInterval(timer);
    };
  }, [live]);

  // ---------- VYRANI Camera Commander (OBS-powered system camera) ----------
  useEffect(() => {
    // Only relevant while the Virtual Cam panel is open; the server answers 404 when hosted.
    if (tab !== "vcam") return;
    let cancelled = false;
    api<{ installed: boolean; path: string | null; window_title?: string }>("/api/obs/status")
      .then((status) => { if (!cancelled) setObsStatus(status); })
      .catch(() => { if (!cancelled) setObsStatus({ installed: false, path: null }); });
    return () => { cancelled = true; };
  }, [tab]);

  // ---------- Virtual Camera Broadcast Engine (Browser Extension + Native Bridge) ----------
  useEffect(() => {
    localStorage.setItem("vyra.vcamActive", vcamActive ? "1" : "0");
    if (!vcamActive) {
      try { window.VyraVirtualCam?.stop?.(); } catch { setExtensionStatus("error"); }
      window.__VYRA_LIVE_OUTPUT_STREAM__ = null;
      nativeWsRef.current?.close();
      nativeWsRef.current = null;
      setNativeCamConnected(false);
      if (vcamTimerRef.current) clearInterval(vcamTimerRef.current);
      return;
    }

    // The output picture. Built frame by frame from the source video track (insertable streams), so it keeps
    // flowing when this tab is in the background; Chrome stops requestAnimationFrame in hidden tabs, which froze
    // the camera in Meet as soon as the user switched to the call. Older browsers fall back to a worker timer.
    const W = 1280, H = 720;
    const canvas = Object.assign(document.createElement("canvas"), { width: W, height: H });
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    let sent = 0; // frames handed to calls, for the fps readout

    const decorate = () => {
      const ov = overlayConfigRef.current;
      if (ov.visible && (ov.title || ov.sub)) {
        ctx.fillStyle = "rgba(9, 9, 11, 0.88)";
        ctx.fillRect(48, 580, 460, 84);
        ctx.fillStyle = "#ff6b2b";
        ctx.fillRect(48, 580, 6, 84);
        if (ov.title) {
          ctx.fillStyle = "#f4f4f5";
          ctx.font = "700 26px Chillax, system-ui, sans-serif";
          ctx.fillText(ov.title, 70, 616);
        }
        if (ov.sub) {
          ctx.fillStyle = "#ff6b2b";
          ctx.font = "600 14px ui-monospace, monospace";
          ctx.fillText(ov.sub.toUpperCase(), 70, 644);
        }
      }
      if (showWatermark) {
        if (compactWatermark) {
          ctx.fillStyle = "rgba(0,0,0,0.42)";
          ctx.fillRect(1176, 682, 88, 24);
          ctx.fillStyle = "rgba(255,255,255,0.85)";
          ctx.font = "600 12px Chillax, sans-serif";
          ctx.fillText("VYRANI · AI", 1188, 698);
        } else {
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.fillRect(1140, 668, 120, 34);
          ctx.fillStyle = "#fff";
          ctx.font = "600 18px Chillax, sans-serif";
          ctx.fillText("VYRANI · AI", 1154, 691);
        }
      }
    };

    // Send a JPEG to the native desktop bridge when it's connected (at most 24 fps).
    let lastNativeSend = 0;
    const sendNative = () => {
      const now = performance.now();
      if (nativeWsRef.current?.readyState !== WebSocket.OPEN || now - lastNativeSend < 41) return;
      lastNativeSend = now;
      const toBlob = new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
      toBlob.then((blob) => blob?.arrayBuffer()).then((buf) => { if (buf) nativeWsRef.current?.send(buf); }).catch(() => {});
    };

    // The AI output while live, otherwise the camera. Re-read each time, so camera switches are picked up.
    const sourceTrack = (): MediaStreamTrack | null => {
      const ai = (aiRef.current?.srcObject as MediaStream | null)?.getVideoTracks()[0];
      if (live && ai && ai.readyState === "live") return ai;
      const cam = streamRef.current?.getVideoTracks()[0];
      return cam && cam.readyState === "live" ? cam : null;
    };

    let stopped = false;
    let directStream: MediaStream = new MediaStream();
    let stopPump: () => void = () => {};
    const Processor = (window as unknown as { MediaStreamTrackProcessor?: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor;
    const Generator = (window as unknown as { MediaStreamTrackGenerator?: new (o: { kind: "video" }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> } }).MediaStreamTrackGenerator;

    // Canvas method: redraw from the stage's video elements on the worker clock (keeps going in hidden tabs).
    const startCanvas = () => {
      const stream = canvas.captureStream(30);
      const stop = every(33, () => {
        const sourceVideo = live && aiRef.current?.videoWidth ? aiRef.current : camRef.current;
        if (holdRef.current) ctx.drawImage(holdRef.current, 0, 0, W, H);
        else if (!sourceVideo || !sourceVideo.videoWidth) return;
        else ctx.drawImage(sourceVideo, 0, 0, W, H);
        decorate();
        sent++;
        sendNative();
      });
      return { stream, stop };
    };

    // Frame-stream method: built from the source track's own frames, never throttled by the page.
    const startFrames = () => {
      const generator = new Generator!({ kind: "video" });
      const writer = generator.writable.getWriter();
      let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
      let pumpTrack: MediaStreamTrack | null = null;
      let running = true;
      (async () => {
        while (running && !stopped) {
          const track = sourceTrack();
          if (!track) { await new Promise((r) => setTimeout(r, 250)); continue; } // camera not on yet
          pumpTrack = track.clone(); // a clone, so this pipeline never stops the studio's own track
          reader = new Processor!({ track: pumpTrack }).readable.getReader();
          for (;;) {
            const { value: frame, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
            if (done || !frame) break;
            if (!running || stopped) { frame.close(); break; }
            ctx.drawImage(holdRef.current || (frame as unknown as CanvasImageSource), 0, 0, W, H);
            const timestamp = frame.timestamp;
            frame.close();
            decorate();
            const out = new VideoFrame(canvas, { timestamp });
            await writer.write(out).catch(() => out.close());
            sent++;
            sendNative();
            if (sourceTrack() !== track) break; // went live, or switched camera: follow the new source
          }
          pumpTrack?.stop();
        }
      })();
      const stop = () => { running = false; reader?.cancel().catch(() => {}); pumpTrack?.stop(); writer.close().catch(() => {}); generator.stop(); };
      return { stream: new MediaStream([generator]), stop };
    };

    const publish = (stream: MediaStream) => {
      const audioTrack = voiceRigRef.current?.track();
      if (audioTrack) stream.addTrack(audioTrack.clone());
      directStream = stream;
      window.__VYRA_LIVE_OUTPUT_STREAM__ = stream;
      if (extInstalled) {
        try { window.VyraVirtualCam?.publishStream?.(stream, W, H, lookRef.current?.label || "Camera preview"); }
        catch { setExtensionStatus("error"); }
      }
    };

    let watchdog = 0;
    const useCanvas = () => {
      const pipe = startCanvas();
      stopPump = pipe.stop;
      publish(pipe.stream);
      setVcamMethod("canvas");
    };
    if (Processor && Generator && typeof VideoFrame !== "undefined") {
      try {
        const pipe = startFrames();
        stopPump = pipe.stop;
        publish(pipe.stream);
        setVcamMethod("frames");
        // If this browser accepts the API but never produces frames, switch methods instead of sending nothing.
        watchdog = window.setTimeout(() => {
          if (stopped || sent > 0 || !sourceTrack()) return;
          console.warn("[VYRANI] frame-stream output produced no frames; switching to canvas output");
          pipe.stop();
          directStream.getTracks().forEach((t) => t.stop());
          useCanvas();
        }, 2500);
      } catch (error) {
        console.warn("[VYRANI] frame-stream output unavailable:", error);
        useCanvas();
      }
    } else {
      useCanvas();
    }

    // fps readout for the Virtual Cam tab.
    let lastSent = 0;
    const stopMeter = every(1000, () => { setVcamFps(sent - lastSent); lastSent = sent; });


    // Connect to the optional local native virtual camera bridge (ws://127.0.0.1:29876/vyra-cam).
    try {
      const ws = new WebSocket("ws://127.0.0.1:29876/vyra-cam");
      ws.onopen = () => setNativeCamConnected(true);
      ws.onclose = () => { setNativeCamConnected(false); nativeWsRef.current = null; };
      ws.onerror = () => { setNativeCamConnected(false); };
      nativeWsRef.current = ws;
    } catch {
      setNativeCamConnected(false);
    }

    return () => {
      stopped = true;
      clearTimeout(watchdog);
      stopMeter();
      setVcamFps(0);
      stopPump();
      directStream.getTracks().forEach(track => track.stop());
      if (window.__VYRA_LIVE_OUTPUT_STREAM__ === directStream) window.__VYRA_LIVE_OUTPUT_STREAM__ = null;
      try { window.VyraVirtualCam?.stop?.(); } catch { /* An extension failure must not crash the studio. */ }
      nativeWsRef.current?.close();
    };
  }, [vcamActive, live, showWatermark, compactWatermark, extInstalled]);

  // ---------- Camera, Video File & Screen Share Sources ----------
  const openSource = useCallback(async (sourceId?: string, fileObj?: File) => {
    const target = sourceId ?? cameraId;
    const profile = VIDEO_QUALITY[desiredQualityRef.current];
    setSourceStarting(true);
    setSourceError("");
    try {
      let stream: MediaStream;
      if (target === SOURCE_FILE || fileObj) {
        const file = fileObj;
        if (!file && !fileVideoElRef.current?.src) {
          sourceVideoInputRef.current?.click();
          return;
        }
        const vid = fileVideoElRef.current || Object.assign(document.createElement("video"), { muted: true, loop: true, playsInline: true });
        fileVideoElRef.current = vid;
        if (file) {
          if (vid.src) URL.revokeObjectURL(vid.src);
          vid.src = URL.createObjectURL(file);
          setFileSourceName(file.name.slice(0, 24));
        }
        await vid.play();
        if (!vid.videoWidth) await new Promise((r) => vid.addEventListener("loadedmetadata", r, { once: true }));
        const captured = (vid as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream?.();
        const track = captured?.getVideoTracks()[0];
        if (!track) throw new Error("Your browser could not stream that video file.");
        stream = new MediaStream([track]);
        setMirrored(false);
      } else if (target === SOURCE_SCREEN) {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: profile.width }, height: { ideal: profile.height }, frameRate: { ideal: profile.frameRate } },
          audio: false,
        });
        setMirrored(false);
      } else {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { ...(target ? { deviceId: { exact: target } } : {}), width: { ideal: profile.width }, height: { ideal: profile.height }, frameRate: { ideal: profile.frameRate } },
          audio: false,
        });
        setMirrored(true);
      }

      const old = streamRef.current;
      streamRef.current = stream;
      if (camRef.current) {
        camRef.current.srcObject = stream;
        camRef.current.play().catch(() => {});
      }
      // Showing an acquired stream must not depend on device enumeration succeeding.
      setPhase((p) => (p === "off" ? "camera" : p));
      setCameraId(target || "");
      if (sessionRef.current?.replaceVideoTrack) {
        await sessionRef.current.replaceVideoTrack(stream.getVideoTracks()[0]);
      }
      old?.getTracks().forEach((t) => t.stop());
      await applyUploadQuality(desiredQualityRef.current).catch(() => toast("Couldn't apply upload quality to this video source.", true));
      navigator.mediaDevices.enumerateDevices().then((allDevices) => {
        if (streamRef.current !== stream) return;
        const devices = allDevices.filter((d) => d.kind === "videoinput" && d.deviceId !== "vyra-virtual-cam");
        setCameras(devices);
        let deviceId = "";
        try { deviceId = stream.getVideoTracks()[0]?.getSettings().deviceId || ""; } catch { /* Keep default input selected. */ }
        setCameraId(target || deviceId);
      }).catch(() => { /* The acquired camera still works without a device list. */ });
      ensureVoiceRig();
    } catch (error) {
      const name = (error as DOMException).name;
      const message = name === "NotAllowedError"
          ? "Camera or screen access was blocked. Allow it in your browser's address bar."
          : name === "NotFoundError"
          ? "No camera found. Plug one in or select a video file."
          : name === "NotReadableError"
          ? "The camera couldn't start. Close other apps using it, then try again."
          : (error as Error).message || "Couldn't start the video source.";
      setSourceError(message);
      toast(message, true);
    } finally {
      setSourceStarting(false);
    }
  }, [cameraId, ensureVoiceRig, toast, applyUploadQuality]);

  // ---------- Interactive Photo Crop & Composer ----------
  async function pickPhoto(file?: File) {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return toast("Use a JPG, PNG or WebP photo.", true);
    if (file.size > 8 * 1024 * 1024) return toast("Use a photo under 8 MB.", true);
    if (photo) URL.revokeObjectURL(photo.url);
    const bitmap = await createImageBitmap(file).catch(() => undefined);
    setPhoto({ file, url: URL.createObjectURL(file), bitmap });
    setCropZoom(1);
    setCropOffset({ x: 0, y: 0 });
    setConsent(false);
    if (status?.assist) {
      setDescribing(true);
      try {
        const d = await describePhoto(file);
        if (d) setText(d);
      } catch { /* optional */ }
      finally { setDescribing(false); }
    }
  }

  function clearPhoto() {
    if (photo) URL.revokeObjectURL(photo.url);
    setPhoto(null);
    setConsent(false);
  }

  async function renderCroppedPhoto(file: Blob, aspect: number): Promise<Blob> {
    if (cropZoom === 1 && cropOffset.x === 0 && cropOffset.y === 0) {
      return fitToCamera(file, aspect);
    }
    const bitmap = photo?.bitmap || (await createImageBitmap(file));
    const canvas = document.createElement("canvas");
    canvas.width = aspect >= 1 ? 1280 : 720;
    canvas.height = Math.round(canvas.width / aspect);
    const baseScale = Math.max(canvas.width / bitmap.width, canvas.height / bitmap.height) * cropZoom;
    const w = bitmap.width * baseScale;
    const h = bitmap.height * baseScale;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(
      bitmap,
      (canvas.width - w) / 2 + cropOffset.x * canvas.width * 0.35,
      (canvas.height - h) / 2.6 + cropOffset.y * canvas.height * 0.35,
      w,
      h
    );
    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't prepare photo."))), "image/jpeg", 0.9)
    );
  }

  async function handleGenerateLook(e: FormEvent) {
    e.preventDefault();
    if (ideaInput.trim().length < 2 || creatingLook) return;
    setCreatingLook(true);
    try {
      const made = await createLookPrompt(ideaInput.trim());
      clearPhoto();
      setText(made.prompt);
      setIdeaLabel(made.name);
      setIdeaInput("");
      toast(`Created "${made.name}" prompt.`);
    } catch (err) {
      toast((err as Error).message || "Could not generate look.", true);
    } finally {
      setCreatingLook(false);
    }
  }

  async function applyLookState(customLook?: Look) {
    if (customLook) {
      setLook(customLook);
      if (sessionRef.current) {
        await sessionRef.current.set({ image: customLook.image, prompt: customLook.prompt, enhance: true });
        toast(`Now: ${customLook.label}`);
      }
      return;
    }
    const words = text.trim();
    if (photo && !consent) return toast("Confirm you have permission to use this person's likeness.", true);
    if (!photo && words.length < 2) return toast("Describe who or what you want to become.", true);
    setApplying(true);
    try {
      const track = streamRef.current?.getVideoTracks()[0]?.getSettings();
      const aspect = track?.width && track?.height ? track.width / track.height : 16 / 9;
      const image = photo ? await renderCroppedPhoto(photo.file, aspect) : null;
      const next: Look = {
        label: photo
          ? "Your character photo"
          : ideaLabel || (words.length > 48 ? `${words.slice(0, 46)}…` : words),
        prompt: photo ? characterPrompt(words) : words,
        image,
        imageUrl: photo?.url,
      };
      setLook(next);
      if (sessionRef.current) {
        await sessionRef.current.set({ image: next.image, prompt: next.prompt, enhance: true });
        toast(`Now: ${next.label}`);
      } else {
        toast("Look ready. Press Go live.");
      }
    } catch (error) {
      toast((error as Error).message || "Couldn't apply that look.", true);
    } finally {
      setApplying(false);
    }
  }

  // ---------- Scene Rules & Voice Commands ----------
  const executeRuleOrCommand = useCallback((actionStr: string) => {
    if (actionStr.startsWith("look:")) {
      const name = actionStr.slice(5);
      const found = IDEAS.find((i) => i.label.toLowerCase() === name.toLowerCase());
      if (found) {
        applyLookState({ label: found.label, prompt: found.prompt, image: null });
      }
    } else if (actionStr === "overlay:show") {
      setOverlayVisible(true);
    } else if (actionStr === "overlay:hide") {
      setOverlayVisible(false);
    } else if (actionStr.startsWith("voice:")) {
      setVoiceMode(actionStr.slice(6));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    localStorage.setItem("vyra.rules", JSON.stringify(rules));
    localStorage.setItem("vyra.rulesOn", rulesEnabled ? "1" : "0");
    if (!rulesEnabled || !camRef.current || phase === "off") return;
    let runner: { setRules(r: SceneRule[]): void; start(): Promise<void>; stop(): void } | null = null;
    loadScript("/assets/scenes.js").then(() => {
      if (!window.VyraScenes || !camRef.current) return;
      runner = new window.VyraScenes.SceneRunner(camRef.current, (rule, on) => {
        if (on) executeRuleOrCommand(rule.action);
        else if (rule.undo && rule.action === "overlay:show") setOverlayVisible(false);
      });
      runner.setRules(rules);
      runner.start().catch(() => {});
    }).catch(() => {});
    return () => runner?.stop();
  }, [rules, rulesEnabled, phase, executeRuleOrCommand]);

  useEffect(() => {
    if (commandMode === "off") {
      setCommandState("off");
      return;
    }
    let cmds: { setMode(m: "off" | "hold" | "handsfree"): void; press(): void; release(): void } | null = null;
    loadScript("/assets/scenes.js").then(() => {
      if (!window.VyraScenes) return;
      cmds = new window.VyraScenes.Commands(
        (spoken) => {
          setLastCommand(spoken);
          const lower = spoken.toLowerCase();
          const matchIdea = IDEAS.find((i) => lower.includes(i.label.toLowerCase().split(" ")[0]));
          if (matchIdea) {
            executeRuleOrCommand(`look:${matchIdea.label}`);
          } else if (lower.includes("banner") || lower.includes("overlay")) {
            setOverlayVisible((v) => !v);
          } else if (lower.includes("female")) {
            setVoiceMode("female");
          } else if (lower.includes("male")) {
            setVoiceMode("male");
          } else {
            setText(spoken);
            setIdeaLabel(spoken.slice(0, 32));
          }
        },
        (st) => setCommandState(st)
      );
      cmds.setMode(commandMode);
    }).catch(() => {});
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "v" && commandMode === "hold" && !["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName)) {
        cmds?.press();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "v" && commandMode === "hold") cmds?.release();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      cmds?.setMode("off");
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [commandMode, executeRuleOrCommand]);

  // ---------- Live Session ----------
  // `unplanned`: the session ended without the user asking (credits, service, network). Calls and streams then show a
  // "Be right back" card and the stream stays up for two minutes so the user can top up and go live again.
  const stop = useCallback(async (message?: string, unplanned = false) => {
    const t = timersRef.current;
    t.stopBeat?.(); t.stopBeat = undefined; clearInterval(t.tick); clearTimeout(t.stall); clearTimeout(t.hidden);
    abortRef.current?.abort(); abortRef.current = null;
    if (recorderRef.current) recorderRef.current.rec.stop();
    const wasLive = phaseRef.current === "live";
    if (wasLive) {
      holdRef.current = holdCard(aiRef.current, unplanned ? "Be right back" : "Paused", "VYRANI");
      setHolding(true);
    }
    setLeft(null);
    if (unplanned && wasLive && liveStreamRef.current) {
      clearTimeout(t.streamGrace);
      t.streamGrace = window.setTimeout(() => { if (phaseRef.current !== "live") stopStream(); }, 120000);
    } else stopStream();
    const session = sessionRef.current; sessionRef.current = null;
    if (session) setPhase("stopping");
    try { session?.disconnect(); } catch { /* already closed */ }
    if (aiRef.current) aiRef.current.srcObject = null;
    const id = billingRef.current.id; billingRef.current.id = null;
    if (id) endMeter(id).then((m) => { if (m) setBalance(m.balance); });
    setPhase(streamRef.current ? "camera" : "off");
    setWarmup("");
    setQualityMetrics(null);
    qualityMetricsRef.current = null;
    lowQualityReportsRef.current = 0;
    if (message) toast(message);
  }, [setBalance, toast]);

  // Re-entry guard: a second press while the first is still setting up must not open a second session
  // (fal allows one, so the second sees "busy" and the failed attempt would end the paid session).
  const startingRef = useRef(false);
  const pressedAtRef = useRef(0);
  // Warns once about a dark room: the models need light on the face. Never blocks; a second press goes ahead.
  const darkWarnedRef = useRef(false);
  function roomIsDark() {
    const video = camRef.current;
    if (!video || !video.videoWidth) return false;
    const c = Object.assign(document.createElement("canvas"), { width: 64, height: 36 });
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    // The middle of the frame, where the face is; a dark wall behind a lit face is fine.
    ctx.drawImage(video, video.videoWidth * 0.25, video.videoHeight * 0.1, video.videoWidth * 0.5, video.videoHeight * 0.7, 0, 0, 64, 36);
    const px = ctx.getImageData(0, 0, 64, 36).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    return sum / (px.length / 4) < 45;
  }
  // Going live brings the picture back into view if the page was scrolled down to the settings.
  useEffect(() => {
    if (phase !== "live" && phase !== "connecting") return;
    const el = stageRef.current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [phase]);

  async function goLive() {
    if (startingRef.current) return;
    // A double-click's second press lands on "Cancel"; only treat it as cancel after a real pause.
    if ((live || busy) && performance.now() - pressedAtRef.current < 1200) return;
    if (live || busy) return stop("Session ended.");
    if (!look) return toast("Describe a look or add a photo first.", true);
    if (!status?.available) return toast(status?.message || "Live isn't available right now.", true);
    if (me && me.balance < LIVE_BLOCK) return setTopUp("empty");
    if (!(await consentGate.ensure())) return;
    // Check the connection before any credits are taken: below ~1 Mbps upload the result stutters. The call app
    // (WhatsApp, Meet...) shares the same upload, so live needs headroom on top of what the call itself uses.
    let net: Awaited<ReturnType<typeof checkConnection>> = null;
    if (!slowOkRef.current) {
      setWarmup("Checking your connection");
      setPhase("connecting");
      net = await checkConnection();
      setPhase(streamRef.current ? "camera" : "off"); setWarmup("");
      if (net && net.uploadMbps < 1.2) {
        setSlowNet(net);
        return;
      }
    }
    const tightNet = slowOkRef.current || (net !== null && net.uploadMbps < 2.5);
    slowOkRef.current = false;
    // A tip only: going live never waits on it.
    if (!darkWarnedRef.current && roomIsDark()) {
      darkWarnedRef.current = true;
      toast("Tip: your face looks dimly lit, so the result may look soft. Facing a window or a lamp helps.");
    }
    startingRef.current = true;
    pressedAtRef.current = performance.now();
    // Auto starts in Smooth on a tight connection instead of stuttering in Sharp first.
    desiredQualityRef.current = qualityModeRef.current === "smooth" || (qualityModeRef.current === "auto" && tightNet) ? "smooth" : "sharp";
    lowQualityReportsRef.current = 0;
    qualityMetricsRef.current = null;
    setQualityMetrics(null);
    const controller = new AbortController(); abortRef.current = controller;
    setPhase("connecting"); setWarmup("Starting camera"); setSeconds(0); // the button shows Cancel straight away
    try {
      if (!streamRef.current) await openSource(cameraId);
      if (!streamRef.current) { setPhase("off"); setWarmup(""); return; }
      await ensureVoiceRig();
      await applyUploadQuality(desiredQualityRef.current).catch(() => toast("Couldn't apply upload quality. Continuing with your current camera settings.", true));
    } finally {
      startingRef.current = false;
    }
    if (controller.signal.aborted) return; // cancelled while the camera was starting
    setWarmup("Connecting");
    try {
      const session = await connect({
        stream: streamRef.current, provider, model: status.model, signal: controller.signal,
        state: { image: look.image, prompt: look.prompt, enhance: true },
        onRemote: (remote) => { if (aiRef.current) { aiRef.current.srcObject = remote; aiRef.current.play().catch(() => {}); } },
        onRetry: (n, of) => setWarmup(`Waiting for a free slot · ${n}/${of}`),
        billing: { get id() { return billingRef.current.id; }, set id(v) { billingRef.current.id = v; }, onMeter: (m) => setBalance(m.balance) },
      });
      if (!session || controller.signal.aborted) { session?.disconnect(); releaseCancelled(controller); return; }
      sessionRef.current = session;
      session.on("connectionQuality", (report: QualityReport) => {
        if (sessionRef.current !== session) return;
        const metrics = report.metrics || {};
        qualityMetricsRef.current = metrics;
        setQualityMetrics(metrics);
        if (phaseRef.current !== "live" || qualityModeRef.current !== "auto" || desiredQualityRef.current !== "sharp") {
          lowQualityReportsRef.current = 0;
          return;
        }
        const limited = measured(metrics.receiveFps) && metrics.receiveFps < 12 && uplinkLimited(metrics);
        lowQualityReportsRef.current = limited ? lowQualityReportsRef.current + 1 : 0;
        if (lowQualityReportsRef.current < 3 || performance.now() - lastAutoSwitchRef.current < 60000) return;
        lowQualityReportsRef.current = 0;
        lastAutoSwitchRef.current = performance.now();
        applyUploadQuality("smooth").then(() => {
          if (sessionRef.current === session && qualityModeRef.current === "auto" && uploadQualityRef.current === "smooth") {
            toast("Switched to Smooth mode for a steadier picture.");
          }
        }).catch(() => toast("Couldn't adjust upload quality. Try selecting Smooth mode.", true));
      });
      applyUploadQuality(desiredQualityRef.current, session).catch(() => toast("Couldn't apply upload quality to the live connection.", true));
      setWarmup("Warming up");
      session.on("connectionChange", (s: string) => { if (s === "reconnecting") setWarmup("Reconnecting"); if (s === "disconnected" && sessionRef.current === session) stop("The live connection dropped. Your call shows a dark screen; go live again to continue.", true); });
      session.on("sessionEnded", () => { if (sessionRef.current === session) stop("The live service paused the session. Unused time was returned. Go live again in a moment.", true); });
      session.on("error", (e: Error) => toast(e?.message || "Live error.", true));
      const t = timersRef.current;
      t.stall = window.setTimeout(() => { if (sessionRef.current === session && phaseRef.current !== "live") stop("No video came back. Go live again."); }, FIRST_FRAME_TIMEOUT_MS);
      t.stopBeat = every(HEARTBEAT_MS, async () => {
        const id = billingRef.current.id;
        if (!id) return;
        try {
          const m = await heartbeat(id);
          setBalance(m.balance);
          setLeft({ seconds: Math.max(0, m.paid_seconds - m.elapsed) + Math.max(0, m.balance), at: Date.now() });
          // One gentle nudge per session when under a minute is left, so the call never cuts off by surprise.
          const remaining = Math.max(0, m.paid_seconds - m.elapsed) + Math.max(0, m.balance);
          if (!m.stop && remaining < 60 && !lowShownRef.current) { lowShownRef.current = true; setTopUp("low"); }
          if (m.stop) {
            billingRef.current.id = null;
            stop("You're out of credits. Your call shows a dark screen until you go live again.", true);
            setTopUp("ended");
          }
        } catch { /* next beat */ }
      });
    } catch (error) {
      if (!controller.signal.aborted && abortRef.current === controller) stop((error as Error).message || "Couldn't start a live session.");
      else releaseCancelled(controller);
    }
  }

  // A cancelled attempt may receive its session id after stop() ran; end that session so no credits stay reserved.
  function releaseCancelled(controller: AbortController) {
    if (abortRef.current && abortRef.current !== controller) return; // a newer attempt owns the session now
    const id = billingRef.current.id;
    if (!id) return;
    billingRef.current.id = null;
    endMeter(id).then((m) => { if (m) setBalance(m.balance); });
  }

  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  function onFrame() {
    if (phaseRef.current !== "connecting") return;
    const video = aiRef.current;
    if (video && !hasContent(video)) {
      if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(() => onFrame()); else setTimeout(onFrame, 100);
      return;
    }
    clearTimeout(timersRef.current.stall);
    clearTimeout(timersRef.current.streamGrace);
    holdRef.current = null; setHolding(false);
    if (billingRef.current.id) videoStarted(billingRef.current.id);
    setPhase("live"); setWarmup("");
    timersRef.current.startedAt = performance.now();
    timersRef.current.tick = window.setInterval(() => {
      const s = (performance.now() - (timersRef.current.startedAt || 0)) / 1000;
      setSeconds(s);
      if (status && s >= status.max_session_seconds) stop(`Session limit reached (${clock(status.max_session_seconds)}). Go live again to continue.`);
    }, 250);
  }

  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    const onVisibility = () => {
      clearTimeout(timersRef.current.hidden);
      if (document.hidden && sessionRef.current && !vcamActiveRef.current) timersRef.current.hidden = window.setTimeout(() => stopRef.current("Paused because the tab was hidden."), HIDDEN_GRACE_MS);
    };
    const onHide = () => { if (billingRef.current.id) endMeterOnUnload(billingRef.current.id); sessionRef.current?.disconnect(); };
    document.addEventListener("visibilitychange", onVisibility);
    addEventListener("pagehide", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      removeEventListener("pagehide", onHide);
      onHide();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      voiceRigRef.current?.close();
    };
  }, []);

  // ---------- Livestream (RTMP Relay) ----------
  async function beginStream(url: string, key: string) {
    const video = aiRef.current;
    if (!video || phaseRef.current !== "live") return toast("Go live first, then start streaming.", true);
    setStreaming("starting");
    const comp = compositor(video, { label: showWatermark, compactLabel: compactWatermark, getOverlay: () => overlayConfigRef.current, getHold: () => holdRef.current });
    let mic: MediaStream | null = null;
    let audioTrack: MediaStreamTrack | null = voiceRigRef.current?.track() || null;
    if (!audioTrack && voiceMode !== "off") {
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        audioTrack = mic.getAudioTracks()[0] || null;
      } catch {
        toast("No microphone access, so the stream will have no sound.");
      }
    }
    try {
      const handle = await startStream({
        video: comp.stream,
        audio: audioTrack,
        url,
        key,
        onEnd: (message) => {
          comp.stop(); mic?.getTracks().forEach((t) => t.stop()); liveStreamRef.current = null; setStreaming("off");
          if (message) toast(message, true);
        },
      });
      liveStreamRef.current = { handle, stopDrawing: comp.stop, mic };
      setStreaming("on"); setStreamOpen(false);
      toast("You're streaming live.");
    } catch (error) {
      comp.stop(); mic?.getTracks().forEach((t) => t.stop()); setStreaming("off");
      toast((error as Error).message || "Couldn't start the stream.", true);
    }
  }

  function stopStream() {
    const current = liveStreamRef.current;
    if (!current) return;
    liveStreamRef.current = null;
    current.handle.stop().finally(() => { current.stopDrawing(); current.mic?.getTracks().forEach((t) => t.stop()); });
    setStreaming("off");
  }

  // ---------- Recording (with Voice Rig / Mic Audio & AI Accent Voice Conversion) ----------
  async function toggleRecord() {
    if (recorderRef.current) { recorderRef.current.rec.stop(); return; }
    const video = aiRef.current;
    if (!video || !live) return;
    const comp = compositor(video, { label: showWatermark, compactLabel: compactWatermark, getOverlay: () => overlayConfigRef.current, getHold: () => holdRef.current });
    let rigTrack: MediaStreamTrack | null = null;
    if (voiceMode !== "off") {
      const rig = await ensureVoiceRig();
      rigTrack = rig?.track() || null;
    }
    const tracks = [...comp.stream.getVideoTracks(), ...(rigTrack ? [rigTrack] : [])];
    const combined = new MediaStream(tracks);
    const type = recorderType(Boolean(rigTrack));
    const rec = new MediaRecorder(combined, type ? { mimeType: type, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 128_000 } : undefined);
    const chunks: Blob[] = [];
    const chosenAccent = accentVoiceId;
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      comp.stop();
      recorderRef.current = null;
      setRecording(false);
      let blob = new Blob(chunks, { type: rec.mimeType || "video/webm" });
      if (!blob.size) return;
      if (chosenAccent && rigTrack) {
        setConvertingVoice(true);
        toast("Applying AI accent voice to your recording…");
        try {
          blob = await withAiVoice(blob, chosenAccent, status?.voice_max_seconds || 600);
        } catch (err) {
          toast(`${(err as Error).message || "Could not apply AI voice."} Saved with your live voice.`, true);
        } finally {
          setConvertingVoice(false);
        }
      }
      const mp4 = blob.type.includes("mp4");
      if (mp4 && !status?.vyra_dev_mode) {
        try { blob = await withProvenance(blob); } catch { /* keep as recorded */ }
      }
      const a = Object.assign(document.createElement("a"), {
        href: URL.createObjectURL(blob),
        download: `vyrani-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}${chosenAccent ? "-" + chosenAccent : ""}.${mp4 ? "mp4" : "webm"}`,
      });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      toast(`Saved ${a.download}`);
    };
    rec.start(1000);
    recorderRef.current = { rec, chunks, stop: comp.stop, accentId: chosenAccent };
    setRecording(true);
  }

  // ---------- Clean Pop-Out Camera Window ----------
  async function openCleanPopOut() {
    const targetVideo = live && aiRef.current ? aiRef.current : camRef.current;
    if (!targetVideo) return toast("Turn on your camera first.", true);
    try {
      if ("requestPictureInPicture" in targetVideo && document.pictureInPictureEnabled) {
        await (targetVideo as HTMLVideoElement & { requestPictureInPicture(): Promise<void> }).requestPictureInPicture();
        return;
      }
    } catch { /* fallback to chromeless window */ }
    const pop = window.open("", "vyra_clean_cam", "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no");
    if (!pop) return toast("Allow pop-ups to open the clean camera window.", true);
    pop.document.title = "VYRANI AI Camera Output";
    pop.document.body.style.cssText = "margin:0;background:#000;display:grid;place-items:center;height:100vh;overflow:hidden";
    const v = pop.document.createElement("video");
    v.autoplay = true;
    v.playsInline = true;
    v.muted = true;
    v.style.cssText = "width:100%;height:100%;object-fit:contain";
    v.srcObject = (window.__VYRA_LIVE_OUTPUT_STREAM__ as MediaStream) || (targetVideo.srcObject as MediaStream);
    pop.document.body.append(v);
    v.play().catch(() => {});
  }

  const used = Math.ceil(seconds) * (perMinute / 60);
  const canApply = !applying && !describing && (photo ? consent : text.trim().length >= 2);
  const accentVoices: AccentVoice[] = status?.voices || [];

  return (
    <div className="studio" data-vyra-studio="true">
      {consentGate.dialog}
      {topUp && <TopUp reason={topUp} onClose={() => setTopUp(null)} />}
      {slowNet && (
        <Dialog title="Your connection is slow right now" onClose={() => setSlowNet(null)}>
          <div className="consent">
            <p>Live AI video plus your video call need about <strong>2 Mbps upload</strong> together. Yours measured <strong>{slowNet.uploadMbps.toFixed(1)} Mbps</strong>
              {slowNet.latencyMs > 400 ? ` with a ${Math.round(slowNet.latencyMs)} ms delay` : ""}, so the AI look and the call would stutter and lag.</p>
            <p className="muted">Try Wi-Fi closer to the router, a wired connection, or 5G, and pause uploads, cloud sync and screen recording. "Go live anyway" uses Smooth quality. Nothing has been charged.</p>
            <div className="consent-actions">
              <button type="button" className="btn btn-ghost" onClick={() => { setSlowNet(null); slowOkRef.current = true; goLive(); }}>Go live anyway</button>
              <button type="button" className="btn btn-primary" onClick={() => setSlowNet(null)}>OK, I'll fix it</button>
            </div>
          </div>
        </Dialog>
      )}
      <section className="studio-stage-col">
        {live && left && (() => {
          const remaining = Math.max(0, Math.round(left.seconds - (Date.now() - left.at) / 1000));
          if (remaining > 120) return null;
          return (
            <div className={`credit-warn${remaining <= 30 ? " is-urgent" : ""}`} role="status">
              <span><strong>{clock(remaining)}</strong> of live left.{remaining <= 30 ? " Your call will show a dark screen when it runs out." : ""}</span>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => window.open("/app/credits", "_blank", "noopener")}>Add credits</button>
            </div>
          );
        })()}
        {holding && !live && (
          <div className="credit-warn" role="status">
            <span>Your call is showing a <strong>dark screen</strong>, not your camera.</span>
            <span className="credit-warn-actions">
              <button type="button" className="btn btn-sm btn-primary" onClick={goLive}>Go live again</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => { holdRef.current = null; setHolding(false); setRealBeforeLive(true); stopStream(); }}>Show my real camera</button>
            </span>
          </div>
        )}
        <div ref={stageRef} className={`stage stage-${phase}`}>
          <video ref={aiRef} className="stage-ai" playsInline autoPlay muted onPlaying={onFrame} />
          <video ref={camRef} className={`stage-cam${mirrored ? " mirrored" : ""}${live ? " pip" : ""}`} playsInline autoPlay muted />
          {phase === "off" && (
            <div className="stage-empty">
              <h2>Turn on your camera</h2>
              <p className="muted">{sourceStarting ? "Allow camera access in your browser if prompted." : "Nothing leaves your device until you press Go live."}</p>
              <button className="btn btn-light btn-lg" disabled={sourceStarting} onClick={() => openSource()}>{sourceStarting ? "Opening camera…" : "Turn on camera"}</button>
            </div>
          )}
          {warmup && <WarmupProgress label={warmup} since={warmStart} />}
          {live && <div className="stage-live"><span className="live-dot" /> Live <span className="num">{clock(seconds)}</span></div>}
          {(live || phase === "camera") && showWatermark && (
            <div className={`stage-label${compactWatermark ? " stage-label-compact" : ""}`} data-testid="stage-watermark" data-compact={compactWatermark ? "true" : "false"}>
              VYRANI · AI
            </div>
          )}
          {vcamActive && extInstalled && (live || phase === "camera") && (
            <div className="stage-vcam-pill" title="What people in your call see right now">
              <span className="live-dot" />
              {live ? "Call sees: your AI look" : holding ? "Call sees: a dark screen" : realBeforeLive ? "Call sees: your real camera" : "Call sees: a dark screen"}
              {!live && !holding && (
                <button type="button" className="stage-vcam-switch" onClick={() => {
                  const showReal = !realBeforeLive;
                  setRealBeforeLive(showReal);
                  holdRef.current = showReal ? null : holdCard(null, "Starting soon", "VYRANI");
                }}>{realBeforeLive ? "Hide camera" : "Show real camera"}</button>
              )}
            </div>
          )}
          {overlayVisible && (overlayTitle || overlaySub) && (
            <div className="stage-overlay-banner" data-testid="stage-overlay">
              <span className="stage-overlay-bar" />
              {overlayLogoUrl && <img src={overlayLogoUrl} alt="" className="stage-overlay-logo" />}
              <div>
                {overlayTitle && <strong>{overlayTitle}</strong>}
                {overlaySub && <small>{overlaySub}</small>}
              </div>
            </div>
          )}
          {streaming === "on" && <div className="stage-streaming"><span className="live-dot" /> Streaming</div>}
          {look && <div className="stage-look">{look.imageUrl && <img src={look.imageUrl} alt="" />}<span>{look.label}</span></div>}
        </div>

        <div className="controls">
          <div className="controls-side">
            <select
              className="input input-sm cam-select"
              value={cameraId}
              aria-label="Video source"
              disabled={sourceStarting}
              onChange={(e) => {
                const v = e.target.value;
                setCameraId(v);
                if (v === SOURCE_FILE) sourceVideoInputRef.current?.click();
                else openSource(v);
              }}
            >
              {cameras.length
                ? cameras.map((c, i) => <option key={c.deviceId} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>)
                : <option value="">Default camera</option>}
              <option value={SOURCE_FILE}>{fileSourceName ? `Video: ${fileSourceName}` : "Video file (loop)…"}</option>
              <option value={SOURCE_SCREEN}>Share screen / window…</option>
            </select>
            <input
              ref={sourceVideoInputRef}
              type="file"
              accept="video/mp4,video/webm,video/quicktime"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) openSource(SOURCE_FILE, f);
                e.target.value = "";
              }}
            />
            <button className="icon-btn" aria-pressed={mirrored} aria-label="Mirror preview" title="Mirror preview" onClick={() => setMirrored((m) => !m)}><MirrorIcon /></button>
          </div>
          <button className={`golive${live || busy ? " golive-stop" : ""}`} onClick={goLive} disabled={sourceStarting || phase === "stopping" || (!look && !live && !busy)}>
            <span className="golive-dot" />{live ? "End" : busy ? "Cancel" : "Go live"}
          </button>
          <div className="controls-side controls-end">
            <button
              className={`icon-btn${recording ? " recording" : ""}`}
              aria-pressed={recording}
              aria-label={recording ? "Stop recording" : "Record with voice"}
              title={recording ? "Stop recording" : "Record video + voice"}
              onClick={toggleRecord}
              disabled={!live || convertingVoice}
            >
              {convertingVoice ? <Spinner /> : <RecordIcon />}
            </button>
            <button
              className={`icon-btn${streaming === "on" ? " recording" : ""}`}
              aria-pressed={streaming === "on"}
              aria-label={streaming === "on" ? "Stop streaming" : "Stream"}
              title={streaming === "on" ? "Stop streaming" : "Stream to YouTube, Twitch and more"}
              onClick={() => (streaming === "on" ? stopStream() : setStreamOpen(true))}
              disabled={streaming === "starting"}
            >
              <BroadcastIcon />
            </button>
            <button className="icon-btn" aria-label="Full screen" title="Full screen" onClick={() => stageRef.current?.requestFullscreen?.()}><ExpandIcon /></button>
          </div>
        </div>

        <div className="quality-control">
          <span id="upload-quality-label">Quality</span>
          <div className="quality-options" role="group" aria-labelledby="upload-quality-label">
            {(["auto", "smooth", "sharp"] as const).map(mode => (
              <button type="button" key={mode} aria-pressed={qualityMode === mode} onClick={() => chooseQuality(mode)}>
                {mode === "auto" ? "Auto" : mode === "smooth" ? "Smooth" : "Sharp"}
              </button>
            ))}
          </div>
          <span className="muted" data-testid="active-quality">Using {uploadQuality === "smooth" ? "Smooth" : "Sharp"}</span>
        </div>
        {sourceError && <p className="alert alert-error" role="alert" data-testid="source-error">{sourceError}</p>}
        <div className="session-strip num" aria-live="off">
          <span>{live ? `${clock(seconds)} live` : sourceStarting ? "Opening camera…" : phase === "off" ? "Turn on your camera to continue" : look ? "Ready to go live" : "Choose who to become →"}</span>
          <span>{live ? `${used.toLocaleString("en-US")} credits used` : `${perMinute} credits a minute`}</span>
          <span>{me ? `${me.balance.toLocaleString("en-US")} left · ${minutes(me.balance, perMinute)}` : ""}</span>
        </div>
        {live && (
          <div className="telemetry" data-testid="live-telemetry" aria-label="Live connection">
            <p className="telemetry-values">
              <span>Sending {metricNumber(qualityMetrics?.sendFps)} fps</span><span aria-hidden="true"> · </span>
              <span>Receiving {metricNumber(qualityMetrics?.receiveFps)} fps</span><span aria-hidden="true"> · </span>
              <span title="Round-trip network delay, not total camera-to-display delay">Delay {metricNumber(qualityMetrics?.rttMs)} ms</span><span aria-hidden="true"> · </span>
              <span>Upload {measured(qualityMetrics?.sendKbps) ? (qualityMetrics.sendKbps / 1000).toFixed(1) : "–"} Mbps</span>
            </p>
            {qualityMetrics && qualityHint(qualityMetrics) && <p className="telemetry-hint" data-testid="quality-hint">{qualityHint(qualityMetrics)}</p>}
          </div>
        )}
      </section>

      <aside className="composer" aria-label="Studio controls">
        <div className="studio-tabs" role="tablist" aria-label="Studio tools">
          <button type="button" role="tab" aria-selected={tab === "look"} className={`studio-tab${tab === "look" ? " active" : ""}`} onClick={() => setTab("look")}>
            <CameraIcon /><span>Look</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === "voice"} className={`studio-tab${tab === "voice" ? " active" : ""}`} onClick={() => setTab("voice")}>
            <span>Voice</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === "scenes"} className={`studio-tab${tab === "scenes" ? " active" : ""}`} onClick={() => setTab("scenes")}>
            <span>Scenes</span>
          </button>
          {!phone && <button type="button" role="tab" aria-selected={tab === "vcam"} className={`studio-tab${tab === "vcam" ? " active" : ""}`} onClick={() => setTab("vcam")}>
            <StudioIcon /><span>Virtual Cam</span>
          </button>}
        </div>

        {tab === "look" && (
          <div className="tab-pane">
            <h1 className="composer-title">Who do you want to be?</h1>
            <p className="muted composer-lead">Add a photo of a character, describe one, or both. Changes apply live.</p>

            {photo ? (
              <div className="photo-crop-card">
                <div className="photo-chip">
                  <img
                    src={photo.url}
                    alt="Character reference"
                  />
                  <div className="photo-chip-text">
                    <strong>Character photo</strong>
                    <span className="muted">{describing ? "Reading the photo…" : "VYRANI maps this face onto you."}</span>
                  </div>
                  <button className="icon-btn" aria-label="Remove photo" onClick={clearPhoto}><CloseIcon /></button>
                </div>
                <div className="crop-controls">
                  <label className="field-label">
                    Zoom ({cropZoom.toFixed(1)}×)
                    <input type="range" min={1} max={2.5} step={0.05} value={cropZoom} onChange={(e) => setCropZoom(Number(e.target.value))} />
                  </label>
                  <label className="field-label">
                    Vertical framing
                    <input type="range" min={-1} max={1} step={0.05} value={cropOffset.y} onChange={(e) => setCropOffset((o) => ({ ...o, y: Number(e.target.value) }))} />
                  </label>
                </div>
              </div>
            ) : (
              <button
                className="photo-drop"
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); pickPhoto(e.dataTransfer.files[0]); }}
              >
                <ImageIcon />
                <span><strong>Add a character photo</strong><br /><span className="muted">One clear face, looking at the camera</span></span>
              </button>
            )}
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { pickPhoto(e.target.files?.[0]); e.target.value = ""; }} />

            {status?.assist && (
              <form className="assist-bar" onSubmit={handleGenerateLook}>
                <input
                  className="input input-sm"
                  placeholder="Describe a look: e.g. navy blazer, brighter room…"
                  value={ideaInput}
                  onChange={(e) => setIdeaInput(e.target.value)}
                  maxLength={200}
                />
                <button className="btn btn-sm btn-ghost" type="submit" disabled={creatingLook || ideaInput.trim().length < 2}>
                  {creatingLook ? <Spinner /> : "Write"}
                </button>
              </form>
            )}

            <div className="field">
              <label className="field-label" htmlFor="lookText">{photo ? "Describe them (helps the likeness)" : "Or describe it"}</label>
              <textarea
                id="lookText"
                className="input"
                rows={3}
                maxLength={1000}
                value={text}
                onChange={(e) => { setText(e.target.value); setIdeaLabel(null); }}
                placeholder={photo ? "Skin tone, hair, clothing…" : "A charcoal blazer and a tidy home office"}
              />
            </div>
            {photo && (
              <label className="check">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>This is me, a fictional character, or someone who agreed to it.</span>
              </label>
            )}
            <button className="btn btn-primary btn-lg btn-block" onClick={() => applyLookState()} disabled={!canApply}>
              {applying ? <><Spinner /> Applying</> : live ? "Apply live" : "Use this look"}
            </button>

            <div className="ideas">
              <p className="field-label">Quick ideas</p>
              <div className="idea-list">
                {IDEAS.map((idea) => (
                  <button key={idea.label} className="idea" onClick={() => { clearPhoto(); setText(idea.prompt); setIdeaLabel(idea.label); }}>{idea.label}</button>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === "voice" && (
          <div className="tab-pane">
            <div className="section-head">
              <h2 className="composer-title">Voice & Lip-Sync</h2>
              <span className={`pill${voiceMode !== "off" ? " pill-ok" : ""}`}>{voiceMode === "off" ? "MIC OFF" : voiceMode.toUpperCase()}</span>
            </div>
            <p className="muted composer-lead">Real-time pitch-adaptive voice effects run free on your device and delay automatically to match the AI video.</p>

            <div className="voice-meter-bar" aria-label="Microphone level" data-level={Math.round(micLevel * 100)}>
              <div ref={voiceMeterFillRef} className="voice-meter-fill" />
            </div>

            <div className="voice-grid">
              {LOCAL_VOICES.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className={`voice-card${voiceMode === v.id ? " active" : ""}`}
                  aria-pressed={voiceMode === v.id}
                  onClick={() => setVoiceMode(v.id)}
                >
                  <strong>{v.name}</strong>
                  <small className="muted">{v.note}</small>
                </button>
              ))}
            </div>

            <label className="check">
              <input type="checkbox" checked={monitorMic} onChange={(e) => setMonitorMic(e.target.checked)} />
              <span>Hear myself live (use headphones to avoid echo)</span>
            </label>

            <div className="field">
              <label className="field-label" htmlFor="syncSlider">
                Lip-sync delay: <span className="num">{syncOffsetMs === 0 ? `Auto (${measuredLagMs ?? 180} ms)` : `${syncOffsetMs > 0 ? "+" : ""}${syncOffsetMs} ms`}</span>
              </label>
              <input
                id="syncSlider"
                type="range"
                min={-300}
                max={300}
                step={20}
                value={syncOffsetMs}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setSyncOffsetMs(val);
                  localStorage.setItem("vyra.voiceSync", String(val));
                }}
              />
            </div>

            {accentVoices.length > 0 && (
              <div className="field">
                <label className="field-label" htmlFor="accentSelect">ElevenLabs AI Accent Voice (applied to recordings)</label>
                <select id="accentSelect" className="input input-sm" value={accentVoiceId} onChange={(e) => setAccentVoiceId(e.target.value)}>
                  <option value="">Keep live voice above (Free)</option>
                  {accentVoices.map((av) => (
                    <option key={av.id} value={av.id}>{av.voice || av.name} · {av.accent} ({av.gender})</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {tab === "scenes" && (
          <div className="tab-pane">
            <h2 className="composer-title">Scenes, Overlays & Brand</h2>
            <p className="muted composer-lead">Trigger looks with hand gestures, voice commands, and customize broadcast graphics.</p>

            <div className="card card-pad studio-subcard">
              <div className="section-head">
                <strong>VYRANI · AI Disclosure Label</strong>
                {canRemoveWatermark ? (
                  <span className="pill pill-ok">Pro Unlocked</span>
                ) : (
                  <Link to="/app/credits" className="pill">Free Tier</Link>
                )}
              </div>
              {canRemoveWatermark ? (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={hideWatermark}
                    onChange={(e) => {
                      setHideWatermark(e.target.checked);
                      localStorage.setItem("vyra.hideWatermark", e.target.checked ? "1" : "0");
                    }}
                  />
                  <span>Hide &ldquo;VYRANI · AI&rdquo; label on non-likeness style prompts (compact label always stays on photo likenesses)</span>
                </label>
              ) : (
                <p className="muted small-line">
                  Free starter sessions display the full <strong>VYRANI · AI</strong> watermark. <Link to="/app/credits">Buy any credit pack</Link> for a smaller badge on likenesses and optional removal on style looks.
                </p>
              )}
            </div>

            <div className="card card-pad studio-subcard">
              <div className="section-head">
                <strong>Lower-Third Broadcast Overlay</strong>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOverlayVisible((v) => !v)}>
                  {overlayVisible ? "Hide banner" : "Show banner"}
                </button>
              </div>
              <div className="field">
                <input
                  className="input input-sm"
                  placeholder="Headline, e.g. Live from Lagos"
                  value={overlayTitle}
                  maxLength={60}
                  onChange={(e) => { setOverlayTitle(e.target.value); localStorage.setItem("vyra.overlayTitle", e.target.value); }}
                />
                <input
                  className="input input-sm"
                  placeholder="Subtitle, e.g. Product Launch Keynote"
                  value={overlaySub}
                  maxLength={80}
                  onChange={(e) => { setOverlaySub(e.target.value); localStorage.setItem("vyra.overlaySub", e.target.value); }}
                />
                <div className="vcam-actions">
                  <label className="btn btn-sm btn-ghost">
                    {overlayLogoUrl ? "Change logo" : "Add logo"}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/svg+xml"
                      hidden
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        const url = URL.createObjectURL(f);
                        const img = new Image();
                        img.onload = () => {
                          overlayLogoImgRef.current = img;
                          setOverlayLogoUrl(url);
                        };
                        img.src = url;
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {overlayLogoUrl && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        overlayLogoImgRef.current = null;
                        setOverlayLogoUrl(null);
                      }}
                    >
                      Remove logo
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="card card-pad studio-subcard">
              <div className="section-head">
                <strong>Hand Gesture &amp; Object Rules</strong>
                <span className={`pill${rulesEnabled ? " pill-ok" : ""}`}>{rulesEnabled ? "ON" : "OFF"}</span>
              </div>
              <label className="check">
                <input type="checkbox" checked={rulesEnabled} onChange={(e) => setRulesEnabled(e.target.checked)} />
                <span>Detect gestures on-device (MediaPipe, private &amp; free)</span>
              </label>
              <div className="rule-builder">
                <select className="input input-sm" value={newRuleTrigger} onChange={(e) => setNewRuleTrigger(e.target.value)} aria-label="Rule trigger">
                  {SCENE_TRIGGERS.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <select className="input input-sm" value={newRuleAction} onChange={(e) => setNewRuleAction(e.target.value)} aria-label="Rule action">
                  {IDEAS.map((i) => <option key={i.label} value={`look:${i.label}`}>Switch to {i.label}</option>)}
                  <option value="overlay:show">Show lower-third banner</option>
                  <option value="overlay:hide">Hide lower-third banner</option>
                </select>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    setRules((list) => [
                      ...list,
                      { id: crypto.randomUUID(), trigger: newRuleTrigger, action: newRuleAction, undo: false, enabled: true },
                    ]);
                  }}
                >
                  Add rule
                </button>
              </div>
              {rules.length > 0 && (
                <ul className="rule-items">
                  {rules.map((r) => (
                    <li key={r.id}>
                      <span>{SCENE_TRIGGERS.find((t) => t.id === r.trigger)?.name || r.trigger} → {r.action}</span>
                      <button type="button" className="icon-btn" aria-label="Delete rule" onClick={() => setRules((list) => list.filter((x) => x.id !== r.id))}><CloseIcon /></button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="card card-pad studio-subcard">
              <div className="section-head">
                <strong>Voice Commands</strong>
                <span className="pill">{commandState}</span>
              </div>
              <div className="idea-list">
                {(["off", "hold", "handsfree"] as const).map((m) => (
                  <button key={m} type="button" className={`idea${commandMode === m ? " active" : ""}`} onClick={() => setCommandMode(m)}>
                    {m === "off" ? "Off" : m === "hold" ? "Hold V to talk" : 'Hands-free ("Vyrani, …")'}
                  </button>
                ))}
              </div>
              {lastCommand && <p className="muted small-line">Last heard: &ldquo;{lastCommand}&rdquo;</p>}
            </div>
          </div>
        )}

        {tab === "vcam" && (
          <div className="tab-pane" data-testid="vcam-panel">
            <div className="section-head">
              <h2 className="composer-title">Virtual Camera</h2>
              <span className={`pill${vcamActive && extInstalled ? " pill-ok" : ""}`}>{vcamActive ? extInstalled ? "Output enabled" : "Setup needed" : "Paused"}</span>
            </div>
            <div className="vcam-readout num" aria-live="off">
              {vcamActive ? (vcamFps > 0 ? `Sending ${vcamFps} fps to calls` : "Not sending yet: turn on your camera") : "Output paused"}
              {vcamMethod && vcamActive ? <span className="dim"> · {vcamMethod === "frames" ? "frame stream" : "canvas"}</span> : null}
            </div>
            <p className="muted composer-lead">
              Send your studio video to supported calling websites in Chrome or Edge on Mac and Windows. The browser extension is free; live AI sessions use your VYRANI credits.
            </p>

            <label className="check">
              <input type="checkbox" checked={vcamActive} onChange={(e) => setVcamActive(e.target.checked)} />
              <span><strong>Enable VYRANI Virtual Camera &amp; Mic output</strong></span>
            </label>

            <div className="card card-pad studio-subcard">
              <div className="section-head">
                <strong>1. Browser Virtual Cam ($0, Zero OS Drivers)</strong>
                <span className={`pill${extInstalled ? " pill-ok" : ""}`}>{extInstalled ? "Extension ready" : extensionStatus === "outdated" ? "Update extension" : extensionStatus === "error" ? "Reload extension" : "Install extension"}</span>
              </div>
              {(extensionStatus === "outdated" || extensionStatus === "error") && (
                <p className="alert alert-info" role="status">
                  {extensionStatus === "outdated" ? "Your VYRANI extension needs an update." : "The VYRANI extension couldn't start."} Your studio still works. Install the latest version from the Chrome Web Store below, remove any older manually loaded VYRANI copy at chrome://extensions, then reload this page.
                </p>
              )}
              <p className="muted small-line">
                Adds <strong>VYRANI AI Virtual Camera</strong> and <strong>VYRANI AI Virtual Microphone</strong> directly into WhatsApp Web, Google Meet, Zoom Web, Discord Web, and Teams Web.
              </p>
              <div className="vcam-actions">
                <a className="btn btn-primary btn-sm" href={EXTENSION_URL} target="_blank" rel="noreferrer">
                  {extInstalled ? "Extension installed" : "Add to Chrome, free"}
                </a>
                <button type="button" className="btn btn-ghost btn-sm" onClick={openCleanPopOut}>
                  Pop-out Clean Window
                </button>
              </div>
              <ol className="vcam-steps muted small-line">
                <li>Click <strong>Add to Chrome</strong> on the store page (works in Chrome and Edge). Then reload this studio and your calling tab.</li>
                <li>Use the same browser profile for both tabs. Turn on your camera, choose a look, and press <strong>Go live</strong>.</li>
                <li>Pick <strong>VYRANI AI Virtual Camera</strong> in your calling website. Ask another participant to confirm they receive your moving video.</li>
              </ol>
            </div>

            <div className="card card-pad studio-subcard">
              <div className="section-head">
                <strong>2. OBS Studio Bridge: works in every desktop app, Windows and macOS, free</strong>
                <span className="pill">Recommended for desktop apps</span>
              </div>
              <p className="muted small-line">
                OBS's own Virtual Camera is properly signed/notarized by OBS and works in WhatsApp Desktop, Zoom,
                Teams, FaceTime and browsers on both Windows and macOS, with no VYRANI Apple or Windows account needed.
              </p>
              <ol className="vcam-steps muted small-line">
                <li>Start your camera + look, and press <strong>Go live</strong>.</li><li>Click <strong>Pop-out Clean Window</strong> below and keep the small window visible.</li>
 <li>In OBS, add a <strong>Window Capture</strong> source and pick “VYRANI AI Camera Output – Chrome”.</li>
                <li>In OBS: Start Virtual Camera. In your calling app, choose <strong>OBS Virtual Camera</strong>.</li>
              </ol>
              <div className="vcam-actions">
                <button type="button" className="btn btn-primary btn-sm" onClick={openCleanPopOut}>
                  Pop-out Clean Window (OBS source)
                </button>
              </div>
            </div>

            <div className="card card-pad studio-subcard">
              <div className="section-head">
                <strong>2b. VYRANI Camera Commander: one-click OBS setup</strong>
                <span className={`pill${obsStatus?.installed ? " pill-ok" : obsStatus ? "" : " pill-muted"}`}>
                  {!obsStatus ? "Checking OBS…" : obsStatus.installed ? "OBS detected" : "OBS not found"}
                </span>
              </div>
              <p className="muted small-line">
                Creates the “VYRANI Camera” scene collection and launches your installed OBS with the virtual camera
                already running. OBS is detected at {obsStatus?.path || "the usual install path"}.
              </p>
              <div className="vcam-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!obsStatus?.installed || obsBusy}
                  onClick={async () => {
                    if (!obsStatus?.installed) {
                      toast("Install OBS Studio from obsproject.com first.", true);
                      window.open("https://obsproject.com/download", "_blank");
                      return;
                    }
                    setObsBusy(true);
                    try {
                      await api("/api/obs/launch", { window_title: obsStatus.window_title || "VYRANI AI Camera Output" });
                      toast("OBS launched with the VYRANI Camera scene and virtual camera running.");
                    } catch (err) {
                      toast(err instanceof Error ? err.message : "Couldn't launch OBS.", true);
                    } finally {
                      setObsBusy(false);
                    }
                  }}
                >
                  {obsBusy ? "Launching OBS…" : "Create VYRANI scene & launch OBS"}
                </button>
              </div>
            </div>

            <div className="card card-pad studio-subcard">
              <div className="section-head">
                <strong>3. Native Desktop Virtual Cam (Windows &amp; macOS Source)</strong>
                <span className={`pill${nativeCamConnected ? " pill-ok" : ""}`}>{nativeCamConnected ? "Bridge Connected" : "Developer Kit"}</span>
              </div>
              <p className="muted small-line">
                Native desktop support is still in development. This download contains source code, not an installable camera. For now, test browser calls using the extension above. A connected bridge alone does not mean a desktop app can receive video.
              </p>
              <div className="vcam-actions">
                <a className="btn btn-ghost btn-sm" href="/api/virtual-cam/native.zip" download="vyrani-native-virtual-cam.zip">
                  Download Native Companion Source
                </a>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStreamOpen(true)}>
                  RTMP Stream (YouTube / Twitch)
                </button>
              </div>
            </div>
          </div>
        )}
          <div className="setup-guide-row">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSetupOpen(true)}>Setup guide</button>
            </div>
          </aside>
      {setupOpen && <SetupTour extensionReady={extInstalled} onClose={dismissSetup} />}
      {streamOpen && <StreamDialog live={live} busy={streaming === "starting"} onClose={() => setStreamOpen(false)} onStart={beginStream} />}
    </div>
  );
}

function StreamDialog({ live, busy, onClose, onStart }: { live: boolean; busy: boolean; onClose: () => void; onStart: (url: string, key: string) => void }) {
  const saved = (() => { try { return JSON.parse(localStorage.getItem("vyra.streamDest") || "{}"); } catch { return {}; } })();
  const [platform, setPlatform] = useState<string>(saved.platform || "youtube");
  const [url, setUrl] = useState<string>(saved.url || PLATFORMS[0].url);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const chosen = PLATFORMS.find((p) => p.id === platform) || PLATFORMS[0];
  function pick(id: string) {
    const next = PLATFORMS.find((p) => p.id === id)!;
    setPlatform(id);
    setUrl(next.url);
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^rtmps?:[/][/][^\s/]+/i.test(url.trim())) return setError("Use the RTMP or RTMPS server URL from your platform.");
    if (!key.trim()) return setError("Paste your stream key.");
    setError("");
    try { localStorage.setItem("vyra.streamDest", JSON.stringify({ platform, url: url.trim() })); } catch { /* storage blocked */ }
    onStart(url.trim(), key.trim());
  }
  return (
    <Dialog title="Stream your look" onClose={onClose}>
      <form className="stream-form" onSubmit={submit} noValidate>
        <div className="platforms" role="radiogroup" aria-label="Platform">
          {PLATFORMS.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={platform === p.id} className="platform" onClick={() => pick(p.id)}>{p.name}</button>
          ))}
        </div>
        <Field label="Server URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="rtmp://" spellCheck={false} autoComplete="off" />
        <Field label="Stream key" reveal value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" help={`Find it in ${chosen.help}. It's sent once and never saved.`} />
        {!live && <div className="alert alert-info">Go live first. The stream sends exactly what's on your stage, with your microphone.</div>}
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <button className="btn btn-primary btn-lg btn-block" disabled={!live || busy}>{busy ? <><Spinner /> Connecting</> : "Start streaming"}</button>
      </form>
    </Dialog>
  );
}
