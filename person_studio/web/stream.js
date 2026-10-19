"use strict";
(() => {
  class VyraStream {
    constructor(video, audioTrack, endpoint = "/api/live/stream") {
      this.video = video;
      this.audioTrack = audioTrack;
      this.endpoint = endpoint;
      this.socket = null;
      this.recorder = null;
      this.stream = null;
      this.state = "idle";
      this.handlers = new Set();
      this.queue = Promise.resolve();
      this.stopDrawing = null;
      this.audioClone = null;
      this.startTimer = null;
      this.authToken = window.vyraConnection && !window.vyraConnection.base ? window.vyraConnection.token : "";
    }
    onChange(handler) { this.handlers.add(handler); return () => this.handlers.delete(handler); }
    emit(state, detail = "") {
      this.state = state;
      for (const handler of this.handlers) handler({ state, detail });
    }
    async start() {
      if (this.state !== "idle") throw new Error("A livestream is already starting or active.");
      this.emit("connecting");
      try {
        const WebmRecorder = window.MediaRecorder;
        if (!WebmRecorder || typeof WebmRecorder.isTypeSupported !== "function") throw new Error("This browser cannot create a WebM livestream.");
        const connection = window.vyraConnection;
        const authorization = this.authToken && (!connection?.base || new URL(connection.base, location.href).origin === location.origin)
          ? { Authorization: `Bearer ${this.authToken}` } : {};
        const response = await fetch(`${this.endpoint}/ticket`, { method: "POST", headers: { ...authorization, "Content-Type": "application/json" }, body: "{}" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.detail || "Could not start the livestream.");
        const url = new URL(`${this.endpoint}/${encodeURIComponent(payload.ticket)}`, location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(url);
        socket.binaryType = "arraybuffer";
        this.socket = socket;
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("The stream server did not respond.")), 10000);
          this.startTimer = timeout;
          socket.onopen = () => { socket.onmessage = (event) => {
            let message;
            try { message = typeof event.data === "string" ? JSON.parse(event.data) : {}; }
            catch { return reject(new Error("The stream server sent an invalid response.")); }
            if (message.type === "ready") { clearTimeout(timeout); resolve(); }
            if (message.type === "error") { clearTimeout(timeout); reject(new Error(message.message || "The stream relay failed.")); }
          }; };
          socket.onerror = () => { clearTimeout(timeout); reject(new Error("Could not connect to the stream relay.")); };
          socket.onclose = (event) => {
            clearTimeout(timeout);
            if (this.state === "live") this.emit("error", event.reason || "The stream connection closed.");
            else if (this.state === "connecting") reject(new Error(event.reason || "The stream connection closed."));
          };
        });
        if (this.state !== "connecting") throw new Error("Livestream start was cancelled.");
        this.stream = this.video.captureStream(30);
        if (this.audioTrack && this.audioTrack.readyState === "live") {
          this.audioClone = this.audioTrack.clone();
          this.stream.addTrack(this.audioClone);
        }
        const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((type) => WebmRecorder.isTypeSupported(type));
        if (!mimeType) throw new Error("This browser cannot create the WebM stream FFmpeg needs.");
        this.recorder = new WebmRecorder(this.stream, { mimeType, videoBitsPerSecond: 6000000, audioBitsPerSecond: 128000 });
        this.recorder.ondataavailable = (event) => {
          if (!event.data.size || this.socket?.readyState !== WebSocket.OPEN) return;
          if (this.socket.bufferedAmount > 8 * 1024 * 1024) {
            this.emit("error", "Your upload cannot keep up with the stream. Lower the camera resolution or improve your connection.");
            this.dispose();
            return;
          }
          this.queue = this.queue.then(async () => {
            if (this.socket?.readyState === WebSocket.OPEN) {
              const bytes = await event.data.arrayBuffer();
              for (let offset = 0; offset < bytes.byteLength; offset += 256 * 1024) {
                if (this.socket?.readyState !== WebSocket.OPEN) break;
                this.socket.send(bytes.slice(offset, Math.min(offset + 256 * 1024, bytes.byteLength)));
              }
            }
          }).catch((error) => {
            this.emit("error", error.message || "Could not send a video chunk.");
            this.dispose();
          });
        };
        this.recorder.onerror = (event) => {
          this.emit("error", event.error?.message || "Browser recording failed.");
          this.dispose();
        };
        this.recorder.start(250);
        this.emit("live");
      } catch (error) {
        this.dispose(); this.emit("error", error.message || "Livestream failed to start.");
        throw error;
      }
    }
    async stop() {
      const recorder = this.recorder;
      if (recorder && recorder.state !== "inactive") {
        await new Promise((resolve) => {
          recorder.addEventListener("stop", resolve, { once: true });
          try { recorder.stop(); } catch { resolve(); }
        });
      }
      this.recorder = null;
      await this.queue;
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send("end");
      this.dispose(); this.emit("idle");
    }
    dispose() {
      clearTimeout(this.startTimer); this.startTimer = null;
      this.stopDrawing?.(); this.stopDrawing = null;
      const recorder = this.recorder; this.recorder = null;
      if (recorder && recorder.state !== "inactive") {
        recorder.ondataavailable = null; recorder.onerror = null;
        try { recorder.stop(); } catch { /* already stopped */ }
      }
      this.stream?.getTracks().forEach((track) => track.stop()); this.stream = null;
      this.audioClone?.stop(); this.audioClone = null;
      if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close();
      this.socket = null;
    }
  }
  window.VyraStream = VyraStream;
})();
