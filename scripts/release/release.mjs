#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')

// --- Semver Helpers ---

const STABLE_TAG_PATTERN = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)$/
const RC_TAG_PATTERN = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)-rc\.([0-9]+)(?:\.([a-zA-Z0-9.-]+))?$/

export function parseTag(tag) {
  if (typeof tag !== 'string') return null
  const clean = tag.trim()

  const rcMatch = RC_TAG_PATTERN.exec(clean)
  if (rcMatch) {
    return {
      tag: clean.startsWith('v') ? clean : `v${clean}`,
      major: Number(rcMatch[1]),
      minor: Number(rcMatch[2]),
      patch: Number(rcMatch[3]),
      rc: Number(rcMatch[4]),
      suffix: rcMatch[5] || null,
      base: `${rcMatch[1]}.${rcMatch[2]}.${rcMatch[3]}`
    }
  }

  const stableMatch = STABLE_TAG_PATTERN.exec(clean)
  if (stableMatch) {
    return {
      tag: clean.startsWith('v') ? clean : `v${clean}`,
      major: Number(stableMatch[1]),
      minor: Number(stableMatch[2]),
      patch: Number(stableMatch[3]),
      rc: null,
      suffix: null,
      base: `${stableMatch[1]}.${stableMatch[2]}.${stableMatch[3]}`
    }
  }

  return null
}

export function compareSemver(a, b) {
  const diff =
    (a.major || 0) - (b.major || 0) ||
    (a.minor || 0) - (b.minor || 0) ||
    (a.patch || 0) - (b.patch || 0)
  if (diff !== 0) return diff

  const aRc = a.rc === undefined ? null : a.rc
  const bRc = b.rc === undefined ? null : b.rc
  if (aRc === bRc) return 0
  if (aRc === null) return 1
  if (bRc === null) return -1
  return aRc - bRc
}

export function getLocalTags() {
  try {
    const stdout = execSync('git tag -l "v*"', { cwd: ROOT, encoding: 'utf8' })
    return stdout
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export function computeNextVersion({ kind = 'rc', explicitVersion = null, suffix = null }) {
  if (explicitVersion) {
    const clean = explicitVersion.replace(/^v/, '')
    const parsed = parseTag(clean)
    if (!parsed) throw new Error(`Invalid version format: ${explicitVersion}`)
    return clean
  }

  // Read current version from package.json as ground truth fallback
  const pkgPath = resolve(ROOT, 'apps/desktop/package.json')
  const currentPkgVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version || '0.1.0'

  const tags = getLocalTags()
  const parsedTags = tags.map(parseTag).filter(Boolean).sort(compareSemver)
  const latestStable = parsedTags.filter((t) => t.rc === null).pop() || parseTag(currentPkgVersion)

  let major = latestStable.major
  let minor = latestStable.minor
  let patch = latestStable.patch

  if (kind === 'major') {
    major += 1
    minor = 0
    patch = 0
    return `${major}.${minor}.${patch}`
  }

  if (kind === 'minor') {
    minor += 1
    patch = 0
    return `${major}.${minor}.${patch}`
  }

  if (kind === 'patch') {
    patch += 1
    return `${major}.${minor}.${patch}`
  }

  // RC cut: target next patch by default unless currently in a minor/major cycle
  const targetBase = `${major}.${minor}.${patch + 1}`
  const existingRcs = parsedTags.filter((t) => t.base === targetBase && t.rc !== null)
  const nextRcNum = existingRcs.length > 0 ? Math.max(...existingRcs.map((t) => t.rc)) + 1 : 0

  let v = `${targetBase}-rc.${nextRcNum}`
  if (suffix) v += `.${suffix.replace(/^\.+/, '')}`
  return v
}

// --- Manifest Bumper ---

export function bumpManifests(newVersion) {
  const clean = newVersion.replace(/^v/, '')
  const filesModified = []

  // 1. Cargo.toml
  const cargoPath = resolve(ROOT, 'Cargo.toml')
  const cargoContent = readFileSync(cargoPath, 'utf8')
  const cargoRegex = /(\[workspace\.package\][\s\S]*?version\s*=\s*")[^"]*(")/
  if (!cargoRegex.test(cargoContent)) {
    throw new Error('Could not find [workspace.package] version in Cargo.toml')
  }
  writeFileSync(cargoPath, cargoContent.replace(cargoRegex, `$1${clean}$2`), 'utf8')
  filesModified.push('Cargo.toml')

  // 2. apps/desktop/package.json
  const pkgPath = resolve(ROOT, 'apps/desktop/package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.version = clean
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  filesModified.push('apps/desktop/package.json')

  // 3. apps/desktop/src-tauri/tauri.conf.json
  const tauriPath = resolve(ROOT, 'apps/desktop/src-tauri/tauri.conf.json')
  const tauriConf = JSON.parse(readFileSync(tauriPath, 'utf8'))
  tauriConf.version = clean
  writeFileSync(tauriPath, JSON.stringify(tauriConf, null, 2) + '\n', 'utf8')
  filesModified.push('apps/desktop/src-tauri/tauri.conf.json')

  return filesModified
}

// --- Release Cut CLI ---

export function cutRelease({ kind = 'rc', explicitVersion = null, push = false, dryRun = false }) {
  const version = computeNextVersion({ kind, explicitVersion })
  const tag = `v${version}`

  console.log(`\n📦 Dive Browser Release Cut`)
  console.log(`   Target Version: ${version}`)
  console.log(`   Git Tag:        ${tag}\n`)

  if (dryRun) {
    console.log('🔍 [DRY RUN] Would bump Cargo.toml, package.json, and tauri.conf.json')
    console.log(`🔍 [DRY RUN] Would commit: "release: ${tag}"`)
    console.log(`🔍 [DRY RUN] Would tag:    ${tag}`)
    return { version, tag, dryRun: true }
  }

  // 1. Bump files
  bumpManifests(version)
  console.log('✅ Updated manifests (Cargo.toml, package.json, tauri.conf.json)')

  // 2. Git stage & commit
  execSync('git add Cargo.toml apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json', { cwd: ROOT })
  execSync(`git commit -m "release: ${tag}"`, { cwd: ROOT })
  console.log(`✅ Created commit: "release: ${tag}"`)

  // 3. Git tag
  execSync(`git tag -a "${tag}" -m "Dive Browser ${tag}"`, { cwd: ROOT })
  console.log(`✅ Created tag: ${tag}`)

  // 4. Git push if requested
  if (push) {
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()
    console.log(`🚀 Pushing ${currentBranch} and ${tag} to origin...`)
    execSync(`git push origin "${currentBranch}"`, { cwd: ROOT })
    execSync(`git push origin "${tag}"`, { cwd: ROOT })
    console.log('🎉 Pushed release commit and tag to GitHub!')
  }

  return { version, tag, dryRun: false }
}

// --- CLI Runner ---

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  const action = process.argv[2] || 'check'
  const arg = process.argv[3]

  if (action === 'check') {
    const kind = arg || 'rc'
    console.log(computeNextVersion({ kind }))
  } else if (action === 'bump') {
    if (!arg) {
      console.error('Usage: node scripts/release/release.mjs bump <version>')
      process.exit(1)
    }
    bumpManifests(arg)
    console.log(`Bumper updated manifests to ${arg}`)
  } else if (action === 'cut') {
    const kind = ['rc', 'patch', 'minor', 'major'].includes(arg) ? arg : 'rc'
    const push = process.argv.includes('--push')
    const dryRun = process.argv.includes('--dry-run')
    cutRelease({ kind, push, dryRun })
  } else {
    console.log('Usage: node scripts/release/release.mjs [check|bump|cut] [args]')
  }
}
