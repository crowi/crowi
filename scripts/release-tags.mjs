#!/usr/bin/env node
// SINGLE SOURCE OF TRUTH for Crowi distribution version parsing + Docker image
// tag rules. RFC: feature-ci-release-automation D3.
//
// Three places used to (or would) re-derive these rules and could drift:
//   - scripts/build-images.mjs   (local/manual full+slim build)
//   - scripts/compute-dist-version.mjs (release.yml: next distribution version)
//   - .github/workflows/docker.yml (CI multi-arch build+push)
// They now all import the pure functions here so the rule lives in ONE file.
//
// Tagging scheme (A) — like the node / postgres official images:
//   - The DEFAULT variant (full) carries NO suffix; the slim variant gets `-slim`.
//   - The image version is the INDEPENDENT Crowi DISTRIBUTION version (D3), NOT
//     any single npm package version. The distribution version bumps on EVERY
//     release (even a plugin-only patch) — see compute-dist-version.mjs.
//   - Prerelease versions (e.g. 2.0.0-alpha.2) tag the exact version plus a
//     moving CHANNEL tag (`alpha`); they do NOT move `latest` (a bare
//     `docker pull crowi` must keep meaning "latest stable").
//   - Stable versions (e.g. 2.0.0) tag the exact version plus `latest`.
//
// So for distribution version v2.0.0-alpha.2:
//   full → crowi:2.0.0-alpha.2       , crowi:alpha
//   slim → crowi:2.0.0-alpha.2-slim  , crowi:alpha-slim
// For stable v2.0.0.0 (4-segment distribution counter on stable base):
//   full → crowi:2.0.0.0             , crowi:latest
//   slim → crowi:2.0.0.0-slim        , crowi:latest-slim

// Strip a leading `v` from a tag/version string. The distribution version is
// carried as a git tag `v<dist>`; image tags use the bare `<dist>`.
export const stripV = (version) => (version.startsWith('v') ? version.slice(1) : version)

// Parse a full version (`2.0.0-alpha.2`, with or without a leading `v`) into its
// release part and prerelease channel. `2.0.0-alpha.2` → { release: '2.0.0',
// channel: 'alpha', isPrerelease: true }; `2.0.0` → { release: '2.0.0',
// channel: null, isPrerelease: false }. The distribution version reuses the
// same dash-separated prerelease shape, so a 4-segment stable distribution
// version `2.0.0.0` parses as release `2.0.0.0`, no channel.
export const parseVersion = (version) => {
  const bare = stripV(version)
  const dash = bare.indexOf('-')
  if (dash === -1) return { release: bare, channel: null, isPrerelease: false }
  return {
    release: bare.slice(0, dash),
    // channel = the prerelease identifier without the numeric suffix: `alpha.2` → `alpha`.
    channel: bare.slice(dash + 1).split('.')[0],
    isPrerelease: true,
  }
}

// The distribution "base" used by compute-dist-version.mjs: major.minor.patch is
// kept verbatim; a prerelease keeps only its CHANNEL identifier (drops the
// trailing numeric counter). `2.0.0-alpha.1` → `2.0.0-alpha`, `2.1.0-beta.3` →
// `2.1.0-beta`, `2.0.0` → `2.0.0`.
export const baseFromVersion = (version) => {
  const { release, channel, isPrerelease } = parseVersion(version)
  return isPrerelease ? `${release}-${channel}` : release
}

// The moving tags (without the variant suffix) for a distribution version:
//   - prerelease → the channel (`alpha`); latest is NOT moved.
//   - stable     → `latest`.
export const movingTags = (version) => {
  const { channel, isPrerelease } = parseVersion(version)
  return isPrerelease ? [channel] : ['latest']
}

// All image tags for one variant of a distribution version.
//   - variant 'full' → no suffix; variant 'slim' → `-slim` on every tag.
//   - tags = the immutable exact-version tag + the moving tag(s).
// The input may be `v2.0.0-alpha.2` or `2.0.0-alpha.2`; the leading `v` is
// dropped (Docker tags do not carry it).
export const tagsFor = (version, variant) => {
  const suffix = variant === 'slim' ? '-slim' : ''
  const bare = stripV(version)
  return [`${bare}${suffix}`, ...movingTags(version).map((t) => `${t}${suffix}`)]
}

// Fully-qualified image references (`<image>:<tag>`) for one variant — exactly
// what docker/build-push-action wants in its `tags:` input.
export const imageRefsFor = (image, version, variant) => tagsFor(version, variant).map((t) => `${image}:${t}`)

// --- CLI -------------------------------------------------------------------
// `node scripts/release-tags.mjs --image crowi/crowi --dist-version v2.0.0-alpha.2 --variant full`
// prints the newline-joined fully-qualified image refs (the format
// docker/build-push-action's `tags:` accepts) so docker.yml feeds the SAME tag
// rule into the build instead of re-encoding it in metadata-action's tag DSL.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const opt = (name, fallback) => {
    const i = argv.indexOf(name)
    return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
  }
  const image = opt('--image', 'crowi/crowi')
  const distVersion = opt('--dist-version', null)
  const variant = opt('--variant', 'full')
  if (!distVersion) {
    console.error('release-tags: --dist-version <v...> is required in CLI mode')
    process.exit(1)
  }
  if (variant !== 'full' && variant !== 'slim') {
    console.error(`release-tags: unknown --variant '${variant}' (expected full | slim)`)
    process.exit(1)
  }
  process.stdout.write(`${imageRefsFor(image, distVersion, variant).join('\n')}\n`)
}
