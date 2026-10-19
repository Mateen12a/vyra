// Timer thread. Chrome slows page timers in background tabs (to 1/min after a few minutes) but not a worker's,
// so anything that must keep time while the studio tab is hidden (billing heartbeat, fallback frame pump) ticks here.
const timers = new Map<number, ReturnType<typeof setInterval>>();

self.onmessage = (event: MessageEvent<{ cmd: "start" | "stop"; id: number; ms?: number }>) => {
  const { cmd, id, ms } = event.data;
  clearInterval(timers.get(id));
  timers.delete(id);
  if (cmd === "start" && ms) timers.set(id, setInterval(() => self.postMessage(id), ms));
};
