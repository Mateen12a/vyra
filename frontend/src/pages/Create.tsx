import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { CameraIcon, ImageIcon, PixelLoader, RecordIcon, useToast } from "../components/ui";
import { api, upload } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useConsentGate } from "../components/Consent";

// Make a short video on any device, phones first: film or pick a clip, choose who to become from one photo, pick a
// voice (keep yours, a preset, or a sample you upload), then download or share. Runs on the clip tool, not live.
type Voice = { id: string; voice: string; accent: string; gender: string };
type Job = { id: string; status: string; message: string; voice?: string | null };
const MAX_SECONDS = 10;
const STAGES = ["queued", "preparing", "transforming", "voice", "encoding", "completed"];

function useObjectUrl(file: File | Blob | null) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!file) { setUrl(""); return; }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

// Records a short voice sample with the microphone, for people who'd rather speak than find a file.
function VoiceRecorder({ onDone }: { onDone: (blob: Blob) => void }) {
  const [state, setState] = useState<"idle" | "recording">("idle");
  const [left, setLeft] = useState(15);
  const rec = useRef<MediaRecorder | null>(null);
  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => { stream.getTracks().forEach((t) => t.stop()); onDone(new Blob(chunks, { type: recorder.mimeType || "audio/webm" })); setState("idle"); };
      rec.current = recorder;
      recorder.start();
      setState("recording"); setLeft(15);
    } catch { alert("Microphone access was blocked. Upload a voice file instead."); }
  }
  useEffect(() => {
    if (state !== "recording") return;
    const t = setInterval(() => setLeft((n) => { if (n <= 1) { rec.current?.stop(); return 0; } return n - 1; }), 1000);
    return () => clearInterval(t);
  }, [state]);
  return state === "recording"
    ? <button type="button" className="btn btn-danger" onClick={() => rec.current?.stop()}><RecordIcon /> Stop · {left}s</button>
    : <button type="button" className="btn btn-ghost" onClick={start}><RecordIcon /> Record my voice</button>;
}

export default function Create() {
  const { me, catalogue, refresh } = useAuth();
  const toast = useToast();
  const [video, setVideo] = useState<File | null>(null);
  const [duration, setDuration] = useState(0);
  const [photo, setPhoto] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voice, setVoice] = useState<string>("");
  const [sample, setSample] = useState<Blob | null>(null);
  const [voiceConsent, setVoiceConsent] = useState(false);
  const [quality, setQuality] = useState<"preview" | "detail">("detail");
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const consentGate = useConsentGate();
  const videoUrl = useObjectUrl(video), photoUrl = useObjectUrl(photo), sampleUrl = useObjectUrl(sample);

  useEffect(() => { api<{ voices?: Voice[] }>("/api/live/status").then((s) => setVoices(s.voices || [])).catch(() => {}); }, []);

  // Follow the job until it ends.
  useEffect(() => {
    if (!job || ["completed", "failed", "cancelled"].includes(job.status)) return;
    const t = setInterval(() => api<Job>(`/api/jobs/${job.id}`).then((next) => {
      setJob(next);
      if (["completed", "failed"].includes(next.status)) refresh();
    }).catch(() => {}), 2500);
    return () => clearInterval(t);
  }, [job, refresh]);

  const clipCredits = catalogue?.tools?.clip ?? 60, voiceCredits = voice ? (catalogue?.tools?.voice_minute ?? 8) : 0;
  const cost = clipCredits + voiceCredits;
  const tooLong = duration > MAX_SECONDS + 0.3;
  const ready = video && photo && consent && !tooLong && (voice !== "sample" || (sample && voiceConsent));

  async function create() {
    if (!ready || !video || !photo) return;
    if (!(await consentGate.ensure())) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("video", video, video.name || "clip.mp4");
      form.append("reference", photo, photo.name || "photo.jpg");
      form.append("quality", quality);
      if (voice) form.append("voice", voice);
      if (voice === "sample" && sample) {
        form.append("voice_sample", sample, (sample as File).name || "voice.webm");
        form.append("voice_consent", "yes");
      }
      setJob(await upload<Job>("/api/jobs", form, 180000));
      refresh();
    } catch (err) { toast((err as Error).message, true); }
    finally { setBusy(false); }
  }

  async function share() {
    if (!job) return;
    try {
      const blob = await (await fetch(`/api/jobs/${job.id}/result`)).blob();
      const file = new File([blob], "vyrani-video.mp4", { type: "video/mp4" });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: "Made with Vyrani" });
      else toast("Sharing isn't available here. Use Download instead.");
    } catch { /* the share sheet was closed */ }
  }

  if (job) {
    const step = Math.max(0, STAGES.indexOf(job.status));
    const done = job.status === "completed", failed = job.status === "failed" || job.status === "cancelled";
    return (
      <div className="page create">
        <header className="page-head"><div><p className="kicker">Create video</p><h1 className="page-title">{done ? "Your video is ready" : failed ? "That didn't work" : "Making your video"}</h1></div></header>
        {!done && !failed && (
          <div className="create-progress" role="status">
            <PixelLoader label="Making your video" />
            <div><strong>{job.message}</strong><span className="muted">Usually 1 to 3 minutes. You can leave this page; it keeps going.</span></div>
            <div className="create-bar"><span style={{ width: `${Math.round(((step + 1) / STAGES.length) * 100)}%` }} /></div>
          </div>
        )}
        {failed && <div className="alert alert-danger">{job.message} Your credits were returned.</div>}
        {done && (
          <>
            {job.message && job.message !== "Your result is ready to review" && <div className="alert alert-info">{job.message}</div>}
            <video className="create-result" src={`/api/jobs/${job.id}/result`} controls playsInline autoPlay muted loop />
            <div className="create-actions">
              <a className="btn btn-primary btn-lg" href={`/api/jobs/${job.id}/result`} download="vyrani-video.mp4">Download</a>
              <button type="button" className="btn btn-ghost btn-lg" onClick={share}>Share</button>
            </div>
            <p className="dim small-line">Download it now: videos are deleted from our servers after 7 days, and your photo, clip and voice sample
              were already deleted when this finished. The file carries a tag saying it was made with AI. Share it only with the consent of anyone shown.</p>
          </>
        )}
        {(done || failed) && <button type="button" className="btn btn-ghost" onClick={() => setJob(null)}>Make another</button>}
      </div>
    );
  }

  return (
    <div className="page create">
      {consentGate.dialog}
      <header className="page-head"><div><p className="kicker">Create video</p><h1 className="page-title">Become anyone in a short video</h1></div></header>
      <p className="muted lead-line">Film up to {MAX_SECONDS} seconds, add one photo of who to become, and choose a voice. Works on your phone.</p>

      <section className="create-step">
        <h2><span className="create-num">1</span> Your video</h2>
        {videoUrl
          ? <video className="create-preview" src={videoUrl} controls playsInline muted onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)} />
          : <p className="muted">Face the camera in good light. Talk, smile, move naturally.</p>}
        {tooLong && <p className="field-error">This clip is {Math.round(duration)} seconds. Trim it to {MAX_SECONDS} seconds or film a shorter one.</p>}
        <div className="create-pickers">
          <label className="btn btn-primary"><CameraIcon /> Film now<input hidden type="file" accept="video/*" capture="user" onChange={(e) => setVideo(e.target.files?.[0] || null)} /></label>
          <label className="btn btn-ghost">Choose a video<input hidden type="file" accept="video/*" onChange={(e) => setVideo(e.target.files?.[0] || null)} /></label>
        </div>
      </section>

      <section className="create-step">
        <h2><span className="create-num">2</span> Who to become</h2>
        <div className="create-photo-row">
          {photoUrl ? <img className="create-photo" src={photoUrl} alt="The person you'll become" /> : <span className="create-photo create-photo-empty"><ImageIcon /></span>}
          <div>
            <p className="muted">One clear, front-facing photo with even light. Head and shoulders works best.</p>
            <label className="btn btn-ghost">{photo ? "Change photo" : "Add a photo"}<input hidden type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files?.[0] || null)} /></label>
          </div>
        </div>
        <label className="create-check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>This is me, an AI-made person, or someone who agreed to this.</span></label>
      </section>

      <section className="create-step">
        <h2><span className="create-num">3</span> Voice</h2>
        <div className="create-voices" role="radiogroup" aria-label="Voice">
          <button type="button" role="radio" aria-checked={voice === ""} className={`chip${voice === "" ? " is-on" : ""}`} onClick={() => setVoice("")}>Keep my voice</button>
          {voices.map((v) => (
            <button key={v.id} type="button" role="radio" aria-checked={voice === v.id} className={`chip${voice === v.id ? " is-on" : ""}`} onClick={() => setVoice(v.id)}>
              {v.accent} {v.gender}
            </button>
          ))}
          <button type="button" role="radio" aria-checked={voice === "sample"} className={`chip${voice === "sample" ? " is-on" : ""}`} onClick={() => setVoice("sample")}>A voice I upload</button>
        </div>
        {voice === "sample" && (
          <div className="create-sample">
            <p className="muted">10 to 30 seconds of one person speaking clearly, with no music. Your words will be said in this voice.</p>
            <div className="create-pickers">
              <VoiceRecorder onDone={setSample} />
              <label className="btn btn-ghost">Upload audio<input hidden type="file" accept="audio/*" onChange={(e) => setSample(e.target.files?.[0] || null)} /></label>
            </div>
            {sampleUrl && <audio src={sampleUrl} controls />}
            <label className="create-check"><input type="checkbox" checked={voiceConsent} onChange={(e) => setVoiceConsent(e.target.checked)} />
              <span>This is my voice, or I have permission to use it.</span></label>
          </div>
        )}
      </section>

      <section className="create-step">
        <h2><span className="create-num">4</span> Quality</h2>
        <div className="create-voices" role="radiogroup" aria-label="Quality">
          <button type="button" role="radio" aria-checked={quality === "detail"} className={`chip${quality === "detail" ? " is-on" : ""}`} onClick={() => setQuality("detail")}>Best (720p)</button>
          <button type="button" role="radio" aria-checked={quality === "preview"} className={`chip${quality === "preview" ? " is-on" : ""}`} onClick={() => setQuality("preview")}>Fast (480p)</button>
        </div>
      </section>

      <div className="create-submit">
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!ready || busy || !me?.user.verified} onClick={create}>
          {busy ? "Uploading…" : `Create video · ${cost} credits`}
        </button>
        {!me?.user.verified && <p className="field-error">Verify your email first to make videos.</p>}
        {me && me.balance < cost && <p className="muted">You have {me.balance} credits. <Link to="/app/credits">Add credits</Link></p>}
      </div>
    </div>
  );
}
