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
 * READ perms (for diff/snapshot/log filtering, S7) are handled by canRead(actor,path)
 * where actor={role,userId} (Plan 0471 C3: default-DENY read + {self} allow rules).
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

// Plan 0471 C3 — READ is now DEFAULT-DENY with a prefix/self ALLOW-LIST (was default-open,
// which leaked every peer's vote/answer/marker/CRUD item live + in snapshot). Fail-closed: a
// missed allow rule renders a component BLANK (caught by the 14-component test), never a leak.
// A read rule's glob is a PREFIX: path EQUALS the glob or is a DESCENDANT of it (see readMatch).
export const ALL = ['participant', 'presenter', 'ai', 'gm'];
export const DEFAULT_READ_POLICY = [
  // shared surfaces (prefix rules cover nested children) — readable by everyone
  { glob: 'polls/*/spec', roles: ALL }, { glob: 'polls/*/open', roles: ALL },
  { glob: 'polls/*/results', roles: ALL },        // aggregate tally ONLY (D1); NEVER per-user votes
  { glob: 'map/view', roles: ALL }, { glob: 'map/markers', roles: ALL }, { glob: 'map/pointer', roles: ALL },
  { glob: 'crud', roles: ALL },                   // shared collaborative board
  // private per-user — a voter reads ONLY its own vote
  { glob: 'polls/*/votes/{self}', roles: ['participant'], self: true },
  // controller-only (gm is NOT an override role → list gm explicitly; presenter/ai override anyway)
  { glob: 'polls/*/votes', roles: ['gm'] }, { glob: 'polls/*/votes/*', roles: ['gm'] },
  { glob: 'answers', roles: ['gm'] }, { glob: 'gm', roles: ['gm'] },
  { glob: 'copresent', roles: ['gm'] }, { glob: 'chat', roles: ['gm'] },
];
// votes(peers)/answers/gm/copresent/chat have NO participant rule ⇒ hidden from participants live + in snapshot.

// WRITE matcher (S3): glob and path must have the SAME segment count (exact op target).
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

// Plan 0471 C3 — READ matcher: a glob is a PREFIX. `path` matches iff it EQUALS the glob
// or is a DESCENDANT of it (extra trailing segments allowed). A path SHORTER than the glob
// (an ancestor of an allow rule) does NOT match here — filterNode descends into it instead.
function readMatch(glob, path, actor) {
  const gs = glob.split('/'), ps = path.split('/');
  if (ps.length < gs.length) return false;
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

  /** Plan 0471 C3 — Can `actor` ({role,userId}) READ the value at `path`?
   *  Controllers (presenter/ai/system) override; else SOME allow rule must match its
   *  role AND its path (prefix/self). NO rule match ⇒ DENY (fail-closed, was open). */
  function canRead(actor, path) {
    const role = actor && actor.role;
    if (OVERRIDE_ROLES.has(role)) return true;             // presenter/ai/system see all
    for (const r of readPolicy) {
      if (!r.roles.includes(role)) continue;
      if (readMatch(r.glob, path, actor)) return true;
    }
    return false;                                          // default-DENY
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
