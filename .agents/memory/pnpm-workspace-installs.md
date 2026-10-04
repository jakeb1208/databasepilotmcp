---
name: pnpm workspace installs
description: Package-install helper behavior and dependency-link repair in this pnpm monorepo.
---

When adding a dependency to a leaf package, the package-management installer may run `pnpm add` at the workspace root and fail with `ERR_PNPM_ADDING_TO_ROOT`. Passing `--filter` through its package list is rejected. Use a package-scoped pnpm command as a fallback, then run `pnpm install --offline --frozen-lockfile` to reconcile workspace links before typechecking.

**Why:** A scoped add left a shared database package pointing at a removed peer-dependency variant of Drizzle; the full offline install restored the link without changing the lockfile resolution.

**How to apply:** In this pnpm monorepo, use the package-management helper first. If it cannot target the leaf package, scope the pnpm command explicitly and reconcile all workspace links before trusting a workspace-wide typecheck.