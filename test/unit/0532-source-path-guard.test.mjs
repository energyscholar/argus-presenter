/*
 * Plan 0532 P0 — THE RETIRED-SOURCE GUARD.
 *
 * The presenter's system plugin for one milieu used to be mined by hand out of a separate
 * private repo. It now lives in the content repo (`repertory`), under that milieu's
 * `systems/<system>/plugins/<id>/`. The old repo has NOT been deleted — it still holds
 * data/, src/, state/ and mcp-gm/ awaiting later mining — so nothing physically stops a script,
 * a manifest or a test here from quietly reading out of it again.
 *
 * That is exactly the failure this guard exists for. The location ruling has been broken three
 * times by people who looked at where the files were instead of at where they belong; a document
 * saying so has not stopped it. A red test at the moment the reference is written does.
 * (Same reasoning, same shape, as t0531-01 above it in this suite.)
 *
 * ── SCOPE, stated exactly so it can be judged rather than trusted ─────────────────────────────
 *
 *   IN  : every TRACKED file (`git ls-files`) whose extension is code or configuration — the
 *         CODE_EXT list below — plus tracked files with no extension (install scripts often
 *         have none). ANY occurrence of the retired repo's name, case-insensitive, in such a
 *         file is a violation. Deliberately NOT just path-shaped occurrences: in code or config
 *         there is no legitimate reason to name it at all, and demanding a literal trailing
 *         slash would be evaded by the first `REPO=<name>; ... "$REPO/presenter-plugins"`.
 *
 *   OUT : prose. Markdown and every other non-code extension are NOT scanned. Historical prose
 *         legitimately names the repo it describes — the MINED.md note left behind in that repo
 *         says where its plugin went, and the plan documents describing the migration name it
 *         throughout. Flagging those would make the guard something people switch off.
 *
 *   ⚠ THE HOLE THIS LEAVES, said here rather than discovered later: a source path written ONLY
 *     inside a Markdown install doc — a `cp -r ~/software/<retired>/...` in a fenced block — is
 *     NOT caught. Every rule tried that caught that also caught the legitimate historical prose
 *     in the same files, so the scope was cut at the code/prose line, which is the line plan
 *     0532 itself draws. If an install doc ever grows such a command, move the command into a
 *     script — where this guard does see it.
 *
 *   ⚠ And per the generator brief §6.2: this walks TRACKED files. A new file you have not
 *     `git add`-ed is invisible to it. Add before you believe it.
 *
 * `repertory` carries the same rule for its own tree, as `tools/no-obsolete-source-paths.sh`.
 * Two implementations, because the public repo must run in a clean clone with no repertory
 * present and cannot reach for a script that lives there. The scopes are written to match.
 */
import { test, expect } from '../../harness/test.mjs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const RETIRED_REPO = 'starship-operations';

const CODE_EXT = ['mjs', 'js', 'cjs', 'ts', 'mts', 'json', 'sh', 'bash', 'zsh', 'py', 'rb',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'html', 'htm', 'css', 'sql'];

/*
 * ALLOW-LIST — one entry, and it is the guard itself, which cannot help containing the string
 * it hunts for. ⛔ Nothing else earns a place here by being inconvenient. A real reference is a
 * violation to FIX. When this guard was first run it caught `test/unit/0514-p0-machine.test.mjs`,
 * whose t0514-00 failure message told the reader to install the plugin from the retired repo;
 * that message was repointed at repertory rather than exempted.
 */
const GUARD_SELF = 'test/unit/0532-source-path-guard.test.mjs';
const ALLOW_LIST = [GUARD_SELF];

test('t0532-01 — NO tracked code or config file reads from the retired plugin source repo', () => {
  const extAlt = CODE_EXT.join('|');
  // `git ls-files` (tracked only), narrowed to code/config extensions or no extension at all.
  const list = `git ls-files | grep -E '(\\.(${extAlt})$|^[^.]*$|/[^./]*$)'`;
  let out = '';
  try {
    out = execSync(`${list} | tr '\\n' '\\0' | xargs -0 -r grep -IlF -i -- '${RETIRED_REPO}' || true`,
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) { out = e.stdout || ''; }

  const files = out.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((f) => !ALLOW_LIST.includes(f));

  expect(files.length === 0,
    `${files.length} tracked code/config file(s) name the retired plugin source repo — the system `
    + 'plugin lives in repertory under systems/<system>/plugins/<id>/; read from there',
    '\n  ' + files.join('\n  '));
});
