/*
 * app/store-route.mjs — the C3 storefront's signed-in gate, engine side (Plan 0756, run C3d).
 *
 * REGISTERED into app/http-routes.mjs's `prefixRoutes` at `/store` (§2 below) — a minimal, ADDITIVE
 * edit to that live file, no existing route's body touched. This module stays its own file (not
 * inlined into http-routes.mjs) so it can ALSO be unit-tested directly, without a full HTTP
 * dispatcher — the same separation `resource-routes.mjs`/`plugin-client.mjs` already use in this
 * tree (R-101: mine the live file for its calling convention, keep the new logic in its own file).
 *
 * R-188 (quoted): "served only to signed-in accounts behind the presenter's OAuth" — this is why
 * the gate below calls oidcAuth.principalForRequest(req) (app/identity.mjs) rather than the
 * broader server.mjs authState/computeAuthCtx, which also admits break-glass and Tailscale.
 *
 * R-214 / components.tsv row B5's own evidence ("wiring the allow-list into the store page is
 * C3's"): a release whose licenceState is 'owner-only' additionally needs the viewer's account id
 * on the allow-list at {accountRoot}/owner-only-allowlist.tsv — read here with the SAME shape
 * lib/account/store-directory.mjs's readOwnerOnlyAllowList() uses, reimplemented locally because
 * this repo cannot import repertory code (R-217).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };

// tools/pss/routes.tsv: `@root dataRoot $PRESENTER_DATA_DIR $HOME/.local/state/argus-presenter`
export function dataRootFromEnv(env = process.env) {
  return env.PRESENTER_DATA_DIR || join(env.HOME || '', '.local', 'state', 'argus-presenter');
}
// `@route store page {dataRoot}/store` — no dedicated override var; always under dataRoot.
export function storeDirFromEnv(env = process.env) {
  return join(dataRootFromEnv(env), 'store');
}
// `@root accountRoot $PRESENTER_ACCOUNT_DIR {dataRoot}/accounts`
export function accountDirFromEnv(env = process.env) {
  return env.PRESENTER_ACCOUNT_DIR || join(dataRootFromEnv(env), 'accounts');
}

// Same shape as store-directory.mjs's readOwnerOnlyAllowList(): one account id per line, blank
// and `#`-comment lines skipped, default-deny ([] when the file is absent or empty).
function ownerOnlyAllowList(accountDir) {
  const p = join(accountDir, 'owner-only-allowlist.tsv');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function refuse(res, code, reason) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: reason }));
}

/**
 * createStoreRoute({ oidcAuth, storeDir, accountDir }) → (req, res) => void
 * `oidcAuth` must expose principalForRequest(req) — required, never defaulted, so this cannot be
 * wired up without an auth adapter by accident.
 */
export function createStoreRoute({ oidcAuth, storeDir = storeDirFromEnv(), accountDir = accountDirFromEnv() } = {}) {
  if (!oidcAuth || typeof oidcAuth.principalForRequest !== 'function') {
    throw new Error('store-route: oidcAuth.principalForRequest(req) is required (R-188)');
  }
  return function storeRoute(req, res) {
    const principal = oidcAuth.principalForRequest(req);
    if (!principal) { refuse(res, 401, 'signed-in account required (R-188)'); return; }

    let cards = [];
    try { cards = JSON.parse(readFileSync(join(storeDir, 'releases.json'), 'utf8')); } catch { cards = []; }
    const ownerOnly = cards.some((c) => c && c.licenceState === 'owner-only');
    if (ownerOnly) {
      const viewerId = principal.provider && principal.sub ? `${principal.provider}:${principal.sub}` : null;
      if (!viewerId || !ownerOnlyAllowList(accountDir).includes(viewerId)) {
        refuse(res, 403, 'owner-only release; this account is not on the allow-list (R-214)');
        return;
      }
    }

    const path = (req.url || '/').split('?')[0];
    const rel = (path === '/store' || path === '/store/') ? 'index.html' : path.replace(/^\/store\/?/, '');
    if (!rel || rel.includes('..')) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('bad path'); return; }
    const abs = join(storeDir, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    const ext = rel.slice(rel.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': CONTENT_TYPES[ext] || 'application/octet-stream' });
    res.end(readFileSync(abs));
  };
}
