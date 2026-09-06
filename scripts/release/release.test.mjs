/**
 * The release pipeline's logic, tested away from GitHub.
 *
 * These cover the decisions that used to live in shell inside the workflow,
 * where they could only be exercised by cutting a real release. The cases
 * worth having are the ones that previously failed silently: a manifest with
 * no signature, a version that disagrees across platforms, and a tag that was
 * already published.
 */
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  compareVersions,
  highestRelease,
  nextVersion,
  parseTag,
  resolveRelease
} from './resolve-release.mjs'
import { stampCargoLock, stampCargoToml, stampCrashReporterCfg, stampJsonVersion, VERSIONED_FILES, workspaceCrates } from './stamp-versions.mjs'
import {
  assertManifestComplete,
  buildManifest,
  mergeManifests,
  PLATFORM_KEYS
} from './update-manifest.mjs'
import { missingAssetKinds, verifyRelease } from './verify-release-assets.mjs'

describe('resolve-release', () => {
  it('reads stable and candidate tags, and rejects anything else', () => {
    expect(parseTag('v1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3, rc: null })
    expect(parseTag('v1.2.3-rc.4')).toMatchObject({ major: 1, minor: 2, patch: 3, rc: 4 })
    expect(parseTag('1.2.3')).toMatchObject({ version: '1.2.3' })
    expect(parseTag('v1.2')).toBeNull()
    expect(parseTag('nightly-v1.2.3')).toBeNull()
    expect(parseTag(undefined)).toBeNull()
  })

  it('sorts a candidate below its own stable release', () => {
    expect(compareVersions(parseTag('v1.0.0-rc.1'), parseTag('v1.0.0'))).toBeLessThan(0)
    expect(compareVersions(parseTag('v1.0.0-rc.1'), parseTag('v1.0.0-rc.2'))).toBeLessThan(0)
    expect(compareVersions(parseTag('v0.9.9'), parseTag('v1.0.0-rc.1'))).toBeLessThan(0)
    expect(highestRelease(['v0.1.3', 'v0.2.0-rc.0', 'v0.1.9'])).toMatchObject({ version: '0.2.0-rc.0' })
  })

  it('ignores tags that are not releases when picking the next version', () => {
    expect(nextVersion('patch', ['v0.1.3', 'not-a-tag', 'v0.1.2'])).toBe('0.1.4')
  })

  it('starts at 0.1.0 in a repository with no releases', () => {
    expect(nextVersion('patch', [])).toBe('0.1.0')
    expect(nextVersion('rc', [])).toBe('0.1.0-rc.0')
  })

  it('walks the candidate counter, then promotes it to its own stable', () => {
    expect(nextVersion('rc', ['v0.1.3'])).toBe('0.1.4-rc.0')
    expect(nextVersion('rc', ['v0.1.4-rc.0'])).toBe('0.1.4-rc.1')
    // Promoting must not skip 0.1.4 and land on 0.1.5.
    expect(nextVersion('patch', ['v0.1.3', 'v0.1.4-rc.1'])).toBe('0.1.4')
  })

  it('bumps minor and major from the highest release', () => {
    expect(nextVersion('minor', ['v0.1.3'])).toBe('0.2.0')
    expect(nextVersion('major', ['v0.1.3'])).toBe('1.0.0')
  })

  it('keeps a candidate out of the updater endpoint', () => {
    const rc = resolveRelease({ ref: 'v0.2.0-rc.0', tags: ['v0.1.3'] })
    expect(rc).toMatchObject({ isPrerelease: true, makeLatest: false, previousTag: 'v0.1.3' })
    const stable = resolveRelease({ ref: 'v0.2.0', tags: ['v0.1.3'] })
    expect(stable).toMatchObject({ isPrerelease: false, makeLatest: true })
  })

  it('refuses to cut a version that was already published', () => {
    expect(() => resolveRelease({ version: '0.1.3', tags: ['v0.1.3'] })).toThrow(/already exists/)
    // A tag push is re-runnable: the tag existing is the trigger, not a clash.
    expect(() => resolveRelease({ ref: 'v0.1.3', tags: ['v0.1.3'] })).not.toThrow()
  })

  it('leaves previousTag empty for a first release, so notes are not generated against nothing', () => {
    expect(resolveRelease({ ref: 'v0.1.0', tags: [] }).previousTag).toBe('')
  })

  it('rejects a ref or version that is not a release', () => {
    expect(() => resolveRelease({ ref: 'main' })).toThrow(/Not a release tag/)
    expect(() => resolveRelease({ version: 'latest' })).toThrow(/Not a valid version/)
  })
})

describe('stamp-versions', () => {
  it('replaces only the workspace version in Cargo.toml', () => {
    const source = '[workspace]\nmembers = ["a"]\n\n[workspace.package]\nversion = "0.1.3"\nedition = "2024"\n'
    const stamped = stampCargoToml(source, '0.2.0')
    expect(stamped).toContain('version = "0.2.0"')
    expect(stamped).toContain('edition = "2024"')
    expect(stamped).toContain('members = ["a"]')
  })

  it('replaces the first top-level version in a JSON manifest without reformatting it', () => {
    const source = '{\n  "productName": "Dive",\n  "version": "0.1.3",\n  "identifier": "app.dive"\n}\n'
    expect(stampJsonVersion(source, '0.2.0', 'tauri.conf.json')).toBe(
      '{\n  "productName": "Dive",\n  "version": "0.2.0",\n  "identifier": "app.dive"\n}\n'
    )
  })

  it('replaces only ProductVersion in the crashpad config', () => {
    const source = '[Config]\nProductName=Dive\nProductVersion=0.1.0\nAppName=Dive\n'
    expect(stampCrashReporterCfg(source, '0.2.0')).toBe('[Config]\nProductName=Dive\nProductVersion=0.2.0\nAppName=Dive\n')
  })

  it('fails loudly when a manifest has no version to stamp', () => {
    expect(() => stampCargoToml('[workspace]\n', '1.0.0')).toThrow(/workspace.package/)
    expect(() => stampJsonVersion('{}', '1.0.0', 'x.json')).toThrow(/version/)
    expect(() => stampCrashReporterCfg('[Config]\n', '1.0.0')).toThrow(/ProductVersion/)
  })

  const lock = [
    '# This file is automatically @generated by Cargo.',
    'version = 4',
    '',
    '[[package]]',
    'name = "anyhow"',
    'version = "1.0.99"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    '',
    '[[package]]',
    'name = "dive-core"',
    'version = "0.1.3"',
    'dependencies = ["anyhow"]',
    '',
    // A vendored path dependency: no `source`, but not ours to version.
    '[[package]]',
    'name = "tauri-runtime-cef"',
    'version = "0.1.0"',
    'dependencies = ["anyhow"]',
    ''
  ].join('\n')

  it('stamps only the named workspace crates in Cargo.lock', () => {
    const stamped = stampCargoLock(lock, '0.1.4', ['dive-core'])
    expect(stamped).toContain('name = "dive-core"\nversion = "0.1.4"')
    expect(stamped).toContain('name = "anyhow"\nversion = "1.0.99"')
    // The regression this guards: a vendored crate has no `source` line either.
    expect(stamped).toContain('name = "tauri-runtime-cef"\nversion = "0.1.0"')
    // The header's own `version = 4` is the lockfile format, not a crate.
    expect(stamped).toContain('version = 4\n')
  })

  it('is a no-op when the lockfile already carries the version', () => {
    expect(stampCargoLock(lock, '0.1.3', ['dive-core'])).toBe(lock)
  })

  it('fails when a workspace crate is missing from the lockfile, which means drift', () => {
    expect(() => stampCargoLock(lock, '1.0.0', ['dive-core', 'dive-ghost'])).toThrow(/dive-ghost/)
    expect(() => stampCargoLock('version = 4\n', '1.0.0', ['x'])).toThrow(/no \[\[package\]\]/)
  })

  it('resolves the real workspace: every member inherits the version, the vendored crate does not', () => {
    // vitest runs from apps/desktop and rewrites import.meta.url to /@fs/…, so
    // the repository root is two levels above the working directory.
    const names = workspaceCrates(resolve(process.cwd(), '../..'))
    expect(names).toEqual([
      'dive-agent', 'dive-cdp', 'dive-core', 'dive-desktop', 'dive-integration', 'dive-mcp'
    ])
    expect(names).not.toContain('tauri-runtime-cef')
  })

  it('names every manifest that carries the app version', () => {
    expect(VERSIONED_FILES).toEqual([
      'Cargo.toml',
      'Cargo.lock',
      'apps/desktop/package.json',
      'apps/desktop/src-tauri/tauri.conf.json',
      'apps/desktop/src-tauri/cef/crash_reporter.cfg'
    ])
  })
})

describe('update-manifest', () => {
  const base = {
    version: '0.1.4',
    target: 'aarch64-apple-darwin',
    archive: '/build/Dive.app.tar.gz',
    signature: 'SIGNATURE',
    baseUrl: 'https://github.com/o/r/releases/download/v0.1.4',
    pubDate: '2026-01-01T00:00:00Z'
  }

  it('builds a manifest whose URL points at an actual file', () => {
    const manifest = buildManifest(base)
    expect(manifest.platforms['darwin-aarch64']).toEqual({
      signature: 'SIGNATURE',
      url: 'https://github.com/o/r/releases/download/v0.1.4/Dive.app.tar.gz'
    })
    expect(manifest.notes).toBe('Dive 0.1.4')
  })

  it('refuses the empty signature the old shell heredoc would have published', () => {
    expect(() => buildManifest({ ...base, signature: '' })).toThrow(/signature/)
    expect(() => buildManifest({ ...base, signature: '   \n' })).toThrow(/signature/)
  })

  it('refuses a missing archive rather than emitting a URL with no filename', () => {
    expect(() => buildManifest({ ...base, archive: '' })).toThrow(/archive/)
    expect(() => buildManifest({ ...base, archive: '/build/Dive.dmg' })).toThrow(/tar\.gz/)
  })

  it('rejects a target with no updater platform key', () => {
    expect(() => buildManifest({ ...base, target: 'x86_64-pc-windows-msvc' })).toThrow(/platform key/)
    expect(Object.values(PLATFORM_KEYS)).toEqual(['darwin-aarch64', 'darwin-x86_64'])
  })

  it('merges one platform per architecture into a single manifest', () => {
    const arm = buildManifest(base)
    const intel = buildManifest({
      ...base,
      target: 'x86_64-apple-darwin',
      archive: '/build/Dive-x64.app.tar.gz',
      signature: 'SIGNATURE-X64'
    })
    const merged = mergeManifests([arm, intel])
    expect(Object.keys(merged.platforms)).toEqual(['darwin-aarch64', 'darwin-x86_64'])
    expect(merged.version).toBe('0.1.4')
  })

  it('catches a matrix that built two versions, which would ship the wrong binary', () => {
    const arm = buildManifest(base)
    const stale = buildManifest({ ...base, version: '0.1.3', target: 'x86_64-apple-darwin' })
    expect(() => mergeManifests([arm, stale])).toThrow(/disagree on the version/)
  })

  it('catches the same platform arriving twice, which would silently drop one', () => {
    expect(() => mergeManifests([buildManifest(base), buildManifest(base)])).toThrow(/both describe/)
  })

  it('requires every platform the release promised', () => {
    const merged = mergeManifests([buildManifest(base)])
    expect(() => assertManifestComplete(merged, ['darwin-aarch64'])).not.toThrow()
    expect(() => assertManifestComplete(merged, ['darwin-aarch64', 'darwin-x86_64'])).toThrow(
      /missing darwin-x86_64/
    )
  })

  it('rejects a manifest with no platforms at all', () => {
    expect(() => assertManifestComplete({ platforms: {} })).toThrow(/no platforms/)
    expect(() => mergeManifests([])).toThrow(/No update manifests/)
  })
})

describe('verify-release-assets', () => {
  const complete = [
    { name: 'latest.json', size: 300 },
    { name: 'Dive_0.1.4_aarch64.dmg', size: 90_000_000 },
    { name: 'Dive.app.tar.gz', size: 80_000_000 },
    { name: 'Dive.app.tar.gz.sig', size: 200 }
  ]

  it('accepts a release that carries everything an update needs', async () => {
    const result = await verifyRelease({
      tag: 'v0.1.4',
      fetchRelease: async () => ({ assets: complete })
    })
    expect(result.assets).toHaveLength(4)
  })

  it('names what is missing rather than failing generically', () => {
    expect(missingAssetKinds(complete.filter((a) => a.name !== 'latest.json'))).toEqual([
      'update manifest'
    ])
    expect(missingAssetKinds([])).toEqual([
      'update manifest',
      'DMG installer',
      'updater archive',
      'updater signature'
    ])
  })

  it('treats a .tar.gz.sig as a signature and not as the archive', () => {
    // `.tar.gz.sig` ends with neither `.tar.gz` nor `.dmg`, so a release with
    // only the signature must still report the archive as missing.
    const signatureOnly = [{ name: 'latest.json', size: 1 }, { name: 'Dive.app.tar.gz.sig', size: 1 }]
    expect(missingAssetKinds(signatureOnly)).toEqual(['DMG installer', 'updater archive'])
  })

  it('rejects a truncated upload, which reads as a corrupt download', async () => {
    await expect(
      verifyRelease({
        tag: 'v0.1.4',
        fetchRelease: async () => ({
          assets: complete.map((a) => (a.name === 'latest.json' ? { ...a, size: 0 } : a))
        })
      })
    ).rejects.toThrow(/empty assets: latest\.json/)
  })

  it('fails with the published asset list, so the cause is visible in the log', async () => {
    await expect(
      verifyRelease({ tag: 'v0.1.4', fetchRelease: async () => ({ assets: [] }) })
    ).rejects.toThrow(/Published assets: \(none\)/)
  })
})
