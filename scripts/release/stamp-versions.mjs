#!/usr/bin/env node
/**
 * Writes a release version into every manifest that carries one.
 *
 * Build jobs call this against a checkout they then throw away, so the version
 * reaches the binary without the repository having to record it first. The
 * finalize job calls the same code against `main` once the release is actually
 * published, which is the only time the bump is committed.
 */

import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

/** The manifests that carry the app version, relative to the repo root. */
export const VERSIONED_FILES = [
  'Cargo.toml',
  'Cargo.lock',
  'apps/desktop/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
  'apps/desktop/src-tauri/cef/crash_reporter.cfg'
]

const CARGO_VERSION = /(\[workspace\.package\][\s\S]*?\bversion\s*=\s*")[^"]*(")/

/** Replace the `[workspace.package]` version, leaving the rest of the file byte-identical. */
export function stampCargoToml(source, version) {
  if (!CARGO_VERSION.test(source)) {
    throw new Error('Could not find a [workspace.package] version in Cargo.toml')
  }
  return source.replace(CARGO_VERSION, `$1${version}$2`)
}

/**
 * The names of the workspace crates whose version comes from `[workspace.package]`.
 *
 * Resolved from `[workspace] members` and each member's own manifest rather than
 * inferred from the lockfile: a vendored path dependency has no `source` line
 * either, and stamping it would corrupt Cargo.lock. Only members that declare
 * `version.workspace = true` change when the workspace version does.
 */
export function workspaceCrates(root) {
  const workspace = readFileSync(resolve(root, 'Cargo.toml'), 'utf8')
  const members = workspace.match(/^members\s*=\s*\[([^\]]*)\]/m)
  if (!members) throw new Error('Could not find [workspace] members in Cargo.toml')
  const patterns = [...members[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  const names = []
  for (const pattern of patterns) {
    for (const dir of globSync(pattern, { cwd: root })) {
      const manifestPath = resolve(root, dir, 'Cargo.toml')
      if (!existsSync(manifestPath)) continue
      const manifest = readFileSync(manifestPath, 'utf8')
      const name = manifest.match(/^name\s*=\s*"([^"]+)"/m)
      if (name && /^version\.workspace\s*=\s*true/m.test(manifest)) names.push(name[1])
    }
  }
  if (names.length === 0) throw new Error('No workspace crate inherits the workspace version')
  return names.sort()
}

/**
 * Replace the version of the named crates in Cargo.lock.
 *
 * The lockfile records each workspace member's version, so bumping Cargo.toml
 * alone leaves `--locked` builds failing against main. Done textually because
 * `finalize` runs where there is no cargo. Every named crate must be found:
 * a missing one means the lockfile and the workspace have drifted.
 */
export function stampCargoLock(source, version, crateNames) {
  const parts = source.split('\n[[package]]\n')
  if (parts.length < 2) throw new Error('Cargo.lock has no [[package]] entries')
  const wanted = new Set(crateNames)
  const found = new Set()
  const out = parts.map((block, index) => {
    if (index === 0) return block
    const name = block.match(/^name = "([^"]+)"$/m)?.[1]
    if (!name || !wanted.has(name)) return block
    found.add(name)
    return block.replace(/^version = "[^"]*"$/m, `version = "${version}"`)
  })
  const missing = crateNames.filter((name) => !found.has(name))
  if (missing.length > 0) throw new Error(`Cargo.lock has no entry for ${missing.join(', ')}`)
  return out.join('\n[[package]]\n')
}

/**
 * Replace the top-level `version` in a JSON manifest.
 *
 * Rewritten through a targeted replace rather than JSON.parse/stringify so
 * key order, indentation and the trailing newline survive; a reformatted
 * tauri.conf.json would be a large diff for a one-field change.
 */
export function stampJsonVersion(source, version, file) {
  const pattern = /(^\s*"version"\s*:\s*")[^"]*(")/m
  if (!pattern.test(source)) {
    throw new Error(`Could not find a "version" field in ${file}`)
  }
  return source.replace(pattern, `$1${version}$2`)
}

/**
 * Replace `ProductVersion=` in the crashpad config so a minidump names the
 * release it came from. `prepare-bundle.sh` rewrites the installed copy as
 * well; stamping the source keeps the checkout truthful between releases.
 */
export function stampCrashReporterCfg(source, version) {
  const pattern = /^(ProductVersion=).*$/m
  if (!pattern.test(source)) {
    throw new Error('Could not find ProductVersion in crash_reporter.cfg')
  }
  return source.replace(pattern, `$1${version}`)
}

/** Write `version` into every manifest under `root`. Returns which files changed. */
export function stampVersions(root, version) {
  const changed = []
  for (const file of VERSIONED_FILES) {
    const path = resolve(root, file)
    const before = readFileSync(path, 'utf8')
    const after = file === 'Cargo.lock'
      ? stampCargoLock(before, version, workspaceCrates(root))
      : file.endsWith('.toml')
        ? stampCargoToml(before, version)
        : file.endsWith('.cfg')
          ? stampCrashReporterCfg(before, version)
          : stampJsonVersion(before, version, file)
    if (after !== before) {
      writeFileSync(path, after)
      changed.push(file)
    }
  }
  return { changed, version }
}

// Run directly, rather than imported by a test. Compared as a URL because
// Windows argv is a drive path -- `file://D:\\a\\x.mjs` never equals the
// `file:///D:/a/x.mjs` that import.meta.url holds, so the naive form left
// this whole block unreachable there and the script a silent no-op.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const version = process.argv[2]
  if (!version) {
    console.error('usage: node scripts/release/stamp-versions.mjs <version> [--github-output]')
    process.exit(1)
  }
  const root = resolve(import.meta.dirname, '../..')
  const { changed } = stampVersions(root, version)
  if (process.argv.includes('--github-output') && process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed.length > 0}\n`)
  }
  console.log(
    changed.length > 0
      ? `Stamped ${version} into ${changed.join(', ')}`
      : `Already at ${version}; nothing to change.`
  )
}
