// Thin fetch wrapper for the VYRANI API. Same-origin, so the session cookie rides along; errors carry the server's message.

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const options: RequestInit = body === undefined
    ? { cache: "no-store", ...init }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...init };
  let response: Response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new ApiError("Can't reach VYRANI. Check your connection and try again.", 0);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = (payload as { detail?: unknown }).detail;
    throw new ApiError(typeof detail === "string" ? detail : "Something went wrong. Try again.", response.status);
  }
  return payload as T;
}

export async function upload<T = unknown>(path: string, form: FormData, timeoutMs = 60000): Promise<T> {
  const response = await fetch(path, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = (payload as { detail?: unknown }).detail;
    throw new ApiError(typeof detail === "string" ? detail : "The upload failed. Try again.", response.status);
  }
  return payload as T;
}

export type User = {
  id: string;
  email: string;
  role: "user" | "admin";
  verified: boolean;
  trial?: "granted" | "disposable_email" | "mailbox_used" | "address_limit" | null;
  google: boolean;
  has_password: boolean;
  can_remove_watermark?: boolean;
};
export type Me = { user: User; balance: number };
export type Pack = { id: string; name: string; credits: number; amount_cents: number };
export type Catalogue = { credit_usd: number; live_credits_per_minute: number; packs: Pack[]; tools: Record<string, number> };
export type LedgerRow = { delta: number; kind: string; at: string; reason?: string; pack?: string };
export type Credits = Catalogue & { balance: number; history: LedgerRow[]; payments: boolean };

export const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/; // same rule as the server (accounts.EMAIL_RE)
export const MIN_PASSWORD = 10;

export const minutes = (credits: number, perMinute = 60) => {
  const m = credits / perMinute;
  if (m >= 10 || Number.isInteger(m)) return `${Math.floor(m)} min`;
  return `${Math.floor(m)}:${String(Math.round((m % 1) * 60)).padStart(2, "0")} min`;
};
export const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export const LEDGER_LABELS: Record<string, string> = {
  purchase: "Credits bought", free: "Welcome credits", live: "Live time", live_refund: "Unused live time returned",
  admin: "Adjustment", clip: "Clip", clip_refund: "Clip refund", voice: "Voice", voice_refund: "Voice refund",
  assist: "Look assistant", assist_refund: "Assistant refund", refund: "Payment refunded",
};
