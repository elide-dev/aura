#!/usr/bin/env bash
#
# Emits Bazel workspace-status key/value pairs consumed by
# `--workspace_status_command` (wired to the `bes` config in .bazelrc).
#
# BuildBuddy reads these keys to attribute an invocation to a commit —
# COMMIT_SHA / BRANCH_NAME cannot live in .bazelrc as --build_metadata flags
# (rc files have no command substitution), and the workspace-status route is
# what https://www.buildbuddy.io/docs/guide-metadata/ recommends instead.
#
# Every key here is deliberately UNPREFIXED (volatile): Bazel writes them to
# bazel-out/volatile-status.txt, which only re-stamps outputs and never enters
# action digests — the commit sha is a label on the invocation, not an input,
# and a STABLE_ prefix would cascade rebuilds on every commit.
#
# If the script exits non-zero, Bazel discards its output and stamps nothing.

set -eu

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if commit_sha="$(git -C "${workspace_root}" rev-parse HEAD 2>/dev/null)"; then
  echo "COMMIT_SHA ${commit_sha}"
fi

# CI checkouts are detached HEADs; GITHUB_REF_NAME carries the real branch
# (or tag) name there. rev-parse covers local work.
branch_name="${GITHUB_REF_NAME:-}"
if [ -z "${branch_name}" ]; then
  branch_name="$(git -C "${workspace_root}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
fi
if [ -n "${branch_name}" ] && [ "${branch_name}" != "HEAD" ]; then
  # GIT_BRANCH is the key BuildBuddy's workspace-status parser reads;
  # BRANCH_NAME is the --build_metadata spelling. Emit both — harmless
  # elsewhere, and whichever the server prefers wins.
  echo "GIT_BRANCH ${branch_name}"
  echo "BRANCH_NAME ${branch_name}"
fi

# Dirty-worktree indicator shown next to the commit in the BuildBuddy UI.
if git -C "${workspace_root}" diff-index --quiet HEAD -- 2>/dev/null; then
  echo "GIT_TREE_STATUS Clean"
else
  echo "GIT_TREE_STATUS Modified"
fi
