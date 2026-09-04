#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import { parseDesktopStableTag, parseDesktopRcTag, compareSemver } from './latest-stable-release.mjs'

const API_VERSION = '2022-11-28'
const MAX_RELEASE_BODY_LENGTH = 120_000
const TRUNCATION_NOTICE =
  '\n\n---\nRelease notes were truncated because GitHub release bodies are limited to 125,000 characters.'

export function truncateReleaseBody(body, maxLength = MAX_RELEASE_BODY_LENGTH) {
  if (!body || body.length <= maxLength) {
    return body || ''
  }

  const availableLength = maxLength - TRUNCATION_NOTICE.length
  if (availableLength <= 0) {
    throw new Error('Release truncation notice is longer than maximum body length')
  }

  return `${body.slice(0, availableLength).trimEnd()}${TRUNCATION_NOTICE}`
}

export function latestPreviousPublishedTag(releases, tag) {
  const current = parseDesktopRcTag(tag) || parseDesktopStableTag(tag)
  if (!current) return ''

  const previous = releases
    .filter((r) => r && r.draft === false && typeof r.tag_name === 'string')
    .map((r) => parseDesktopRcTag(r.tag_name) || parseDesktopStableTag(r.tag_name))
    .filter((candidate) => candidate && candidate.tag !== tag)
    .filter((candidate) => compareSemver(candidate, current) < 0)
    // Public changelogs for stable releases summarize since the prior stable, not an RC
    .filter((candidate) => current.rc !== null || candidate.rc === null)
    .sort(compareSemver)

  return previous.at(-1)?.tag ?? ''
}

async function githubJson(fetchImpl, url, token, options = {}) {
  const res = await fetchImpl(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      ...options.headers
    }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub request failed ${res.status} ${res.statusText}: ${body.slice(0, 300)}`)
  }
  return res.json()
}

export async function createDraftRelease({
  repo,
  tag,
  token,
  fetchImpl = fetch,
  log = console.log
}) {
  if (!repo) throw new Error('repo is required')
  if (!tag) throw new Error('tag is required')
  if (!token) throw new Error('token is required')

  // 1. Fetch existing releases to identify boundary
  const releases = await githubJson(
    fetchImpl,
    `https://api.github.com/repos/${repo}/releases?per_page=100`,
    token
  )

  const previousTag = latestPreviousPublishedTag(releases, tag)

  // 2. Generate release notes
  let generatedNotes = `## Dive Browser ${tag}\n\nAutomated production release.`
  try {
    const notesRes = await githubJson(
      fetchImpl,
      `https://api.github.com/repos/${repo}/releases/generate-notes`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          tag_name: tag,
          target_commitish: tag,
          ...(previousTag ? { previous_tag_name: previousTag } : {})
        })
      }
    )
    if (notesRes?.body) {
      generatedNotes = notesRes.body
    }
  } catch (err) {
    log(`Notice: notes generation failed (${err.message}); using default summary.`)
  }

  const body = truncateReleaseBody(generatedNotes)
  const isPrerelease = tag.includes('-rc.')

  // 3. Create draft release
  await githubJson(fetchImpl, `https://api.github.com/repos/${repo}/releases`, token, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: tag,
      name: `Dive Browser ${tag}`,
      body,
      draft: true,
      prerelease: isPrerelease
    })
  })

  log(`Created draft release ${tag} (prerelease: ${isPrerelease}) on ${repo}`)
}

async function main() {
  const tag = process.argv[2]
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY || 'ronaldxdale09/dive-browser'

  if (!tag) {
    console.error('Usage: node create-draft-release.mjs <tag>')
    process.exit(1)
  }

  try {
    await createDraftRelease({ repo, tag, token })
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
