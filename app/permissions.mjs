/*
 * app/permissions.mjs — the permission STRATEGY (subsumes OPSEC).
 * A path-glob table maps ops to { roles, verbs, self? }. Controllers
 * (presenter / ai / system) OVERRIDE — they may do anything (the co-presenter
 * authority). Everyone else is DEFAULT-DENY (S3): an op is allowed only if some
 * rule matches its path + role + verb.
 *
 * Glob segments: literal | '*' (any one segment) | '{self}' (must equal the
 * actor's userId — enables "act only on your own slice"). Glob and path must have
 * the same number of segments.
 *
 * READ perms (for diff/snapshot/log filtering, S7) are handled by canRead(role,path).
 */
import { sanitizePath } from './state.mjs';

export const OVERRIDE_ROLES = new Set(['presenter', 'ai', 'system']);

// Default WRITE policy. Controllers override; these rules gate participants.
export const DEFAULT_POLICY = [
  { glob: 'polls/*/votes/{self}', roles: ['participant'], verbs: ['set'], self: true },
  { glob: 'answers/*/{self}', roles: ['participant'], verbs: ['set'], self: true },
  { glob: 'map/markers', roles: ['participant'], verbs: ['add', 'remove'] },
  { glob: 'map/pointer/{self}', roles: ['participant'], verbs: ['set'], self: true },
  { glob: 'crud/*/items', roles: ['participant'], verbs: ['add', 'remove'] },              // collection-level
  { glob: 'crud/*/items/*', roles: ['participant'], verbs: ['set', 'merge', 'lock', 'unlock'] }, // item-level
  { glob: 'chat', roles: ['participant'], verbs: ['add'] },
];

// Default READ policy (S7): path-glob -> roles allowed to SEE that slice's
// values. A missing match = readable by all (default-open READ; write is the
// gated axis). GM-only slices (group G): the 'gm/' subtree is controller-only, so
// its diffs/snapshot never reach a player.
export const DEFAULT_READ_POLICY = [
  { glob: 'gm/*', roles: ['presenter', 'ai', 'gm'] },
  { glob: 'gm/*/*', roles: ['presenter', 'ai', 'gm'] },
  { glob: 'copresent/*', roles: ['presenter', 'ai', 'gm'] },   // P2: co-presenter signals — controllers only
  { glob: 'chat/*', roles: ['presenter', 'ai', 'gm'] },        // P3: chat visible only to listeners (controllers)
];

function matchGlob(glob, path, actor) {
  const gs = glob.split('/');
  const ps = path.split('/');
  if (gs.length !== ps.length) return false;
  for (let i = 0; i < gs.length; i++) {
    const g = gs[i];
    if (g === '*') continue;
    if (g === '{self}') { if (ps[i] !== (actor && actor.userId)) return false; continue; }
    if (g !== ps[i]) return false;
  }
  return true;
}

export function createPermissions(policy = DEFAULT_POLICY, readPolicy = DEFAULT_READ_POLICY) {
  /**
   * Can `actor` ({userId, role}) perform `op` ({path, verb})?
   * Controllers override; else a rule must match path+role+verb (default-deny).
   */
  function can(actor, op) {
    if (!actor || !op) return false;
    if (!sanitizePath(op.path)) return false;                 // S4 — unsafe path never allowed
    if (OVERRIDE_ROLES.has(actor.role)) return true;          // presenter/ai/system override
    for (const r of policy) {
      if (!r.roles.includes(actor.role)) continue;
      if (!r.verbs.includes(op.verb)) continue;
      if (matchGlob(r.glob, op.path, actor)) return true;
    }
    return false;                                             // default-deny
  }

  /** Can `role` READ the value at `path`? Controllers always can; else a read
   *  rule (if any matches the path) must include the role; no match = open. */
  function canRead(role, path) {
    if (OVERRIDE_ROLES.has(role)) return true;
    let matched = false;
    for (const r of readPolicy) {
      if (matchGlob(r.glob, path, { userId: null })) { matched = true; if (r.roles.includes(role)) return true; }
    }
    return matched ? false : true;
  }

  /**
   * Content-item VISIBILITY as a read-permission (group G): 'all'/none = everyone;
   * 'gm' = controllers only. Replaces the ad-hoc scene-item strip with the perm model.
   */
  function canSeeVisibility(role, visibility) {
    if (!visibility || visibility === 'all') return true;
    if (visibility === 'gm') return role === 'presenter' || role === 'ai' || role === 'gm';
    return OVERRIDE_ROLES.has(role) || role === 'gm';   // unknown tag -> controllers only
  }

  return { can, canRead, canSeeVisibility, policy, readPolicy };
}
