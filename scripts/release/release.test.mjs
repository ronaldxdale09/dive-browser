import { describe, expect, it, vi } from 'vitest'
import {
  parseDesktopStableTag,
  parseDesktopRcTag,
  compareSemver,
  semverGt,
  bumpVersion,
  latestStableDesktopReleaseTag,
  highestRcForBase,
  computeNextReleaseVersion
} from './latest-stable-release.mjs'
import { truncateReleaseBody, latestPreviousPublishedTag } from './create-draft-release.mjs'
import { getRequiredAssetPatterns, verifyRequiredReleaseAssets } from './verify-release-required-assets.mjs'
import { publishCompleteDraftReleases } from './publish-complete-draft-releases.mjs'

describe('latest-stable-release', () => {
  it('parses stable tags correctly', () => {
    expect(parseDesktopStableTag('v0.1.0')).toMatchObject({
      tag: 'v0.1.0',
      major: 0,
      minor: 1,
      patch: 0
    })
    expect(parseDesktopStableTag('v1.2.3')).toMatchObject({
      tag: 'v1.2.3',
      major: 1,
      minor: 2,
      patch: 3
    })
    expect(parseDesktopStableTag('v0.1.0-rc.0')).toBeNull()
    expect(parseDesktopStableTag('invalid-tag')).toBeNull()
  })

  it('parses rc tags correctly', () => {
    expect(parseDesktopRcTag('v0.2.0-rc.3')).toMatchObject({
      tag: 'v0.2.0-rc.3',
      major: 0,
      minor: 2,
      patch: 0,
      rc: 3,
      base: '0.2.0'
    })
    expect(parseDesktopRcTag('v0.1.0')).toBeNull()
  })

  it('compares semver correctly', () => {
    expect(semverGt('0.2.0', '0.1.9')).toBe(true)
    expect(semverGt('1.0.0', '0.9.9')).toBe(true)
    expect(semverGt('0.1.0', '0.1.0')).toBe(false)
    expect(semverGt('0.1.0', '0.1.1')).toBe(false)
  })

  it('bumps versions correctly', () => {
    expect(bumpVersion('0.1.0', 'patch')).toBe('0.1.1')
    expect(bumpVersion('0.1.0', 'minor')).toBe('0.2.0')
    expect(bumpVersion('0.1.0', 'major')).toBe('1.0.0')
  })

  it('identifies latest stable release from list', () => {
    const releases = [
      { tag_name: 'v0.1.0', draft: false },
      { tag_name: 'v0.1.1', draft: false },
      { tag_name: 'v0.2.0-rc.1', draft: false },
      { tag_name: 'v0.2.0', draft: true } // draft ignored
    ]
    expect(latestStableDesktopReleaseTag(releases)).toBe('v0.1.1')
  })

  it('finds highest RC for a base', () => {
    const releases = [
      { tag_name: 'v0.2.0-rc.0' },
      { tag_name: 'v0.2.0-rc.2' },
      { tag_name: 'v0.2.0-rc.1' },
      { tag_name: 'v0.3.0-rc.0' }
    ]
    expect(highestRcForBase(releases, '0.2.0')).toBe(2)
    expect(highestRcForBase(releases, '0.4.0')).toBeNull()
  })

  it('computes next release versions and enforces floor safety', async () => {
    const releases = [
      { tag_name: 'v0.1.0', draft: false },
      { tag_name: 'v0.2.0-rc.0', draft: false }
    ]
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => releases
    })

    // Next RC increments from 0.2.0-rc.0 -> 0.2.0-rc.1
    const nextRc = await computeNextReleaseVersion({
      repo: 'test/repo',
      token: 'mock-token',
      kind: 'rc',
      fetchImpl: mockFetch
    })
    expect(nextRc).toBe('0.2.0-rc.1')

    // Next minor cuts 0.2.0
    const nextMinor = await computeNextReleaseVersion({
      repo: 'test/repo',
      token: 'mock-token',
      kind: 'minor',
      fetchImpl: mockFetch
    })
    expect(nextMinor).toBe('0.2.0')

    // Regressive explicit version is rejected
    await expect(
      computeNextReleaseVersion({
        repo: 'test/repo',
        token: 'mock-token',
        explicitVersion: '0.0.9',
        fetchImpl: mockFetch
      })
    ).rejects.toThrow(/not greater than latest stable/)
  })
})

describe('create-draft-release', () => {
  it('truncates release body when exceeding limit', () => {
    const shortBody = 'Small changelog'
    expect(truncateReleaseBody(shortBody, 100)).toBe(shortBody)

    const longBody = 'A'.repeat(200)
    const truncated = truncateReleaseBody(longBody, 100)
    expect(truncated.length).toBeLessThanOrEqual(100)
    expect(truncated).toContain('Release notes were truncated')
  })

  it('finds latest previous published tag', () => {
    const releases = [
      { tag_name: 'v0.1.0', draft: false },
      { tag_name: 'v0.1.1', draft: false },
      { tag_name: 'v0.2.0-rc.0', draft: false }
    ]
    expect(latestPreviousPublishedTag(releases, 'v0.2.0-rc.1')).toBe('v0.2.0-rc.0')
    expect(latestPreviousPublishedTag(releases, 'v0.2.0')).toBe('v0.1.1')
  })
})

describe('verify-release-required-assets', () => {
  const validAssets = [
    { name: 'latest.json', size: 250 },
    { name: 'Dive_0.2.0_universal.dmg', size: 85_000_000 },
    { name: 'Dive.app.tar.gz', size: 80_000_000 },
    { name: 'Dive.app.tar.gz.sig', size: 120 }
  ]

  const validManifest = {
    version: '0.2.0',
    platforms: {
      'darwin-aarch64': {
        signature: 'mock-sig',
        url: 'https://github.com/ronaldxdale09/dive-browser/releases/download/v0.2.0/Dive.app.tar.gz'
      }
    }
  }

  it('validates complete assets and manifest', async () => {
    const releaseData = { assets: validAssets }
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(validManifest),
      json: async () => validManifest
    })

    const result = await verifyRequiredReleaseAssets({
      repo: 'test/repo',
      tag: 'v0.2.0',
      token: 'fake',
      releaseData
    })
    expect(result.valid).toBe(true)
    expect(result.assetCount).toBe(4)
  })

  it('rejects if an asset is missing or zero-sized', async () => {
    const incompleteAssets = [
      { name: 'latest.json', size: 250 },
      { name: 'Dive.dmg', size: 0 } // empty file!
    ]
    await expect(
      verifyRequiredReleaseAssets({
        repo: 'test/repo',
        tag: 'v0.2.0',
        token: 'fake',
        releaseData: { assets: incompleteAssets }
      })
    ).rejects.toThrow(/empty|missing/)
  })

  it('rejects if manifest version does not match tag', async () => {
    const mismatchedManifest = { ...validManifest, version: '0.1.9' }
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(mismatchedManifest),
      json: async () => mismatchedManifest
    })

    await expect(
      verifyRequiredReleaseAssets({
        repo: 'test/repo',
        tag: 'v0.2.0',
        token: 'fake',
        releaseData: { assets: validAssets }
      })
    ).rejects.toThrow(/version mismatch/)
  })
})

describe('publish-complete-draft-releases', () => {
  it('publishes verified drafts and skips incomplete ones', async () => {
    const releases = [
      { id: 101, tag_name: 'v0.2.0', draft: true, assets: [] }
    ]

    const mockVerify = vi.fn().mockResolvedValue({ valid: true })
    const mockFetch = vi.fn().mockImplementation((url, opts) => {
      if (opts?.method === 'PATCH') {
        return Promise.resolve({ ok: true, json: async () => ({ draft: false }) })
      }
      return Promise.resolve({ ok: true, json: async () => releases })
    })

    const result = await publishCompleteDraftReleases({
      repo: 'test/repo',
      token: 'fake-token',
      fetchImpl: mockFetch,
      verifyReleaseAssets: mockVerify,
      log: vi.fn()
    })

    expect(result.published).toContain('v0.2.0')
  })
})
