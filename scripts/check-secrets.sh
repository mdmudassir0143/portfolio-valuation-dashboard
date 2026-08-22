#!/usr/bin/env bash
#
# Fails if any credential-shaped string is tracked by git.
#
# Run it before committing:   npm run check:secrets
#
# Scans only files git actually tracks, which is the thing that matters — an
# untracked local .env is fine and expected; a tracked one is the problem.

set -uo pipefail

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Not a git repository — nothing is tracked, so nothing can leak. Skipping."
  exit 0
fi

failed=0

# 1. An Alchemy key, in any tracked file.
if git grep -nIE 'alch_[A-Za-z0-9_-]{16,}' -- . >/dev/null 2>&1; then
  red "FAIL: an Alchemy API key appears in a tracked file:"
  git grep -nIE 'alch_[A-Za-z0-9_-]{16,}' -- .
  failed=1
fi

# 2. An authenticated Alchemy endpoint (the key embedded in a URL).
#    The placeholder forms in docs/examples are allowed.
if git grep -nIE '(eth|polygon|opt|arb|base|bnb)-[a-z]+\.g\.alchemy\.com/v2/[A-Za-z0-9_-]{16,}' -- . \
   | grep -vE 'YOUR_|<|\$\{|\*\*\*|your_alchemy' >/dev/null 2>&1; then
  red "FAIL: an authenticated Alchemy URL appears in a tracked file:"
  git grep -nIE '(eth|polygon|opt|arb|base|bnb)-[a-z]+\.g\.alchemy\.com/v2/[A-Za-z0-9_-]{16,}' -- . \
    | grep -vE 'YOUR_|<|\$\{|\*\*\*|your_alchemy'
  failed=1
fi

# 3. A tracked .env file. .env.example is the only one that belongs in git.
tracked_env="$(git ls-files | grep -E '(^|/)\.env$|(^|/)\.env\.(local|production|development)$' || true)"
if [ -n "$tracked_env" ]; then
  red "FAIL: an environment file is tracked by git:"
  echo "$tracked_env"
  red "      Run: git rm --cached <file>   (and rotate the key it contained)"
  failed=1
fi

# 4. .gitignore must actually cover .env.
if ! git check-ignore -q .env 2>/dev/null; then
  red "FAIL: .env is not gitignored — one 'git add -A' would commit your key."
  failed=1
fi

if [ "$failed" -eq 0 ]; then
  green "OK: no credentials found in tracked files, and .env is gitignored."
fi

exit "$failed"
