#!/usr/bin/env node

import { pathToFileURL } from 'node:url'

const API_VERSION = '2022-11-28'

export function getRequiredAssetPatterns(tag) {
  const version = tag.replace(/^v/i, '')
  return {
    version,
    requiredTypes: [
      { name: 'latest.json', match: (filename) => filename === 'latest.json' },
      { name: 'DMG installer', match: (filename) => filename.endsWith('.dmg') },
      { name: 'App tarball', match: (filename) => filename.endsWith('.tar.gz') },
      { name: 'App signature', match: (filename) => filename.endsWith('.tar.gz.sig') }
    ]
  }
}

async function githubFetch(url, token, accept = 'application/vnd.github+json') {
  const res = await fetch(url, {
    headers: {
      Accept: accept,
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION
    }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub request failed ${res.status} ${res.statusText}: ${body.slice(0, 300)}`)
  }
  return res
}

export async function fetchRelease(repo, tag, token) {
  const res = await githubFetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, token)
  const releases = await res.json()
  if (!Array.isArray(releases)) {
    throw new Error(`GitHub releases response for ${repo} was not an array`)
  }
  const release = releases.find((candidate) => candidate.tag_name === tag)
  if (!release) {
    throw new Error(`Release ${repo}@${tag} was not found in the releases list`)
  }
  return release
}

export async function verifyRequiredReleaseAssets({ repo, tag, token, releaseData = null }) {
  const release = releaseData || (await fetchRelease(repo, tag, token))
  const assets = release.assets || []
  const { version, requiredTypes } = getRequiredAssetPatterns(tag)

  // 1. Verify every required type has at least one matching non-empty asset
  for (const req of requiredTypes) {
    const matched = assets.filter((a) => req.match(a.name))
    if (matched.length === 0) {
      throw new Error(`Release ${tag} is missing required asset: ${req.name}`)
    }
    for (const asset of matched) {
      if (typeof asset.size === 'number' && asset.size <= 0) {
        throw new Error(`Release asset ${asset.name} is empty (size: ${asset.size})`)
      }
    }
  }

  // 2. Fetch and parse latest.json updater manifest to ensure consistency
  const latestJsonAsset = assets.find((a) => a.name === 'latest.json')
  if (!latestJsonAsset) {
    throw new Error('latest.json is missing from release assets')
  }

  let latestManifest
  if (latestJsonAsset.download_url) {
    const res = await fetch(latestJsonAsset.download_url)
    latestManifest = await res.json()
  } else if (token) {
    const res = await githubFetch(
      `https://api.github.com/repos/${repo}/releases/assets/${latestJsonAsset.id}`,
      token,
      'application/octet-stream'
    )
    latestManifest = JSON.parse(await res.text())
  }

  if (latestManifest) {
    if (latestManifest.version !== version) {
      throw new Error(
        `latest.json version mismatch: expected ${version}, found ${latestManifest.version}`
      )
    }
    const platforms = latestManifest.platforms || {}
    const darwin = platforms['darwin-aarch64'] || platforms['darwin-x86_64']
    if (!darwin || !darwin.signature || !darwin.url) {
      throw new Error(`latest.json is missing valid darwin updater signature or download url`)
    }
  }

  return {
    valid: true,
    assetCount: assets.length
  }
}

async function main() {
  const tag = process.argv[2]
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY || 'ronaldxdale09/dive-browser'

  if (!tag) {
    console.error('Usage: node verify-release-required-assets.mjs <tag>')
    process.exit(1)
  }

  try {
    const result = await verifyRequiredReleaseAssets({ repo, tag, token })
    console.log(`Release ${tag} verified: all ${result.assetCount} required assets valid and complete.`)
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
