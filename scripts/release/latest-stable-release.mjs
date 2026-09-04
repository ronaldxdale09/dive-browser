#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const API_VERSION = '2022-11-28'
const DESKTOP_STABLE_TAG_PATTERN = /^v([0-9]+)\.([0-9]+)\.([0-9]+)$/
const DESKTOP_RC_TAG_PATTERN = /^v([0-9]+)\.([0-9]+)\.([0-9]+)-rc\.([0-9]+)$/

export function parseDesktopStableTag(tag) {
  if (typeof tag !== 'string') return null
  const match = DESKTOP_STABLE_TAG_PATTERN.exec(tag.trim())
  if (!match) return null

  return {
    tag: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rc: null,
    base: `${match[1]}.${match[2]}.${match[3]}`
  }
}

export function parseDesktopRcTag(tag) {
  if (typeof tag !== 'string') return null
  const match = DESKTOP_RC_TAG_PATTERN.exec(tag.trim())
  if (!match) return null

  return {
    tag: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rc: Number(match[4]),
    base: `${match[1]}.${match[2]}.${match[3]}`
  }
}

export function parseReleaseTag(tag) {
  return parseDesktopRcTag(tag) || parseDesktopStableTag(tag)
}

export function compareSemver(a, b) {
  const versionDiff =
    (a.major || 0) - (b.major || 0) ||
    (a.minor || 0) - (b.minor || 0) ||
    (a.patch || 0) - (b.patch || 0)
  if (versionDiff !== 0) {
    return versionDiff
  }
  const aRc = a.rc === undefined ? null : a.rc
  const bRc = b.rc === undefined ? null : b.rc
  if (aRc === bRc) {
    return 0
  }
  if (aRc === null) {
    return 1
  }
  if (bRc === null) {
    return -1
  }
  return aRc - bRc
}

export function semverGt(aVersion, bVersion) {
  const parse = (v) => {
    const prefixed = String(v).startsWith('v') ? String(v) : `v${v}`
    return parseReleaseTag(prefixed) || { major: 0, minor: 0, patch: 0, rc: null }
  }
  return compareSemver(parse(aVersion), parse(bVersion)) > 0
}

export function bumpVersion(version, kind = 'patch') {
  const raw = String(version).replace(/^v/, '').split('-')[0]
  const [maj = 0, min = 0, pat = 0] = raw.split('.').map(Number)
  if (kind === 'major') return `${maj + 1}.0.0`
  if (kind === 'minor') return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

export function latestStableDesktopReleaseTag(releases) {
  if (!Array.isArray(releases)) return ''
  const stableTags = releases
    .filter((release) => release?.draft !== true)
    .map((release) => parseDesktopStableTag(release?.tag_name ?? release?.tagName ?? ''))
    .filter(Boolean)
    .sort(compareSemver)

  return stableTags.at(-1)?.tag ?? ''
}

export function highestRcForBase(releases, base) {
  if (!Array.isArray(releases)) return null
  const cleanBase = base.replace(/^v/, '')
  const rcs = releases
    .map((release) => parseDesktopRcTag(release?.tag_name ?? release?.tagName ?? ''))
    .filter((parsed) => parsed && parsed.base === cleanBase)
    .map((parsed) => parsed.rc)
    .sort((a, b) => a - b)

  return rcs.length > 0 ? rcs.at(-1) : null
}

function gitTags(cwd = process.cwd()) {
  try {
    const stdout = execFileSync('git', ['tag', '-l'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return stdout
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((tag_name) => ({ tag_name, draft: false }))
  } catch {
    return []
  }
}

async function githubJson(fetchImpl, url, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  const res = await fetchImpl(url, { headers })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub request failed ${res.status} ${res.statusText}: ${body.slice(0, 300)}`)
  }
  return res.json()
}

export async function fetchReleases(repo, token, fetchImpl = fetch) {
  if (!repo) {
    return gitTags()
  }

  const releases = []
  try {
    for (let page = 1; ; page += 1) {
      const pageReleases = await githubJson(
        fetchImpl,
        `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,
        token
      )
      if (!Array.isArray(pageReleases)) break
      releases.push(...pageReleases)
      if (pageReleases.length < 100) break
    }
  } catch (err) {
    // If offline or no network access, fall back to local git tags
    const local = gitTags()
    if (local.length > 0) return local
    throw err
  }
  return releases
}

export async function computeNextReleaseVersion({
  repo,
  token,
  kind = 'rc',
  explicitVersion = '',
  versionSuffix = '',
  fetchImpl = fetch
}) {
  const releases = await fetchReleases(repo, token, fetchImpl).catch(() => gitTags())
  const latestStable = latestStableDesktopReleaseTag(releases) || 'v0.1.0'
  const latestStableVersion = latestStable.replace(/^v/, '')

  if (explicitVersion) {
    const clean = explicitVersion.replace(/^v/, '')
    if (!semverGt(clean, latestStableVersion)) {
      throw new Error(
        `Refusing explicit version ${clean}: not greater than latest stable ${latestStableVersion}.`
      )
    }
    return clean
  }

  if (kind === 'rc') {
    // Determine the base version for this RC:
    // If releases contains an active RC series newer than latest stable, advance that.
    // Otherwise, bump latest stable by patch.
    const activeRcs = releases
      .map((r) => parseDesktopRcTag(r?.tag_name ?? r?.tagName ?? ''))
      .filter(Boolean)
      .filter((rc) => semverGt(rc.base, latestStableVersion))
      .sort(compareSemver)

    const base = activeRcs.length > 0 ? activeRcs.at(-1).base : bumpVersion(latestStableVersion, 'patch')
    const highestRc = highestRcForBase(releases, base)
    const nextRcNum = highestRc === null ? 0 : highestRc + 1
    const suffix = versionSuffix ? `.${versionSuffix.replace(/^\./, '')}` : ''
    return `${base}-rc.${nextRcNum}${suffix}`
  }

  if (kind === 'patch' || kind === 'minor' || kind === 'major') {
    const next = bumpVersion(latestStableVersion, kind)
    if (!semverGt(next, latestStableVersion)) {
      throw new Error(`Refusing to cut ${kind} ${next}: not greater than latest stable ${latestStableVersion}.`)
    }
    return next
  }

  throw new Error(`Unknown release kind: ${kind}`)
}

async function main() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY || 'ronaldxdale09/dive-browser'
  const kind = process.env.KIND || process.argv[2] || 'rc'
  const explicitVersion = process.env.VERSION || ''
  const versionSuffix = process.env.VERSION_SUFFIX || ''

  try {
    const next = await computeNextReleaseVersion({
      repo,
      token,
      kind,
      explicitVersion,
      versionSuffix
    })
    console.log(next)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
