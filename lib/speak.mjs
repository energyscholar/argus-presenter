/*
 * speak.mjs — on-device speech OUT, ONE copy for every page that speaks (Plan 0941 §1).
 *
 * Imported by the presenter page, the /voice page, and a listed other origin's client (served with the
 * same CORS as the voice client files). Moved here unchanged in behaviour from the presenter page
 * (Plan 0491 §10, 0492, 0685 R1). Audio OUT only: it holds no reference to the capture runtime; the
 * caller hands in a `duck(on)` hook, and with no capture that hook is simply a no-op.
 *
 * On-device speechSynthesis: no audio ever crosses the network. Four traps (0491 §2.3), all silent
 * failures if skipped:
 *  1. localService MUST be preferred — the OPSEC guarantee; a remote voice would send the text off the
 *     device. No local voice ⇒ the utterance is DROPPED and the outcome says so (never a fallback).
 *  2. getVoices() is [] on first call in most browsers; resolve the real list on 'voiceschanged'.
 *  3. cancel() before every speak() — replace-don't-queue AND the iOS queue-lock workaround.
 *  4. iOS needs a user gesture before the first utterance — the caller calls prime() inside one.
 *
 * Every speak() returns an OUTCOME, so a caller can show what happened (Plan 0941: no silent drop):
 *   { spoken: true,  text, voice }                                   — queued on a local voice
 *   { spoken: false, text, reason: 'empty'|'no-synthesis'|'no-local-voice' }
 */

// Plan 0492: rank the LOCAL voices by quality instead of taking the first one found (typically a thin
// formant voice). All three lists are PREFERENCES, NOT REQUIREMENTS: an unlisted voice still scores and
// remains selectable, so a voice-pack update can never silently mute the lane.
export const QUALITY_HIGH = ['natural', 'neural', 'enhanced', 'premium', 'wavenet', 'siri'];
export const QUALITY_LOW = ['espeak', 'mbrola', 'festival', 'pico', 'flite'];
// Accent preference, read off v.lang (structural — the API does expose language).
export const ACCENTS = { 'en-ie': 4, 'en-gb': 3, 'en-au': 2, 'en-nz': 2 };
// HEURISTIC ONLY, NOT A CAPABILITY: SpeechSynthesisVoice exposes no gender field, so this is a guess
// from the name. It is the last and weakest term — it orders, it never gates.
export const FEMALE_VOICE_NAMES = ['female', 'fiona', 'moira', 'karen', 'serena', 'kate', 'samantha',
  'siobhan', 'tessa', 'victoria', 'zira', 'hazel', 'susan', 'amelie'];

const matches = (name, list) => list.some((w) => name.indexOf(w) !== -1);

/** Lexicographic score: quality tier (dominant) > accent > name guess. Pure function of the voice. */
export function voiceRank(v) {
  const name = String((v && v.name) || '').toLowerCase();
  const lang = String((v && v.lang) || '').toLowerCase().replace('_', '-');
  let quality = 1;
  if (matches(name, QUALITY_HIGH)) quality = 2;
  else if (matches(name, QUALITY_LOW)) quality = 0;
  const accent = ACCENTS[lang] || (lang.indexOf('en') === 0 ? 1 : 0);
  const female = matches(name, FEMALE_VOICE_NAMES) ? 1 : 0;
  return quality * 100 + accent * 10 + female;
}

/**
 * The best LOCAL voice, or null. OPSEC GATE FIRST (trap 1): ranking only ever sees the already-filtered
 * local set, so no path can reach a localService === false voice. Stable sort ⇒ same list in, same voice out.
 */
export function pickLocalVoice(voices) {
  const local = (voices || []).filter((v) => v && v.localService === true);
  if (!local.length) return null;
  return local.slice().sort((a, b) => voiceRank(b) - voiceRank(a))[0];
}

// Plan 0685 R1 — the echo guard's duck. ⛔ THE UN-DUCK IS UNCONDITIONAL: a duck that fails to lift
// leaves the speaker MUTE WITH NO ERROR, worse than the echo it prevents. Every exit fires it — end,
// error, and the cancel() that precedes the next utterance — and an absolute watchdog fires it
// regardless of what the platform reports. Never gated on a generation counter.
export const DUCK_MAX_MS = 30000;              // hard ceiling (the server clamps a spoken précis to ~300 chars)
/** Watchdog bound: ~10 chars/sec is slower than any real voice, and the ceiling bounds it regardless. */
export function duckMs(text) { return Math.min(DUCK_MAX_MS, 2000 + String(text || '').length * 100); }

/**
 * @param {object} [o]
 * @param {object}   [o.synth]      the speechSynthesis object (default: the global one)
 * @param {Function} [o.Utterance]  the SpeechSynthesisUtterance constructor (default: the global one)
 * @param {Function} [o.duck]       (on:boolean) — capture-side duck hook; absent ⇒ nothing to duck
 * @param {Function} [o.onOutcome]  (outcome) — every speak() result, spoken or dropped
 * @param {object}   [o.log]        console-like
 */
export function createSpeaker({ synth, Utterance, duck, onOutcome, log } = {}) {
  const S = synth !== undefined ? synth : globalThis.speechSynthesis;
  const U = Utterance !== undefined ? Utterance : globalThis.SpeechSynthesisUtterance;
  const L = log || console;
  let voice = null, duckTimer = null;

  function duckCapture(on) { try { if (typeof duck === 'function') duck(on); } catch (e) {} }
  function unduck() {                          // UNCONDITIONAL: no state test, no generation check
    if (duckTimer) { clearTimeout(duckTimer); duckTimer = null; }
    duckCapture(false);
  }
  function duckFor(text) {
    duckCapture(true);
    if (duckTimer) clearTimeout(duckTimer);
    duckTimer = setTimeout(() => {
      duckTimer = null; duckCapture(false);
      L.warn('[ap-speak] duck lifted by watchdog — speechSynthesis reported neither end nor error');
    }, duckMs(text));
  }
  function pick() {
    const voices = (S && S.getVoices && S.getVoices()) || [];
    if (!voices.length) return voice;          // still unresolved; voiceschanged will retry
    voice = pickLocalVoice(voices);
    if (!voice) L.warn('[ap-speak] no local (on-device) voice available — refusing to use a remote voice');
    else L.log('[ap-speak] voice:', voice.name, voice.lang);
    return voice;
  }
  if (S) {
    pick();
    try { S.addEventListener && S.addEventListener('voiceschanged', pick); } catch (e) {}
  }
  function report(o) { try { onOutcome && onOutcome(o); } catch (e) {} return o; }

  function speak(text) {
    const t = text == null ? '' : String(text);
    if (!t) return report({ spoken: false, text: t, reason: 'empty' });
    if (!S || typeof U !== 'function') return report({ spoken: false, text: t, reason: 'no-synthesis' });
    if (!voice) pick();                        // one more try in case voiceschanged hasn't fired yet
    if (!voice) { L.warn('[ap-speak] dropped — no local voice (OPSEC guard)'); return report({ spoken: false, text: t, reason: 'no-local-voice' }); }
    unduck();                                  // trap 3 corollary: cancel() ends the PREVIOUS utterance
    S.cancel();                                // trap 3: replace-don't-queue + iOS queue-lock workaround
    const u = new U(t);
    u.voice = voice;
    u.onstart = function () { duckFor(t); };   // duck when audio actually BEGINS (not when queued)
    u.onend = function () { unduck(); };
    u.onerror = function () { unduck(); };
    S.speak(u);
    return report({ spoken: true, text: t, voice: voice.name || null });
  }
  /** Trap 4: call INSIDE a user gesture — a zero-length utterance unlocks the queue for later speech. */
  function prime() { try { if (S && typeof U === 'function') S.speak(new U('')); } catch (e) {} }

  return { speak, prime, unduck, duckMs, pick, get voice() { return voice; } };
}
