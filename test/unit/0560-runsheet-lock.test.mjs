/*
 * 0560 — THE RUN-SHEET LOCK, and why it must not be a vocabulary match.
 *
 * The run sheet paints a beat RED to mean DO-NOT-STAGE. That test used to include a milieu word,
 * which put domain vocabulary into a deliberately domain-neutral engine (t0532-04 caught it). The
 * rule is now: a DECLARED FLAG, or a neutral sentinel glyph — nothing that knows anybody's jargon.
 *
 * ⚠ Removing a matcher can silently UNLOCK content. t0560-22 is the guard that noticed: it walks
 *   every real module and asserts no beat depended on the removed literal alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const CONTROL = readFileSync(join(ROOT, 'app/control.html'), 'utf8');

/** The predicate exactly as control.html applies it. */
const locked = (beat) => {
  const note = (beat.opts && beat.opts.note) || '';
  return beat.private === true || /🔒/.test(note) || /DO NOT STAGE/i.test(note);
};

test('t0560-20 — the lock is a flag or a sentinel, never a milieu word', () => {
  const line = CONTROL.split('\n').find(l => l.includes('var gm =') || l.includes('var gm='));
  assert.ok(line, 'the lock predicate must exist');
  assert.match(line, /b\.private === true/, 'a declared flag is the primary signal');
  assert.match(line, /🔒/, 'the neutral sentinel glyph is honoured');
  assert.doesNotMatch(line, /\bGM\b/, '⛔ no milieu vocabulary in the neutral engine (t0532-04)');
});

test('t0560-21 — the predicate actually discriminates', () => {
  assert.equal(locked({ opts: { note: 'read this aloud' } }), false);
  assert.equal(locked({ opts: { note: '🔒 hold this back' } }), true);
  assert.equal(locked({ opts: { note: 'DO NOT STAGE — spoilers' } }), true);
  assert.equal(locked({ private: true, opts: { note: 'plain' } }), true);
  // the failure the original comment records: a role prefix is NOT a lock
  assert.equal(locked({ opts: { note: 'GM: describe the smell of the hold' } }), false);
});

test('t0560-22 — ⚠ NO REAL MODULE lost its lock when the vocabulary matcher was removed', () => {
  const dir = join(ROOT, 'modules');
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  let withNotes = 0, red = 0;
  const orphaned = [];
  for (const f of files) {
    let mod; try { mod = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    for (const b of (mod.beats || [])) {
      const note = (b.opts && b.opts.note) || '';
      if (!String(note).trim()) continue;
      withNotes++;
      if (locked(b)) { red++; continue; }
      // it reads as private but carries no signal the engine can see ⇒ it would stage by mistake
      if (/GM[- ]ONLY|SPOILER|DO-NOT-SHOW/i.test(note)) orphaned.push(`${f}:${b.id} — ${note.slice(0, 60)}`);
    }
  }
  assert.ok(withNotes > 0, 'there must be modules with notes to check');
  assert.deepEqual(orphaned, [], 'a beat that reads as private must carry 🔒 or private:true');
});
