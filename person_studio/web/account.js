"use strict";
// Accounts and credits. When the server has accounts on (/api/auth/me answers), the app waits behind a
// sign-in screen; afterwards the bar shows the credit balance and "Add credits" opens Stripe Checkout.
// Users only ever see credits and minutes, never provider prices.
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { on: false, user: null, balance: 0, catalogue: null, mode: "signin" };
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  const minutes = (credits) => {
    const perMinute = state.catalogue?.live_credits_per_minute || 60;
    const m = credits / perMinute;
    return m >= 10 || Number.isInteger(m) ? `${Math.floor(m)} min` : `${Math.floor(m)}:${String(Math.round((m % 1) * 60)).padStart(2, "0")} min`;
  };
  const money = (cents) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  async function api(path, body) {
    const response = await fetch(path, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(typeof payload.detail === "string" ? payload.detail : "Something went wrong. Try again.");
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function setBalance(balance) {
    if (typeof balance !== "number") return;
    state.balance = balance;
    $("creditBalance").textContent = balance.toLocaleString("en-US");
    $("creditMinutes").textContent = minutes(balance);
    $("creditChip").dataset.low = String(balance < (state.catalogue?.live_credits_per_minute || 60));
    document.dispatchEvent(new CustomEvent("vyra:balance", { detail: balance }));
  }

  function showAccount(payload) {
    state.user = payload.user;
    $("authGate").hidden = true;
    $("accountBar").hidden = false;
    $("accountEmail").textContent = payload.user.email;
    $("adminLink").hidden = payload.user.role !== "admin";
    $("verifyBanner").hidden = payload.user.verified;
    setBalance(payload.balance);
  }

  // ---------- sign-in screen ----------
  // Same rule as the server (accounts.EMAIL_RE), so the form catches typos before a round trip.
  const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/;
  const MIN_PASSWORD = 10;

  function setMode(mode) {
    state.mode = mode;
    const copy = {
      signin: ["Sign in", "Welcome back.", "Sign in"],
      signup: ["Create account", "Get 1 free live minute when you verify your email.", "Create account"],
      forgot: ["Reset password", "We'll email you a link to choose a new password.", "Send reset link"],
      reset: ["New password", "Choose a new password for your account.", "Save password"],
    }[mode];
    $("authTitle").textContent = copy[0];
    $("authLead").textContent = copy[1];
    $("authSubmit").textContent = copy[2];
    $("authEmailRow").hidden = mode === "reset";
    $("authPasswordRow").hidden = mode === "forgot";
    $("authPassword").autocomplete = mode === "signin" ? "current-password" : "new-password";
    $("authPasswordHelp").hidden = mode !== "signup" && mode !== "reset";
    $("authGoogleBlock").hidden = !state.google || mode === "forgot" || mode === "reset";
    $("authSwitch").hidden = mode === "reset";
    $("authTerms").hidden = mode !== "signup";
    $("authSwitchText").textContent = mode === "signup" ? "Have an account?" : "New to VYRA?";
    $("authSwitchButton").textContent = mode === "signup" || mode === "forgot" ? "Sign in" : "Create account";
    $("authForgot").hidden = mode !== "signin";
    $("authError").hidden = true;
    fieldError("authEmail", ""); fieldError("authPassword", "");
    (mode === "reset" ? $("authPassword") : $("authEmail")).focus();
  }

  function fieldError(id, message) {
    const input = $(id), slot = $(`${id}Error`);
    slot.textContent = message; slot.hidden = !message;
    if (message) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
    return !message;
  }
  function validate(showAll) {
    const email = $("authEmail").value.trim(), password = $("authPassword").value;
    let ok = true;
    if (!$("authEmailRow").hidden && (showAll || $("authEmail").dataset.touched))
      ok = fieldError("authEmail", !email ? "Enter your email." : EMAIL_RE.test(email) ? "" : "That email doesn't look right. Check for typos.") && ok;
    if (!$("authPasswordRow").hidden && (showAll || $("authPassword").dataset.touched)) {
      const strict = state.mode === "signup" || state.mode === "reset";
      ok = fieldError("authPassword", !password ? "Enter your password." :
        strict && password.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters (${password.length} so far).` : "") && ok;
      $("authPasswordHelp").hidden = !strict || !$("authPasswordError").hidden; // the error repeats the rule
    }
    return ok;
  }

  async function submitAuth(event) {
    event.preventDefault();
    $("authError").hidden = true;
    if (!validate(true)) return $("authForm").querySelector("[aria-invalid=true]")?.focus();
    const email = $("authEmail").value.trim(), password = $("authPassword").value;
    const label = $("authSubmit").textContent;
    $("authSubmit").disabled = true;
    $("authSubmit").textContent = { signin: "Signing in…", signup: "Creating account…", forgot: "Sending…", reset: "Saving…" }[state.mode];
    try {
      if (state.mode === "forgot") {
        await api("/api/auth/reset/request", { email });
        setMode("signin");
        $("authLead").textContent = "If that email has an account, a reset link is on its way.";
        return;
      }
      if (state.mode === "reset") {
        await api("/api/auth/reset", { token: state.resetToken, password });
        setMode("signin");
        $("authLead").textContent = "Password changed. Sign in with the new one.";
        return;
      }
      await api(state.mode === "signup" ? "/api/auth/signup" : "/api/auth/login", { email, password });
      location.reload(); // the app loads its status and engines as the signed-in user
    } catch (error) {
      $("authError").textContent = error.message; $("authError").hidden = false;
    } finally {
      $("authSubmit").disabled = false;
      if ($("authSubmit").textContent.endsWith("…")) $("authSubmit").textContent = label;
    }
  }

  // ---------- credits ----------
  function renderPacks() {
    const packs = state.catalogue?.packs || [];
    const base = packs[0] ? packs[0].amount_cents / packs[0].credits : 0;
    $("packList").replaceChildren(...packs.map((pack) => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "pack"; button.dataset.pack = pack.id;
      // Extra time against the starter rate: credits received over credits the same money buys at list price.
      const bonus = base ? Math.round((pack.credits / (pack.amount_cents / base) - 1) * 100) : 0;
      button.innerHTML = `<span class="pack-head"><span class="pack-name label"></span>${bonus > 0 ? '<span class="tag pack-bonus"></span>' : ""}</span>
        <strong class="pack-time"></strong><span class="pack-credits mono"></span><span class="pack-price"></span>`;
      button.querySelector(".pack-name").textContent = pack.name;
      button.querySelector(".pack-time").textContent = minutes(pack.credits);
      button.querySelector(".pack-credits").textContent = `${pack.credits.toLocaleString("en-US")} credits`;
      button.querySelector(".pack-price").textContent = money(pack.amount_cents);
      if (bonus > 0) button.querySelector(".pack-bonus").textContent = `${bonus}% more time`;
      if (pack.id === "creator") button.dataset.featured = "true";
      button.addEventListener("click", () => buy(pack.id, button));
      return button;
    }));
  }

  async function openCredits() {
    $("creditsError").hidden = true;
    try {
      const data = await api("/api/credits");
      state.catalogue = data; setBalance(data.balance); renderPacks();
      $("creditsPayments").hidden = data.payments;
      $("creditsVerify").hidden = state.user.verified;
      $("ledgerList").replaceChildren(...data.history.slice(0, 8).map((row) => {
        const li = document.createElement("li");
        const label = { purchase: "Credits bought", free: "Welcome credits", live: "Live time", live_refund: "Unused live time",
          admin: "Adjustment", clip: "Clip", clip_refund: "Clip refund", voice: "Voice", voice_refund: "Voice refund",
          assist: "Assistant", assist_refund: "Assistant refund" }[row.kind] || row.kind;
        li.innerHTML = '<span></span><span class="mono"></span>';
        li.children[0].textContent = `${label} · ${new Date(row.at).toLocaleDateString()}`;
        li.children[1].textContent = `${row.delta > 0 ? "+" : ""}${row.delta}`;
        li.children[1].dataset.sign = row.delta > 0 ? "plus" : "minus";
        return li;
      }));
      $("ledgerEmpty").hidden = data.history.length > 0;
    } catch (error) {
      $("creditsError").textContent = error.message; $("creditsError").hidden = false;
    }
    if (!$("creditsDialog").open) $("creditsDialog").showModal();
  }

  async function buy(pack, button) {
    button.disabled = true; $("creditsError").hidden = true;
    try {
      const { url } = await api("/api/billing/checkout", { pack });
      location.assign(url);
    } catch (error) {
      $("creditsError").textContent = error.message; $("creditsError").hidden = false;
      button.disabled = false;
    }
  }

  // ---------- links from email and Stripe ----------
  async function handleLinks() {
    const params = new URLSearchParams(location.search);
    const clean = () => history.replaceState(null, "", location.pathname + location.hash);
    if (params.has("verify")) {
      try { await api("/api/auth/verify", { token: params.get("verify") }); state.flash = "Email verified. Your free minute is ready."; }
      catch (error) { state.flash = error.message; }
      clean();
    }
    if (params.has("reset")) { state.resetToken = params.get("reset"); clean(); }
    // Hand-off from the landing page: open on "Create account", keep the email, remember the chosen look.
    if (params.has("signup") || params.has("email") || params.has("look")) {
      state.signup = params.has("signup");
      state.email = (params.get("email") || "").slice(0, 254);
      const look = params.get("look");
      if (look) try { sessionStorage.setItem("vyra.pendingLook", look.slice(0, 40)); } catch { /* storage blocked */ }
      clean();
    }
    if (params.get("checkout") === "success") { state.flash = "Payment received. Your credits will appear in a moment."; state.poll = true; clean(); }
    if (params.has("auth_error")) {
      state.authError = params.get("auth_error") === "cancelled" ? "Google sign-in was cancelled."
        : "Google sign-in didn't work. Try again or use your email.";
      clean();
    }
    if (params.get("checkout") === "cancelled") { state.flash = "Checkout cancelled. No charge was made."; clean(); }
  }

  async function start() {
    await handleLinks();
    let payload;
    try {
      payload = await api("/api/auth/me");
    } catch (error) {
      if (error.status === 404) return resolveReady(false); // this server runs without accounts
      state.on = true;
      state.google = await api("/api/auth/providers").then((p) => p.google).catch(() => false);
      $("authGate").hidden = false;
      setMode(state.resetToken ? "reset" : state.signup ? "signup" : "signin");
      if (state.email) { $("authEmail").value = state.email; $("authPassword").focus(); }
      if (state.flash) $("authLead").textContent = state.flash;
      if (state.authError) { $("authError").textContent = state.authError; $("authError").hidden = false; }
      return; // the app stays behind the sign-in screen
    }
    state.on = true;
    document.body.dataset.accounts = "on";
    api("/api/pricing").then((c) => { state.catalogue = c; setBalance(state.balance); }).catch(() => {});
    showAccount(payload);
    if (state.flash) document.dispatchEvent(new CustomEvent("vyra:notice", { detail: state.flash }));
    if (state.poll) { // the webhook usually lands within seconds of the redirect
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const me = await api("/api/auth/me").catch(() => null);
        if (me && me.balance !== payload.balance) { setBalance(me.balance); break; }
      }
    }
    resolveReady(true);
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("authForm").addEventListener("submit", submitAuth);
    for (const id of ["authEmail", "authPassword"]) {
      // Check a field once the user leaves it, then live as they fix it.
      $(id).addEventListener("blur", () => { if ($(id).value) { $(id).dataset.touched = "1"; validate(false); } });
      $(id).addEventListener("input", () => { if ($(id).dataset.touched) validate(false); $("authError").hidden = true; });
    }
    $("authReveal").addEventListener("click", () => {
      const show = $("authPassword").type === "password";
      $("authPassword").type = show ? "text" : "password";
      $("authReveal").textContent = show ? "Hide" : "Show";
      $("authReveal").setAttribute("aria-pressed", String(show));
      $("authReveal").setAttribute("aria-label", show ? "Hide password" : "Show password");
    });
    $("authSwitchButton").addEventListener("click", () => setMode(state.mode === "signin" ? "signup" : "signin"));
    $("authForgot").addEventListener("click", () => setMode("forgot"));
    $("creditChip").addEventListener("click", openCredits);
    $("closeCredits").addEventListener("click", () => $("creditsDialog").close());
    $("signOutButton").addEventListener("click", async () => { await api("/api/auth/logout", {}).catch(() => {}); location.reload(); });
    $("resendVerify").addEventListener("click", async (event) => {
      event.target.disabled = true;
      try { await api("/api/auth/resend", {}); event.target.textContent = "Sent"; }
      catch (error) { event.target.textContent = error.message; }
    });
    start();
  });

  window.VyraAccount = {
    ready, get on() { return state.on; }, get balance() { return state.balance; },
    get creditsPerMinute() { return state.catalogue?.live_credits_per_minute || 60; },
    setBalance, openCredits,
  };
})();
