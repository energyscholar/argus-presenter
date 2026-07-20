/*
 * voicebench.mjs — scientific tuning harness for the presenter voice pipeline (Plan 0476).
 *
 * For each CONFIG it: launches a fresh standalone server (loads current server.mjs) on its own
 * port, warms the ASR, injects a speech clip through the REAL client via headless Chrome + fake
 * mic (APVoice.enable(opts) with the config's opts), collects the resulting kind:voice transcripts
 * + arrival latency via the in-process server.getTranscripts() API, and scores WER vs a reference.
 *
 * The [MICDBG] stage tracer is kind:text (chat) so getTranscripts (kind:voice only) excludes it —
 * the bench sees clean transcripts.
 *
 * Reference transcript = whisper on the CLEAN un-chopped clip (transcribeClean), so WER isolates
 * VAD/segmentation/pipeline degradation from the model's own ceiling.
 *
 * Usage:  node harness/voicebench.mjs <clip.wav> [clip2.wav ...]
 *   env PRESENTER_ASR_CMD must point at the whisper worker (already set in this env).
 *   Clips + any derived text stay in scratchpad — never commit private audio/transcripts.
 */
import { spawn } from 'child_process';
import { launchVoice } from './voice-browser.mjs';
import { createServer } from '../app/server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- word error rate (Levenshtein over normalized word tokens) ----
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean); }
function wer(ref, hyp) {
  const a = norm(ref), b = norm(hyp);
  if (!a.length) return b.length ? 1 : 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length] / a.length;
}

// ---- feed a WAV path straight to the warm whisper worker (reference / ground truth) ----
function transcribeClean(wavPath, model) {
  return new Promise((resolve) => {
    const cmd = (process.env.PRESENTER_ASR_CMD || 'python3 voice/asr-whisper.py').split(/\s+/);
    const env = { ...process.env };
    if (model) env.PRESENTER_WHISPER_MODEL = model;
    const p = spawn(cmd[0], cmd.slice(1), { cwd: new URL('..', import.meta.url).pathname, env });
    let out = '', done = false, texts = [];
    const finish = () => { if (!done) { done = true; try { p.kill(); } catch (e) {} resolve(texts.join(' ').trim()); } };
    p.stdout.on('data', (b) => {
      out += b.toString();
      let nl; while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl); out = out.slice(nl + 1);
        try { const o = JSON.parse(line); if (o && typeof o.text === 'string') { texts.push(o.text); finish(); } } catch (e) {}
      }
    });
    p.on('error', finish);
    setTimeout(() => { p.stdin.write(wavPath + '\n'); }, 400);   // let the model load
    setTimeout(finish, 30000);
  });
}

// ---- run ONE config against ONE clip ----
async function runOne({ clip, port, model, enableOpts, captureMs = 16000, label }) {
  process.env.PRESENTER_WHISPER_MODEL = model || 'base.en';
  const server = await createServer({ port, voiceEnabled: true });
  server.voiceEnable('all');            // spawn + warm the ASR worker
  await sleep(2800);                    // model load
  const browser = await launchVoice({ wavPath: clip });
  const page = await browser.newPage();
  await page.goto(server.url() + '/?role=participant&userId=bench&name=Bench', { waitUntil: 'domcontentloaded' });
  await sleep(800);
  const t0 = Date.now();
  const enableRes = await page.evaluate((opts) => window.APVoice.enable(opts).then(() => 'ok').catch((e) => 'ERR:' + (e && e.message || e)), enableOpts || {});
  const seen = []; let lastSeq = 0;
  const start = Date.now();
  while (Date.now() - start < captureMs) {
    const { transcripts } = server.getTranscripts(lastSeq);
    for (const tr of transcripts) { lastSeq = Math.max(lastSeq, tr.seq); seen.push({ seq: tr.seq, text: tr.text, arrivedMs: Date.now() - t0 }); }
    await sleep(250);
  }
  try { await browser.close(); } catch (e) {}
  await server.close();
  const hyp = seen.map((s) => s.text).join(' ').trim();
  const lastArr = seen.length ? seen[seen.length - 1].arrivedMs : null;
  return { label, enableRes, segments: seen.length, hyp, lastArrivedMs: lastArr, transcripts: seen };
}

// ---- main ----
const clips = process.argv.slice(2);
if (!clips.length) { console.error('usage: node harness/voicebench.mjs <clip.wav> [more...]'); process.exit(1); }

// Config grid. Sweep the big levers: model (accuracy/latency) × VAD minSilence (segmentation).
// enableOpts pass straight into the worklet processorOptions (no code change needed to sweep).
const GRID = process.env.BENCH_GRID || 'model';
const GRIDS = {
  model: [
    { label: 'tiny.en',  model: 'tiny.en',  enableOpts: {} },
    { label: 'base.en',  model: 'base.en',  enableOpts: {} },
    { label: 'small.en', model: 'small.en', enableOpts: {} },
  ],
  vad: [
    { label: 'base/sil500', model: 'base.en', enableOpts: { minSilenceMs: 500 } },
    { label: 'base/sil800', model: 'base.en', enableOpts: { minSilenceMs: 800 } },
    { label: 'base/sil1200', model: 'base.en', enableOpts: { minSilenceMs: 1200 } },
  ],
  quick: [ { label: 'base.en/default', model: 'base.en', enableOpts: {} } ],
};
const CONFIGS = GRIDS[GRID] || GRIDS.quick;

let basePort = 4500;
for (const clip of clips) {
  console.log('\n===== CLIP:', clip, '=====');
  const ref = await transcribeClean(clip, 'base.en');
  console.log('REF(base.en clean):', JSON.stringify(ref));
  for (const cfg of CONFIGS) {
    const r = await runOne({ clip, port: basePort++, model: cfg.model, enableOpts: cfg.enableOpts, label: cfg.label });
    const w = wer(ref, r.hyp);
    console.log(`\n[${cfg.label}] enable=${r.enableRes} segs=${r.segments} lastArr=${r.lastArrivedMs}ms WER=${(w * 100).toFixed(1)}%`);
    console.log('  HYP:', JSON.stringify(r.hyp));
  }
}
console.log('\nvoicebench done.');
process.exit(0);
