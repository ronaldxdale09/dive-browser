#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')

export function bumpFiles(version, rootDir = ROOT) {
  const cleanVersion = version.replace(/^v/, '').trim()
  if (!cleanVersion) {
    throw new Error('Version is required')
  }

  // 1. Cargo.toml
  const cargoPath = resolve(rootDir, 'Cargo.toml')
  const cargoContent = readFileSync(cargoPath, 'utf8')
  const updatedCargo = cargoContent.replace(
    /(\[workspace\.package\][\s\S]*?version\s*=\s*")[^"]+(")/,
    `$1${cleanVersion}$2`
  )
  if (updatedCargo === cargoContent) {
    throw new Error('Failed to update version in Cargo.toml ([workspace.package] version match not found)')
  }
  writeFileSync(cargoPath, updatedCargo, 'utf8')

  // 2. apps/desktop/package.json
  const pkgPath = resolve(rootDir, 'apps/desktop/package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.version = cleanVersion
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

  // 3. apps/desktop/src-tauri/tauri.conf.json
  const tauriConfPath = resolve(rootDir, 'apps/desktop/src-tauri/tauri.conf.json')
  const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf8'))
  tauriConf.version = cleanVersion
  writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n', 'utf8')

  return {
    version: cleanVersion,
    files: [cargoPath, pkgPath, tauriConfPath]
  }
}

function main() {
  const version = process.argv[2]
  if (!version) {
    console.error('Usage: node bump-version.mjs <new-version>')
    process.exit(1)
  }

  try {
    const result = bumpFiles(version)
    console.log(`Successfully bumped workspace version to ${result.version}:`)
    result.files.forEach((f) => console.log(`  - ${f}`))
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main()
}
