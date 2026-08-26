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
  /*
   * ⭐ Plan 0691 — THE SHARED SLICE. Every rule above grants a participant write to something
   * the SERVER owns the shape of: their own vote, their own answer, a marker, a CRUD row. There
   * was no path where an AUTHOR could put a shared value of their own devising, so an authored
   * page could render a control and had nowhere legal to store what it controlled. A bound
   * <select> was denied by default-deny and the page silently did nothing.
   *
   * `shared/**` is that space, and it is deliberately WIDE: participants may set/merge/add/
   * remove/clear anything under it. That is the point — it is the collaborative surface.
   *
   * ⛔ WHAT KEEPS THIS SAFE IS THE PREFIX, NOT THE VERBS. Nothing the server relies on lives
   * under `shared/`: not identity, not roles, not caps, not polls, not the module. A participant
   * with a console can already send any op they like, so the boundary that matters is which
   * PATHS are reachable — and this adds exactly one subtree that the server never reads back as
   * authority. Do NOT move server-authoritative state under this prefix.
   */
  { glob: 'shared/**', roles: ['participant'], verbs: ['set', 'merge', 'add', 'remove', 'clear', 'lock', 'unlock'] },
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
  // Plan 0537 P2.1 — CHAT IS THE ROOM. Read was gm-only, an artifact of 0472's "typed text is
  // agent input" framing: chat existed to feed the unified inbox, so nobody but a listener needed
  // to see it. Bruce, S229: "chat was never intended as a player-GM backchannel". A room where
  // your neighbour cannot hear you is not a room. Participants now READ chat.
  // ⚠ WRITE is unchanged (add-only, below). The private aside is `/gm …`, which the server
  // diverts to the `gm` slice and therefore never lands here at all.
  { glob: 'chat', roles: ALL },
  // Plan 0691 — the shared authoring slice is world-readable by design: it exists so several
  // people can see the same control. A prefix rule, so every descendant is covered.
  { glob: 'shared', roles: ALL },
  // Plan 0537 P3.2 — the roll log. READ by everyone: a roll nobody else can see is not a roll, it
  // is a claim. ⛔ There is deliberately NO participant WRITE rule below — the SERVER rolls and the
  // server is the only writer, so nothing in this slice was asserted by a client.
  { glob: 'rolls', roles: ALL },
  // private per-user — a voter reads ONLY its own vote
  { glob: 'polls/*/votes/{self}', roles: ['participant'], self: true },
  // controller-only (gm is NOT an override role → list gm explicitly; presenter/ai override anyway)
  { glob: 'polls/*/votes', roles: ['gm'] }, { glob: 'polls/*/votes/*', roles: ['gm'] },
  { glob: 'answers', roles: ['gm'] }, { glob: 'gm', roles: ['gm'] },
  { glob: 'copresent', roles: ['gm'] },
];
// votes(peers)/answers/gm/copresent have NO participant rule ⇒ hidden from participants live + in snapshot.
// Plan 0537 P2.1: `chat` LEFT this list and is now world-readable (above). `gm` did NOT — and that
// is deliberately where `/gm …` asides are written, so the private backchannel inherits an
// already-proven default-deny instead of inventing a second secrecy mechanism.

// WRITE matcher (S3): glob and path must have the SAME segment count (exact op target).
function matchGlob(glob, path, actor) {
  const gs = glob.split('/');
  const ps = path.split('/');
  /*
   * Plan 0691 — a trailing '**' matches THIS SEGMENT AND ANY DEPTH BELOW IT. Every other glob
   * keeps the exact-segment-count rule, which is what makes a write rule name one precise op
   * target. '**' is legal only as the LAST segment: a middle '**' would make the count check
   * meaningless for the segments after it, and no rule needs it.
   */
  if (gs[gs.length - 1] === '**') {
    if (ps.length < gs.length) return false;                    // must reach at least the prefix
    for (let i = 0; i < gs.length - 1; i++) {
      const g = gs[i];
      if (g === '*') continue;
      if (g === '{self}') { if (ps[i] !== (actor && actor.userId)) return false; continue; }
      if (g !== ps[i]) return false;
    }
    return true;
  }
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
