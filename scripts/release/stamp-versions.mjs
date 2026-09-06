#!/usr/bin/env node
/**
 * Writes a release version into the three manifests that carry one.
 *
 * Build jobs call this against a checkout they then throw away, so the version
 * reaches the binary without the repository having to record it first. The
 * finalize job calls the same code against `main` once the release is actually
 * published, which is the only time the bump is committed.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** The manifests that carry the app version, relative to the repo root. */
export const VERSIONED_FILES = [
  'Cargo.toml',
  'apps/desktop/package.json',
  'apps/desktop/src-tauri/tauri.conf.json'
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

/** Write `version` into every manifest under `root`. Returns which files changed. */
export function stampVersions(root, version) {
  const changed = []
  for (const file of VERSIONED_FILES) {
    const path = resolve(root, file)
    const before = readFileSync(path, 'utf8')
    const after = file.endsWith('.toml')
      ? stampCargoToml(before, version)
      : stampJsonVersion(before, version, file)
    if (after !== before) {
      writeFileSync(path, after)
      changed.push(file)
    }
  }
  return { changed, version }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
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
