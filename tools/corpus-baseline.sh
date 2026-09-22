#!/bin/bash
# tools/corpus-baseline.sh — WP3 pinned baseline extraction (git archive ONLY).
#
# Extracts the WP2 baseline commit (the parent of the commit whose subject is
# "feat: add structured decision question packs") into a unique temp dir, links
# the repository's node_modules, and builds it. The resulting dist can be used
# for a live A/B run via JEV_CORPUS_BASELINE_ROOT.
#
# SAFETY GUARANTEES (per the WP3 requirements):
#   - git archive only (no `git worktree`; never touches .git metadata)
#   - writes ONLY inside a unique mktemp -d directory
#   - verifies the repository node_modules exists before symlinking
#   - uses an absolute, resolved node_modules path
#   - cleans all temporary contents + the symlink via trap (EXIT/INT/TERM)
#   - fails non-zero on archive / build / setup failure
#   - never modifies the current worktree or .git metadata
#
# USAGE
#   tools/corpus-baseline.sh              # extract + build, print the dist root
#   JEV_CORPUS_BASELINE_ROOT=$(tools/corpus-baseline.sh --keep) ...
#     --keep: leave the temp dir in place (path printed) for a live run; you are
#             responsible for removing it afterwards.

set -euo pipefail

WP2_SUBJECT="feat: add structured decision question packs"
KEEP=0
if [[ "${1:-}" == "--keep" ]]; then KEEP=1; fi

# --- Resolve repository root (absolute) ------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- Discover the baseline commit dynamically ------------------------------
WP2_COMMIT="$(git log --format='%H%x09%s' | grep -F "$WP2_SUBJECT" | head -1 | cut -f1 || true)"
if [[ -z "${WP2_COMMIT}" ]]; then
  echo "corpus-baseline: no commit found with subject \"$WP2_SUBJECT\"" >&2
  exit 1
fi
BASELINE_COMMIT="$(git rev-parse "${WP2_COMMIT}^")"
BASELINE_SUBJECT="$(git log -1 --format=%s "$BASELINE_COMMIT")"

echo "corpus-baseline: WP2 commit   = $WP2_COMMIT" >&2
echo "corpus-baseline: baseline      = $BASELINE_COMMIT ($BASELINE_SUBJECT)" >&2

# --- Verify repository node_modules before symlinking ----------------------
if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
  echo "corpus-baseline: $REPO_ROOT/node_modules not found; run npm install first" >&2
  exit 1
fi
NODE_MODULES_ABS="$(cd "$REPO_ROOT/node_modules" && pwd)"

# --- Unique temp dir + cleanup trap ---------------------------------------
TMPDIR_BASE="$(mktemp -d "${TMPDIR:-/tmp}/jev-corpus-baseline.XXXXXX")"
cleanup() {
  if [[ "$KEEP" -eq 1 ]]; then
    echo "corpus-baseline: --keep set; leaving $TMPDIR_BASE in place" >&2
    return
  fi
  # Remove the symlink first (never follow it), then the tree.
  if [[ -L "$TMPDIR_BASE/node_modules" ]]; then rm -f "$TMPDIR_BASE/node_modules"; fi
  rm -rf "$TMPDIR_BASE"
}
trap cleanup EXIT INT TERM

# --- Extract via git archive (read-only) ----------------------------------
if ! git archive "$BASELINE_COMMIT" | tar -x -C "$TMPDIR_BASE"; then
  echo "corpus-baseline: git archive extraction failed" >&2
  exit 1
fi

# --- Symlink node_modules (absolute path) ---------------------------------
if ! ln -s "$NODE_MODULES_ABS" "$TMPDIR_BASE/node_modules"; then
  echo "corpus-baseline: failed to symlink node_modules" >&2
  exit 1
fi

# --- Build the baseline ---------------------------------------------------
if ! (cd "$TMPDIR_BASE" && npm run build >/dev/null 2>&1); then
  echo "corpus-baseline: baseline build failed" >&2
  exit 1
fi

if [[ ! -f "$TMPDIR_BASE/dist/provider.js" ]]; then
  echo "corpus-baseline: build produced no dist/provider.js" >&2
  exit 1
fi

# --- Report the dist root -------------------------------------------------
echo "corpus-baseline: baseline built at $TMPDIR_BASE" >&2
echo "$TMPDIR_BASE"
