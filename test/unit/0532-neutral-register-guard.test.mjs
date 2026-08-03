/*
 * Plan 0532 P2 — THE NEUTRAL-REGISTER GUARD.
 *
 * Bruce, S227, on the public API: "No RPG references there. Use neutral terms."
 *
 * Plan 0531 removed campaign DATA — names, session ids, places — and `t0531-01` keeps it out.
 * But a regex over proper nouns catches NAMES, not REGISTER. The tool descriptions still said
 * "a tabletop module … the GM cues a scene", "the GM catalog", "give the players the stage",
 * and the control page still told a human "players unchanged". None of that is a campaign; all
 * of it is a milieu. `argus-presenter` is PUBLIC and its admission test is "would this fly in a
 * corporate training app?" — so this is the other half of t0531-01.
 *
 * The two surfaces scanned are the two that leave the repo: what an AGENT reads to decide which
 * tool to call, and what a HUMAN reads on screen.
 *
 * ── SCOPE, stated exactly so it can be judged rather than trusted ─────────────────────────────
 *
 *   IN (t0532-03): every `description` string reachable from the LIVE MCP tool surface —
 *       `activeTools({voiceEnabled:true})`, i.e. core + voice tools — covering both the tool's
 *       own description and every JSON-schema property description, at any nesting depth.
 *       This scans the ARTIFACT, not the source text: a description that moves file, or is
 *       composed at import (as the port default is), is still covered.
 *
 *   IN (t0532-04): the USER-VISIBLE text of every tracked `*.html`. The file is scanned with
 *       HTML comments and JavaScript comments REMOVED first (quote-aware, so `https://` inside
 *       a string survives). What remains is markup, attributes and string literals — the things
 *       a human can end up reading.
 *
 *   OUT — and each exclusion is a decision, not an oversight:
 *
 *     · SOURCE COMMENTS, everywhere. GENERATOR-BRIEF §3: "hits in identifiers are a defect;
 *       hits in comments are fine." Explaining WHY a knob exists, in the words of the session
 *       that found it, is worth more than a uniform vocabulary in a place no user reads.
 *
 *     · MARKDOWN and all other prose. Same reason t0532-01 stops at the code/prose line: the
 *       plan documents describing this very change say "GM" and "player" throughout, and a
 *       guard that flags its own rationale is a guard people switch off.
 *
 *     · TEST FILES. They exercise a milieu fixture on purpose (`V0473-scenario-rpg`), and they
 *       are not a surface anybody outside the repo reads.
 *
 *     · PROTOCOL AND CONFIG LITERALS, named individually below in EXEMPT_LITERALS / the token
 *       list. ⛔ `gm` is a WIRE ROLE VALUE — it sits beside `presenter` and `participant` in
 *       app/permissions.mjs `ALL`, in server.mjs `KNOWN_ROLES` and `ROLE_RANK`, and in every
 *       stored session log. Renaming it breaks every client. So the guard matches UPPERCASE
 *       `GM` only, case-sensitively: the protocol value is lowercase everywhere it is real, and
 *       uppercase GM in a description or on a page is always prose. Likewise `rpg` is a PROFILE
 *       KEY (app/profiles.mjs) and `dice` is a COMPONENT ID (components/dice/) — the quoted
 *       forms of those are stripped before scanning, and bare `dice` is not a token at all.
 *
 *   ⚠ KNOWN HOLES, said here rather than discovered later:
 *     1. `table` is NOT a token. "the table" meaning the group is exactly the register this
 *        guard is for, but the word is also HTML `<table>`, "the profile table", "the routing
 *        table". Every rule tried that caught the first also caught the others.
 *     2. The literal `'rpg'` still appears in presenter_start's `profile` description, because
 *        the profile KEY was left alone (a config rename is not this phase). The guard exempts
 *        the QUOTED form only — an unquoted "rpg" in a description still fails.
 *     3. User-visible strings built in `.mjs` (server error text, log messages) are not scanned.
 *        Nothing in the P2 sweep found any; a later phase can widen this to lib/ and app/*.mjs.
 *
 *   ⚠ Per the generator brief §6.2: the HTML half walks TRACKED files. A new page you have not
 *     `git add`-ed is invisible to it. Add before you believe it.
 */
import { test, expect } from '../../harness/test.mjs';
import { activeTools } from '../../mcp/tools.mjs';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/*
 * Quoted PROTOCOL/CONFIG values that are allowed to look like register because they ARE the
 * wire. Stripped from the text before any token is applied. Quoted forms only — naming the
 * profile in prose is still a violation.
 */
const EXEMPT_LITERALS = [/(['"`])rpg\1/g, /(['"`])gm\1/g, /(['"`])dice\1/g];

/*
 * The register itself. `re` must be a fresh regex per use (no /g state shared), so these are
 * stored as source+flags and compiled at match time.
 */
const REGISTER = [
  { label: 'GM (uppercase; prose — the lowercase role value `gm` is protocol and is NOT scanned)',
    src: '\\bGM\\b', flags: '' },
  { label: 'game master / gamemaster',      src: '\\bgame ?master', flags: 'i' },
  { label: 'tabletop / table-top',          src: '\\btable-?top',   flags: 'i' },
  { label: 'player / players',              src: '\\bplayers?\\b',  flags: 'i' },
  { label: 'rpg (unquoted — the quoted profile key is exempt)', src: '\\brpg\\b', flags: 'i' },
  { label: 'roleplay / role-play',          src: '\\brole-? ?play', flags: 'i' },
  { label: 'referee',                       src: '\\breferee',      flags: 'i' },
  { label: 'campaign',                      src: '\\bcampaign',     flags: 'i' },
  { label: 'dungeon',                       src: '\\bdungeon',      flags: 'i' },
  { label: 'NPC',                           src: '\\bNPCs?\\b',     flags: '' },
  { label: 'the party (adventuring sense)', src: '\\b(adventuring|the) party\\b', flags: 'i' },
  { label: 'dice roll / roll the dice',     src: '\\bdice (roll|pool)|\\broll(ing)? (the )?dice', flags: 'i' },
  { label: 'character sheet',               src: '\\bcharacter sheet', flags: 'i' },
  { label: 'initiative order',              src: '\\binitiative order', flags: 'i' },
  { label: 'saving throw',                  src: '\\bsaving throw',  flags: 'i' },
  { label: 'd20 / 2d6-style notation',      src: '\\b\\d*d(4|6|8|10|12|20|100)\\b', flags: '' },
];

/** Every register hit in one blob of text, as `label` strings. */
function hits(text) {
  let t = String(text || '');
  for (const ex of EXEMPT_LITERALS) t = t.replace(ex, ' ');
  const found = [];
  for (const tok of REGISTER) {
    const m = t.match(new RegExp(tok.src, tok.flags + 'g'));
    if (m) found.push(`${tok.label} → ${[...new Set(m)].join(', ')}`);
  }
  return found;
}

/** Every `description` string in a JSON-schema-ish object, at any depth. */
function descriptions(node, path, out) {
  if (!node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'description' && typeof v === 'string') out.push([path, v]);
    else if (v && typeof v === 'object') descriptions(v, `${path}.${k}`, out);
  }
  return out;
}

test('t0532-03 — NO milieu register in the MCP tool surface (an agent reads these to choose a tool)', () => {
  const tools = activeTools({ voiceEnabled: true });
  expect(tools.length > 0, 'the tool surface is non-empty (a guard over nothing proves nothing)', String(tools.length));

  const bad = [];
  for (const t of tools) {
    for (const h of hits(t.description)) bad.push(`${t.name} (tool description): ${h}`);
    for (const [path, text] of descriptions(t.input || {}, 'input', [])) {
      for (const h of hits(text)) bad.push(`${t.name} ${path}: ${h}`);
    }
  }

  expect(bad.length === 0,
    `${bad.length} milieu-register hit(s) in the MCP tool surface — this repo is domain-neutral `
    + '(Bruce: "No RPG references there. Use neutral terms."). Use presenter / participant / '
    + 'facilitator / session / deck / segment. ⛔ Do NOT rename the wire role value `gm`.',
    '\n  ' + bad.join('\n  '));
});

test('t0532-04 — NO milieu register in user-visible page text (comments excluded, deliberately)', () => {
  const files = execSync("git ls-files '*.html'", { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);
  expect(files.length > 0, 'there are tracked HTML pages to scan', String(files.length));

  const bad = [];
  for (const f of files) {
    for (const h of hits(stripComments(readFileSync(join(ROOT, f), 'utf8')))) bad.push(`${f}: ${h}`);
  }

  expect(bad.length === 0,
    `${bad.length} milieu-register hit(s) in user-visible page text — a human reads these. `
    + 'Use participant / facilitator / session. (Source COMMENTS are excluded on purpose; if the '
    + 'hit you are looking at is in a comment, this guard did not flag it.)',
    '\n  ' + bad.join('\n  '));
});

/*
 * Remove HTML comments, JS block comments and JS line comments. The line-comment pass is
 * quote-aware — it tracks ' " ` and backslash escapes — so `'https://…'` is NOT truncated and a
 * `//` inside a string is not mistaken for a comment. Imperfect on regex literals containing an
 * unbalanced quote; none exist in these pages, and the failure mode is over-stripping (a missed
 * hit), never a false accusation.
 */
function stripComments(src) {
  let s = src.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  return s.split('\n').map((line) => {
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '\\') { i++; continue; }
        if (c === q) q = null;
      } else if (c === "'" || c === '"' || c === '`') q = c;
      else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
    }
    return line;
  }).join('\n');
}
