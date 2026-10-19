// `every(ms, fn)`: like setInterval, but keeps full speed in a hidden tab by ticking in a worker.
// Falls back to setInterval if workers aren't available. Returns a function that stops it.
let worker: Worker | null = null;
let workerFailed = false;
let nextId = 1;
const callbacks = new Map<number, () => void>();

function getWorker() {
  if (!worker && !workerFailed) {
    try {
      worker = new Worker(new URL("./ticker.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<number>) => callbacks.get(event.data)?.();
    } catch {
      workerFailed = true;
    }
  }
  return worker;
}

export function every(ms: number, fn: () => void): () => void {
  const w = getWorker();
  if (!w) {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  }
  const id = nextId++;
  callbacks.set(id, fn);
  w.postMessage({ cmd: "start", id, ms });
  return () => { callbacks.delete(id); w.postMessage({ cmd: "stop", id }); };
}
