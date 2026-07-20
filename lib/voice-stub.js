/* voice-stub.js — Tier 0 (Plan 0470). The ONLY voice code on the default page.
   Sub-1KB; loads nothing until enable(). Tier 1 arrives via dynamic import() only. */
(function () {
  if (window.APVoice) return;
  function host() { return window.APVoiceHost || null; }
  window.APVoice = {
    enabled: false,
    capture: null,
    async enable(opts) {
      if (!window.isSecureContext) throw new Error('voice: mic needs HTTPS or localhost (secure context) — use the tunnel');
      if (typeof AudioWorklet === 'undefined') throw new Error('voice: AudioWorklet unavailable (RT-23)');
      var h = host();
      var mod = await import('/lib/voice-capture.mjs');
      this.capture = await mod.startCapture({ socket: h && h.getSocket && h.getSocket(), opts: opts || {} });
      this.enabled = true;
      return this.capture;
    },
    disable() { if (this.capture && this.capture.stop) this.capture.stop(); this.capture = null; this.enabled = false; },
  };
})();
