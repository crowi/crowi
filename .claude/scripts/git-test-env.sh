#!/usr/bin/env bash
# Sourced by every shell test that runs git, right after it resolves its own
# directory. Drops the repository-local git environment so that a test's
# `git -C "$FIXTURE"` really means the fixture.
#
# Git exports these variables to hook processes, and lefthook and pnpm pass
# them straight through to whatever the hook runs. From a linked worktree,
# `GIT_DIR` is an ABSOLUTE path to that worktree's admin directory and
# `GIT_WORK_TREE` is unset — and git reads `GIT_DIR` in preference to `-C`.
# A fixture's `git init` then re-initialises the real repository through that
# admin dir's `commondir`, which writes `core.bare = true` into the config
# every worktree of the repo shares; the fixture's `git config user.*` lands
# in that same shared config, and its `git worktree add` registers the
# fixture paths against the real repository. The main worktree stops being a
# work tree at all: `git status` answers `fatal: this operation must be run
# in a work tree`.
#
# Unsetting `GIT_CONFIG_COUNT` is what disables any `GIT_CONFIG_KEY_n` /
# `GIT_CONFIG_VALUE_n` pairs; git ignores them without the count.
unset \
  GIT_ALTERNATE_OBJECT_DIRECTORIES \
  GIT_COMMON_DIR \
  GIT_CONFIG \
  GIT_CONFIG_COUNT \
  GIT_CONFIG_PARAMETERS \
  GIT_DIR \
  GIT_GRAFT_FILE \
  GIT_IMPLICIT_WORK_TREE \
  GIT_INDEX_FILE \
  GIT_NO_REPLACE_OBJECTS \
  GIT_OBJECT_DIRECTORY \
  GIT_PREFIX \
  GIT_REPLACE_REF_BASE \
  GIT_SHALLOW_FILE \
  GIT_WORK_TREE
