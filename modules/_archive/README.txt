Plan 0522 P12 — RETIREMENT LANDS HERE.

A module retired from the Manage Modules panel (/manage) is MOVED into this directory, never
deleted. `modules/*.json` is gitignored, so almost every module on this box exists only on disk
with no version history: an `rm` would be permanent and unrecoverable.

To un-retire a module, move its file back up one directory. That is the whole undo mechanism.

This directory is out of the picker's scan path for free — listModules() is a non-recursive
readdir filtered to .json, so a subdirectory is never a candidate and no exclusion code exists
or is needed.
