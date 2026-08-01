/*
 * Plan 0525 P1.1 (R5) — t73: THE MCP CUE SHEET CARRIES THE ON-DEMAND MARKER.
 *
 * `onDemand` is a note to WHOEVER IS PRESENTING — a human at the outline, or an AI driving over
 * MCP: *this beat is prepared, but it is not on the path; show it only when they ask for it.* The
 * classic shape is the beat behind a closed door: it exists, and it appears iff they find the door
 * and decide to open it. The product does NOT enforce it and must not — when they do ask, the
 * presenter simply calls show_beat, and that has always worked.
 *
 * What was broken is that the marker was INVISIBLE on both presenting surfaces. `presenter_beats`
 * — whose own description calls it *"the cue sheet for show_beat … the GM catalog"* — mapped each
 * beat to {index, id, component, title, target} and dropped `onDemand` on the floor, so the AI
 * presenter the marker was written for could not see it. This is the half that matters most,
 * because it is the surface an agent presents from.
 *
 * ⚠ ADDITIVE, PRESENT-ONLY-WHEN-TRUE. An ordinary beat's shape must be byte-for-byte what it was,
 * or every existing caller has silently changed. Both halves are asserted here: the marked beat
 * gains exactly one key, and the ordinary beat gains none.
 *
 * Unit tier: the MCP handlers over an ephemeral port (`port: 0`), no browser. Every beat is inline
 * in this file — nothing reads or writes the repo's gitignored modules/ directory (0525 §7 E).
 */
import { test, check as expect } from '../../harness/test.mjs';
import { toolMap } from '../../mcp/tools.mjs';
import { validate, KNOWN_BEAT_KEYS } from '../../app/validate.mjs';

const ORDINARY_KEYS = ['index', 'id', 'component', 'title', 'target'];

/** Five beats; exactly one of them — the beat behind the door — is marked on demand. */
const beats = () => [
  { id: 'approach', component: 'card', opts: { title: 'The approach' } },
  { id: 'corridor', component: 'card', opts: { title: 'The corridor' } },
  { id: 'behind-the-door', component: 'card', opts: { title: 'Behind the door' }, onDemand: true },
  { id: 'stairwell', component: 'card', opts: { title: 'The stairwell' } },
  { id: 'roof', component: 'card', opts: { title: 'The roof' } },
];

test('0525 t73 — presenter_beats reports onDemand on a marked beat and OMITS the key on every other one', async () => {
  const T = toolMap();
  await T.presenter_start.handler({ port: 0, tunnel: false });
  try {
    const authored = beats();
    await T.present_module.handler({ title: 'On-demand fixture', beats: authored });
    const sheet = await T.presenter_beats.handler({});
    const rows = sheet.beats;

    // ── the marker reaches the agent ────────────────────────────────────────────────────────
    const marked = rows.find((r) => r.id === 'behind-the-door');
    expect('the marked beat is reported with onDemand:true', marked && marked.onDemand === true, JSON.stringify(marked));

    // ── and nothing else carries it, not even as `false` ────────────────────────────────────
    const others = rows.filter((r) => r.id !== 'behind-the-door');
    expect('every ordinary beat OMITS the key entirely — absent, not false',
      others.every((r) => !('onDemand' in r)), JSON.stringify(others.filter((r) => 'onDemand' in r)));

    // ── the shape of an ordinary row is exactly what it was before this phase ───────────────
    const ordinaryShape = others.map((r) => Object.keys(r).sort().join(','));
    const want = ORDINARY_KEYS.slice().sort().join(',');
    expect('an ordinary row still carries exactly {index,id,component,title,target} — no existing caller changes shape',
      ordinaryShape.every((k) => k === want), JSON.stringify(ordinaryShape));
    expect('the marked row is that same shape PLUS onDemand, and nothing more',
      Object.keys(marked).sort().join(',') === ORDINARY_KEYS.concat('onDemand').sort().join(','), Object.keys(marked).join(','));

    // ── order and count are untouched: this is a catalog, and its order is the author's ─────
    expect('the list still reports every beat, in authored order',
      rows.map((r) => r.id).join('|') === authored.map((b) => b.id).join('|'), rows.map((r) => r.id).join('|'));
    expect('count still matches the module', sheet.count === authored.length, String(sheet.count));
    expect('index is still the position in the module, on-demand beats included',
      rows.every((r, i) => r.index === i), JSON.stringify(rows.map((r) => r.index)));

    // ── the description tells the calling agent what to DO with it, which is the point ──────
    const desc = T.presenter_beats.description;
    expect('the tool description names the field, so an agent reading the schema learns it exists',
      /onDemand/.test(desc), desc);
    expect('and says it is a note to the presenter rather than something the product enforces',
      /only when|iff they ask|show it only/i.test(desc), desc);

    /*
     * ── P1.3, asserted HERE rather than in a fourth test ────────────────────────────────────
     * The plan enumerates exactly three tests (t73–t75) and fixes acceptance at +3 executed, so
     * P1.3 — the validator learning the field's name — has no test of its own. Leaving a source
     * change with nothing asserting it is the failure mode this phase exists to correct: the
     * marker sat inert for months precisely BECAUSE nothing declared it. Two checks, folded into
     * the test that already owns "the field is declared and visible", cost no executed count.
     */
    expect('P1.3 — the validator now DECLARES onDemand, so it is no longer a field nobody named',
      KNOWN_BEAT_KEYS.includes('onDemand'), KNOWN_BEAT_KEYS.join(','));
    const v = validate({ manifest: { title: 'x', defaultBeatId: 'approach' }, beats: authored.concat([{ id: 'z', component: 'card', opts: {}, someAuthoringNote: 'kept for the author, read by nothing' }]) });
    const declared = v.warnings.filter((w) => w.code === 'V21-undeclared-beat-key');
    expect('an undeclared beat key is reported once, at module level', declared.length === 1, JSON.stringify(v.warnings));
    expect('…as INFO, never a warn or an error — I4, the permissive default: authoring metadata is legitimate',
      declared[0] && declared[0].level === 'info', JSON.stringify(declared));
    expect('…and it names the offending key so the author can tell a typo from deliberate metadata',
      declared[0] && /someAuthoringNote/.test(declared[0].msg), JSON.stringify(declared));
    expect('while onDemand itself provokes NOTHING — it is declared, not undeclared',
      declared[0] && !/onDemand/.test(declared[0].msg.split('Declared keys:')[0]), JSON.stringify(declared));
  } finally { await T.presenter_stop.handler({}); }
});
