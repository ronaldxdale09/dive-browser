#!/usr/bin/env node
/**
 * Checks that a published release carries everything an update needs.
 *
 * The build can succeed and the publish can succeed while the release is still
 * unusable: no `latest.json` means no client ever sees the update, and a
 * missing `.tar.gz.sig` means the updater rejects the one it does see. This
 * runs against the release as GitHub actually stored it, after publishing,
 * because that is the only state users are served from.
 */

const API_VERSION = '2022-11-28'

/** Asset kinds a macOS release has to carry to be installable and updatable. */
export function requiredAssets() {
  return [
    { name: 'update manifest', match: (file) => file === 'latest.json' },
    { name: 'DMG installer', match: (file) => file.endsWith('.dmg') },
    { name: 'updater archive', match: (file) => file.endsWith('.tar.gz') },
    { name: 'updater signature', match: (file) => file.endsWith('.tar.gz.sig') }
  ]
}

/** Names of the required asset kinds that `assets` does not satisfy. */
export function missingAssetKinds(assets, required = requiredAssets()) {
  const names = assets.map((asset) => asset.name ?? String(asset))
  return required.filter((kind) => !names.some((name) => kind.match(name))).map((kind) => kind.name)
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION
    }
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`GitHub ${response.status} ${response.statusText}: ${body.slice(0, 300)}`)
  }
  return response.json()
}

/** Throw unless the release tagged `tag` carries every required asset. */
export async function verifyRelease({ repo, tag, token, fetchRelease = null }) {
  const release = fetchRelease
    ? await fetchRelease(tag)
    : await githubJson(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, token)

  const assets = release.assets ?? []
  const missing = missingAssetKinds(assets)
  if (missing.length > 0) {
    throw new Error(
      `Release ${tag} is missing: ${missing.join(', ')}. ` +
        `Published assets: ${assets.map((a) => a.name).join(', ') || '(none)'}`
    )
  }

  // An asset can exist and still be empty when an upload is truncated, which
  // presents to the updater as a corrupt download rather than a missing file.
  const empty = assets.filter((asset) => asset.size === 0).map((asset) => asset.name)
  if (empty.length > 0) throw new Error(`Release ${tag} has empty assets: ${empty.join(', ')}`)

  return { tag, assets: assets.map((asset) => asset.name) }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [, , tag] = process.argv
  const repo = process.env.GITHUB_REPOSITORY
  const token = process.env.GITHUB_TOKEN
  if (!tag || !repo || !token) {
    console.error('usage: GITHUB_REPOSITORY=o/r GITHUB_TOKEN=... verify-release-assets.mjs <tag>')
    process.exit(1)
  }
  const result = await verifyRelease({ repo, tag, token })
  console.log(`${tag} carries: ${result.assets.join(', ')}`)
}
