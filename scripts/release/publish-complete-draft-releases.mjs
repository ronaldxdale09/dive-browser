#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import { verifyRequiredReleaseAssets } from './verify-release-required-assets.mjs'

const API_VERSION = '2022-11-28'

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

export async function publishCompleteDraftReleases({
  repo,
  token,
  targetTag = null,
  fetchImpl = fetch,
  verifyReleaseAssets = verifyRequiredReleaseAssets,
  log = console.log
}) {
  if (!repo) throw new Error('repo is required')
  if (!token) throw new Error('token is required')

  const releases = await githubJson(
    fetchImpl,
    `https://api.github.com/repos/${repo}/releases?per_page=100`,
    token
  )

  const candidates = releases.filter((r) => r.draft === true && (!targetTag || r.tag_name === targetTag))
  const published = []
  const skipped = []

  for (const release of candidates) {
    const tag = release.tag_name
    try {
      await verifyReleaseAssets({ repo, tag, token, releaseData: release })
      const isRc = tag.includes('-rc.')
      await githubJson(
        fetchImpl,
        `https://api.github.com/repos/${repo}/releases/${release.id}`,
        token,
        {
          method: 'PATCH',
          body: JSON.stringify({
            draft: false,
            prerelease: isRc
          })
        }
      )
      log(`Published complete draft release ${tag} (prerelease: ${isRc})`)
      published.push(tag)
    } catch (err) {
      log(`Draft release ${tag} is not yet complete: ${err.message}`)
      skipped.push({ tag, reason: err.message })
    }
  }

  return { published, skipped }
}

async function main() {
  const tag = process.argv[2] || null
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY || 'ronaldxdale09/dive-browser'

  try {
    const result = await publishCompleteDraftReleases({ repo, token, targetTag: tag })
    console.log(`Published ${result.published.length} drafts: ${result.published.join(', ') || 'none'}`)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
