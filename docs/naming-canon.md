# Naming Canon

**Status:** Canon. Binding on core, plugins, schemas, and wire payloads.
**Rule zero:** a name means exactly one thing across the whole system. Naming conflicts are not a
style preference — they are bugs waiting to happen, and they are never waived.

> If you need to remember context to know what a name refers to, the name is wrong.

This document is domain-neutral, like the core it governs. Domain vocabulary lives in plugins.

---

## 1. Names must be self-documenting

A reader who has never seen the file must be able to tell, from the name alone:
**what it is**, **what layer it belongs to**, and **what type it carries**.

| Bad | Why | Good |
|---|---|---|
| `role` | whose role? which layer? | `userRole` |
| `id` | of what? what type? | `crewUid` |
| `status` | of what? | `craftStatus` |
| `data`, `value`, `info`, `obj` | says nothing | name the content |
| `hex` | a colour? a coordinate? a hash? | `hexId` |
| `expect` (two different signatures) | ambiguous at the call site | `expectTest` / `expectDrive` |

## 2. Banned as standalone names

Never use these alone, in any identifier, column, object key, or wire field. Always qualify them
with the entity or layer they belong to:

`id` · `uid` · `name` · `type` · `code` · `label` · `status` · `state` · `role` · `order` ·
`data` · `value` · `info` · `source` · `notes` · `description` · `key` · `item` · `obj` · `res`

Qualified forms are correct: `crewUid`, `stationLabel`, `craftStatus`, `sortOrder`, `userRole`.

## 3. Identity is an integer UID, never a string

- Every entity has `<entity>_uid INTEGER PRIMARY KEY`.
- Every reference between entities carries that integer.
- A human-readable code (`'sensors'`) may exist as `<entity>_code TEXT NOT NULL UNIQUE` on the
  entity's own row, purely for authoring. It is resolved to a UID **at load**, and never appears as
  a foreign key, runtime lookup key, push target, or wire identifier.

Strings drift, get re-cased, get typo'd, and fail *silently*. Integers fail loudly or not at all.

**Self-reference** is qualified by its purpose: `carrier_craft_uid`, not `parent_uid`.

## 4. Case conventions by layer

| Layer | Convention | Example |
|---|---|---|
| SQL tables | singular, `snake_case` | `station`, `crew_member` |
| SQL columns | `snake_case`, entity-qualified | `station_label`, `crew_uid` |
| SQL views | `v_<entity>_public` / `v_<entity>_gm` | `v_crew_public` |
| JS identifiers | `camelCase` | `stationUid`, `userRole` |
| JS exported functions | `camelCase` verb-first | `resolveChrome()`, `loadManifests()` |
| Wire / JSON fields | `camelCase`, matching the JS name | `stationUid` |
| Files | `kebab-case.mjs` | `data-views.mjs` |
| Env vars | `SCREAMING_SNAKE` | `CAMPAIGN_DB` |

The **same concept keeps the same word across all layers** — only the casing changes.
`station_uid` (SQL) ⇄ `stationUid` (JS/wire). Never rename a concept as it crosses a boundary.

## 5. Views are player-safe by default

- `v_<entity>_public` — the only thing a client-facing applet may bind. Contains no secret columns
  *structurally*, not merely by convention at the call site.
- `v_<entity>_gm` — GM-only, never reachable from a shared surface.

Never bind a bare table to a display surface. Never `SELECT *` — enumerate every column, so adding a
column can never silently change a payload or leak a field.

## 6. One concept, one word — no synonyms

Before introducing a noun, check whether the system already has a word for that concept. Introducing
a synonym for an existing entity (a second table, a second field name, a parallel vocabulary) is a
naming conflict even though no identifier literally collides — and it is the most expensive kind,
because both names look correct in isolation.

If an existing word is wrong, **rename it**; do not add a better one alongside.

## 7. Enforcement

Lints in `test/unit/naming-canon.test.mjs`:

- **N-1** no `SELECT *` anywhere.
- **N-2** no banned standalone name (§2) in any `CREATE TABLE` / `CREATE VIEW`.
- **N-3** no string literal used as an entity reference at runtime or on the wire (§3).
- **N-4** no bare `role` identifier at any layer (§1).
- **N-5** collision scan: no exported symbol defined twice with differing signatures; no column name
  reused across tables with differing type or meaning unless it is a declared foreign key.

A lint failure means the name is wrong. Fix the name; do not weaken the lint or extend a
grandfather list to make a test pass.
