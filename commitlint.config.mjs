// Phase D-α — Conventional Commits config for commitlint.
//
// Extends the standard `@commitlint/config-conventional` ruleset
// (Angular spec) with two repo-specific tweaks:
//
//   1. **Wider subject-case** — the standard config rejects
//      anything but lower-case subjects. This repo's existing
//      history happily mixes "Phase C.M3 — …" and other
//      mixed-case subjects, so we relax `subject-case` to accept
//      any case as long as the type/scope/subject shape is right.
//
//   2. **Wider header-max-length** — the standard cap is 100
//      chars; our convention prefixes versions like
//      `(0.4.48)` to commit subjects, plus em-dashes and
//      Conventional Commits scopes can push us past 100. Bump to
//      144 to give the existing style room to breathe.
//
// Allowed types come from the existing repo history (collected by
// `git log --format=%s | grep -oE '^[a-z]+' | sort -u`):
//
//   build / chore / ci / docs / feat / fix / perf / refactor /
//   revert / style / test
//
// Plus `release` for any future "release v…" commits the
// release-on-merge workflow may emit.

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'subject-case': [0],
    'header-max-length': [2, 'always', 144],
    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'style',
        'test',
        'release',
      ],
    ],
    // Scopes are free-form (plugin / server / proto / deploy /
    // ci / etc) — don't restrict via `scope-enum` because new
    // scopes appear naturally as the codebase grows.
    'scope-empty': [0],
  },
};
