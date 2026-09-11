#!/usr/bin/env node
/**
 * Works out what version a release run is producing.
 *
 * The tag is the source of truth. On a tag push the version is read straight
 * out of the ref; on a manual run the next version is computed from the tags
 * that already exist, and the tag itself is not created until the release
 * publishes. Nothing here writes to the repository — a run that fails leaves
 * no tag and no commit behind, which is the whole point of resolving the
 * version instead of committing it up front.
 */

import { pathToFileURL } from 'node:url'

const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/
const RC = /^v?(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/

/** Parse a release tag, or null if it is not one. */
export function parseTag(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  const rc = RC.exec(raw)
  if (rc) {
    return {
      version: `${rc[1]}.${rc[2]}.${rc[3]}-rc.${rc[4]}`,
      major: Number(rc[1]),
      minor: Number(rc[2]),
      patch: Number(rc[3]),
      rc: Number(rc[4])
    }
  }
  const stable = STABLE.exec(raw)
  if (!stable) return null
  return {
    version: `${stable[1]}.${stable[2]}.${stable[3]}`,
    major: Number(stable[1]),
    minor: Number(stable[2]),
    patch: Number(stable[3]),
    rc: null
  }
}

/** Order two parsed tags. A release candidate sorts below its own stable. */
export function compareVersions(a, b) {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch
  if (core !== 0) return core
  if (a.rc === b.rc) return 0
  if (a.rc === null) return 1
  if (b.rc === null) return -1
  return a.rc - b.rc
}

/** The highest release among `tags`, or null when there are none yet. */
export function highestRelease(tags) {
  return tags
    .map(parseTag)
    .filter((parsed) => parsed !== null)
    .sort(compareVersions)
    .at(-1) ?? null
}

/**
 * The version a `kind` bump produces given the tags that already exist.
 *
 * `rc` walks the candidate counter on the *next* patch rather than re-cutting
 * the current one, so cutting rc after a stable release does not produce a
 * version that sorts below what is already published.
 */
export function nextVersion(kind, tags) {
  const latest = highestRelease(tags)
  if (!latest) return kind === 'rc' ? '0.1.0-rc.0' : '0.1.0'

  if (kind === 'rc') {
    // Still on a candidate for this base: take the next candidate number.
    if (latest.rc !== null) {
      return `${latest.major}.${latest.minor}.${latest.patch}-rc.${latest.rc + 1}`
    }
    return `${latest.major}.${latest.minor}.${latest.patch + 1}-rc.0`
  }

  // A candidate promotes to its own base rather than bumping past it.
  if (latest.rc !== null && kind === 'patch') {
    return `${latest.major}.${latest.minor}.${latest.patch}`
  }

  if (kind === 'patch') return `${latest.major}.${latest.minor}.${latest.patch + 1}`
  if (kind === 'minor') return `${latest.major}.${latest.minor + 1}.0`
  if (kind === 'major') return `${latest.major + 1}.0.0`
  throw new Error(`Unknown release kind: ${kind}`)
}

/**
 * Everything the workflow needs to know about the release it is building.
 *
 * `tags` is the existing tag list. `ref` is the pushed tag name when the run
 * came from a tag push, otherwise null. `kind` and `version` are the manual
 * inputs; an explicit version wins over a kind.
 */
export function resolveRelease({ ref = null, kind = 'patch', version = null, tags = [] }) {
  let parsed
  if (ref) {
    parsed = parseTag(ref)
    if (!parsed) throw new Error(`Not a release tag: ${ref}`)
  } else if (version) {
    parsed = parseTag(version)
    if (!parsed) throw new Error(`Not a valid version: ${version}`)
  } else {
    parsed = parseTag(nextVersion(kind, tags))
  }

  const tag = `v${parsed.version}`

  // A tag that already exists means this release was published before. Cutting
  // it again would either fail late or silently move the tag, so stop early.
  if (!ref && tags.includes(tag)) {
    throw new Error(`Tag ${tag} already exists; pick a different version.`)
  }

  const isPrerelease = parsed.rc !== null
  const previous = tags
    .map(parseTag)
    .filter((other) => other !== null && compareVersions(other, parsed) < 0)
    .sort(compareVersions)
    .at(-1)

  return {
    version: parsed.version,
    tag,
    name: `Dive ${parsed.version}`,
    isPrerelease,
    // A release candidate must never become the endpoint the updater reads.
    makeLatest: !isPrerelease,
    previousTag: previous ? `v${previous.version}` : ''
  }
}

// Run directly, rather than imported by a test. Compared as a URL because
// Windows argv is a drive path -- `file://D:\\a\\x.mjs` never equals the
// `file:///D:/a/x.mjs` that import.meta.url holds, so the naive form left
// this whole block unreachable there and the script a silent no-op.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , ...args] = process.argv
  const flag = (name) => {
    const index = args.indexOf(`--${name}`)
    return index === -1 ? null : args[index + 1]
  }
  const { execFileSync } = await import('node:child_process')
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const resolved = resolveRelease({
    ref: flag('ref'),
    kind: flag('kind') ?? 'patch',
    version: flag('version'),
    tags
  })

  if (args.includes('--github-output') && process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(resolved)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n'
    )
  }
  console.log(JSON.stringify(resolved, null, 2))
}
