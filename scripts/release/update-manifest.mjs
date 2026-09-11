#!/usr/bin/env node
/**
 * Builds and merges the `latest.json` the Tauri updater reads.
 *
 * This replaced a shell heredoc that defaulted the signature and the archive
 * name to empty strings and copied artifacts with `|| true`. A build that
 * produced no `.tar.gz.sig` still published a manifest — pointing at a URL
 * with no filename, with an empty signature — and the workflow reported
 * success. Every field is required here, and a missing one throws.
 *
 * Each build job emits a fragment for its own platform; the release job merges
 * the fragments into the single manifest that ships. Merging is where a
 * mismatched set gets caught: two fragments built from different versions is a
 * pipeline bug that would otherwise reach users as an update that installs the
 * wrong build.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { basename } from 'node:path'

/** Platform keys the Tauri updater understands, for the targets Dive builds. */
export const PLATFORM_KEYS = {
  'aarch64-apple-darwin': 'darwin-aarch64',
  'x86_64-apple-darwin': 'darwin-x86_64',
  'x86_64-pc-windows-msvc': 'windows-x86_64'
}

function required(value, what) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new Error(`Cannot build an update manifest without ${what}.`)
  return text
}

/**
 * What each platform's updater archive is named, by Tauri's own convention.
 *
 * On Windows that is the NSIS installer itself: the bundler signs `-setup.exe`
 * and the updater downloads and runs it. There is no separate archive, which is
 * worth stating because the older convention had one and the name lingers.
 */
const ARCHIVE_SUFFIX = { darwin: '.tar.gz', windows: '-setup.exe' }

/**
 * A one-platform manifest fragment.
 *
 * `archive` is the path to the updater archive and `signature` its detached
 * signature's contents — not a path, because an empty file is exactly the
 * failure this is here to catch.
 *
 * The archive's extension is checked against the platform rather than fixed:
 * the updater downloads whatever this URL names, so a `.dmg` or a `-setup.exe`
 * here produces a manifest that only fails on a user's machine.
 */
export function buildManifest({ version, target, archive, signature, notes, pubDate, baseUrl }) {
  const platform = PLATFORM_KEYS[required(target, 'a build target')]
  if (!platform) throw new Error(`No updater platform key for target ${target}.`)

  const file = basename(required(archive, 'an updater archive'))
  const suffix = ARCHIVE_SUFFIX[platform.split('-')[0]]
  if (!file.endsWith(suffix)) {
    throw new Error(`Updater archive for ${platform} must be a ${suffix}, got ${file}.`)
  }

  return {
    version: required(version, 'a version'),
    notes: notes?.trim() || `Dive ${version}`,
    pub_date: pubDate ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platforms: {
      [platform]: {
        signature: required(signature, 'a signature'),
        url: `${required(baseUrl, 'a download base URL').replace(/\/$/, '')}/${file}`
      }
    }
  }
}

/**
 * Merge platform fragments into the manifest that ships.
 *
 * The first fragment sets version, notes and publication date; the rest have
 * to agree on the version. Two platforms claiming the same key is a build
 * matrix that ran the same target twice, which would silently drop one.
 */
export function mergeManifests(manifests) {
  if (manifests.length === 0) throw new Error('No update manifests to merge.')

  const [first, ...rest] = manifests
  const platforms = { ...first.platforms }

  for (const manifest of rest) {
    if (manifest.version !== first.version) {
      throw new Error(
        `Update manifests disagree on the version: ${first.version} and ${manifest.version}.`
      )
    }
    for (const [key, value] of Object.entries(manifest.platforms)) {
      if (platforms[key]) throw new Error(`Two update manifests both describe ${key}.`)
      platforms[key] = value
    }
  }

  return { version: first.version, notes: first.notes, pub_date: first.pub_date, platforms }
}

/** Every platform in `manifest` has a non-empty signature and a URL with a filename. */
export function assertManifestComplete(manifest, expectedPlatforms = []) {
  const keys = Object.keys(manifest.platforms ?? {})
  if (keys.length === 0) throw new Error('Update manifest describes no platforms.')

  for (const key of keys) {
    const entry = manifest.platforms[key]
    if (!entry?.signature?.trim()) throw new Error(`${key} has no update signature.`)
    if (!entry?.url?.trim()) throw new Error(`${key} has no download URL.`)
    if (/\/$/.test(entry.url)) throw new Error(`${key} download URL has no filename: ${entry.url}`)
  }

  const missing = expectedPlatforms.filter((key) => !keys.includes(key))
  if (missing.length > 0) {
    throw new Error(`Update manifest is missing ${missing.join(', ')}.`)
  }
  return manifest
}

// Run directly, rather than imported by a test. Compared as a URL because
// Windows argv is a drive path -- `file://D:\\a\\x.mjs` never equals the
// `file:///D:/a/x.mjs` that import.meta.url holds, so the naive form left
// this whole block unreachable there and the script a silent no-op.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2)
  const flag = (name) => {
    const index = args.indexOf(`--${name}`)
    return index === -1 ? null : args[index + 1]
  }
  const command = args[0]

  if (command === 'build') {
    const signaturePath = required(flag('signature-file'), 'a signature file')
    const manifest = buildManifest({
      version: flag('version'),
      target: flag('target'),
      archive: flag('archive'),
      signature: readFileSync(signaturePath, 'utf8'),
      notes: flag('notes'),
      baseUrl: flag('base-url')
    })
    writeFileSync(required(flag('out'), 'an output path'), JSON.stringify(manifest, null, 2) + '\n')
    console.log(`Wrote ${flag('out')} for ${Object.keys(manifest.platforms).join(', ')}`)
  } else if (command === 'merge') {
    const inputs = args.slice(1).filter((arg) => arg.endsWith('.json'))
    const outIndex = inputs.indexOf(flag('out'))
    const sources = inputs.filter((_, index) => index !== outIndex)
    const merged = mergeManifests(sources.map((path) => JSON.parse(readFileSync(path, 'utf8'))))
    const expected = (flag('expect-platforms') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    assertManifestComplete(merged, expected)
    writeFileSync(required(flag('out'), 'an output path'), JSON.stringify(merged, null, 2) + '\n')
    console.log(`Merged ${sources.length} manifest(s) into ${flag('out')}:`)
    console.log(JSON.stringify(merged, null, 2))
  } else {
    console.error('usage: update-manifest.mjs build|merge [flags]')
    process.exit(1)
  }
}
