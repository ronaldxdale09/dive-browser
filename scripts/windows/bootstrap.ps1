# bootstrap.ps1 -- everything Dive needs to build on a fresh Windows machine.
#
#   In an admin PowerShell:
#     Set-ExecutionPolicy -Scope Process Bypass -Force
#     .\bootstrap.ps1
#
# Or, from the Mac, straight into a Parallels VM:
#     prlctl exec "Windows 11" powershell.exe -NoProfile -EncodedCommand <base64 of this file>
#
# Everything is installed machine-wide at fixed paths under C:\dev rather than
# into a user profile. `prlctl exec` runs as SYSTEM, so a per-user install
# would land in the system profile and be invisible to the person actually
# logged in -- and winget is a per-user app that SYSTEM cannot see at all,
# which is why nothing here uses it.
#
# Detects ARM64 rather than assuming: a Parallels VM on Apple Silicon is
# Windows-on-ARM, and CEF publishes windowsarm64 alongside windows64.
#
# -DevUser is the account that builds here (DOMAIN\user). It defaults to the
# logged-on console user, which is empty when nobody is logged on -- under
# `prlctl exec` with no session, pass it.
param([string] $DevUser)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # or Invoke-WebRequest crawls

# ---- Pinned downloads ------------------------------------------------------
# Every download is an exact version with a SHA-256, checked before anything is
# extracted or run (Assert-Sha256). Nothing here follows "latest".
#
# To bump a pin: download the new file, compare it with the publisher's own
# checksum (never one computed from the file you just fetched, unless the
# publisher has none -- see Ninja), then paste the version, URL and hash.
# One entry per architecture; keep Node's major in step with CI and the
# pnpm version with "packageManager" in the root package.json.
#
# Where each hash comes from:
#   Node      SHASUMS256.txt next to the release on nodejs.org
#   CMake     cmake-<ver>-SHA-256.txt in the Kitware GitHub release
#   Ninja     NO published checksum. The hashes below were COMPUTED
#             (shasum -a 256) on the release zips, not published by the
#             project; they pin the bytes seen when the pin was written.
#   Git       the SHA-256 table in the Git for Windows release notes
#   rustup    rustup-init.exe.sha256 next to each archive/<ver>/<triple> file
# The VS Build Tools bootstrapper (aka.ms, unversioned) cannot be hashed; it is
# checked by Authenticode signature instead (Assert-Signed).
$Pins = @{
    node = @{
        x64   = @{ version = "v24.22.3"
                   url = "https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.zip"
                   sha256 = "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f" }
        arm64 = @{ version = "v24.22.3"
                   url = "https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-arm64.zip"
                   sha256 = "b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14" }
    }
    cmake = @{
        x64   = @{ version = "4.4.5"
                   url = "https://github.com/Kitware/CMake/releases/download/v4.4.5/cmake-4.4.5-windows-x86_64.zip"
                   sha256 = "326c826486d46a23cf9d5a1c9ee3a567d427bdd02c4a34071937a2a675cff004" }
        arm64 = @{ version = "4.4.5"
                   url = "https://github.com/Kitware/CMake/releases/download/v4.4.5/cmake-4.4.5-windows-arm64.zip"
                   sha256 = "b0b54ebdd3e7b9f5ad733d865541d6e0a3b774182e4318b26890221432835359" }
    }
    ninja = @{
        x64   = @{ version = "1.13.2"
                   url = "https://github.com/ninja-build/ninja/releases/download/v1.13.2/ninja-win.zip"
                   sha256 = "07fc8261b42b20e71d1720b39068c2e14ffcee6396b76fb7a795fb460b78dc65" }
        arm64 = @{ version = "1.13.2"
                   url = "https://github.com/ninja-build/ninja/releases/download/v1.13.2/ninja-winarm64.zip"
                   sha256 = "e52f0bdef9dfb1003229dbd6508a508c4073fd017247002adc66e5e806cb0391" }
    }
    git = @{
        x64   = @{ version = "2.56.1"
                   url = "https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/Git-2.56.1-64-bit.exe"
                   sha256 = "c330c72e10b408cc39994bfefdb63542b0d93d21699325c3e0bd874af8a5a559" }
        arm64 = @{ version = "2.56.1"
                   url = "https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/Git-2.56.1-arm64.exe"
                   sha256 = "6fe770b534a459d1158011e6ec0cd8390a3bcf44e542bee9e9a650310e111234" }
    }
    rustup = @{
        x64   = @{ version = "1.29.3"
                   url = "https://static.rust-lang.org/rustup/archive/1.29.3/x86_64-pc-windows-msvc/rustup-init.exe"
                   sha256 = "38027d51d69a5d05493627a0634dbea52d6cd793c8f072d2373d3f4163eec7db" }
        arm64 = @{ version = "1.29.3"
                   url = "https://static.rust-lang.org/rustup/archive/1.29.3/aarch64-pc-windows-msvc/rustup-init.exe"
                   sha256 = "407e0d72f81d26a01f9d032b8317908cbb2917ba22765474b682b41390792ad9" }
    }
}

$Root = "C:\dev"
$Log = "C:\dive-setup.log"
function Say($m) { $l = "$(Get-Date -Format HH:mm:ss)  $m"; Write-Output $l; Add-Content $Log $l }
function Have($cmd) { $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }

# Native programs are judged by their exit code, never by whether they wrote
# to stderr. rustup, corepack and git all report progress there, and with
# ErrorActionPreference = Stop a `2>&1` pipe turns that chatter into a
# terminating error -- which is exactly how the first run of this script died
# one line after installing Rust successfully.
#
# A program that does not exist is NOT an exit code: `&` reports an error but
# does not throw under "Continue", and $LASTEXITCODE keeps the previous
# command's value, so a missing tool would look like success. Check first,
# and reset the code so a stale value can never be read.
function Run($exe, [string[]]$exeArgs, [switch]$IgnoreExit) {
    if (-not (Test-Path $exe) -and -not (Get-Command $exe -ErrorAction SilentlyContinue)) {
        throw "$exe was not found"
    }
    $global:LASTEXITCODE = 0
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $exe @exeArgs 2>&1 | ForEach-Object { $_.ToString() } | Out-Null
        if (-not $IgnoreExit -and $LASTEXITCODE -ne 0) {
            throw "$exe $($exeArgs -join ' ') exited $LASTEXITCODE"
        }
    } finally { $ErrorActionPreference = $prev }
}

function Add-MachinePath($dir) {
    $cur = [Environment]::GetEnvironmentVariable("Path", "Machine")
    if ($cur -notlike "*$dir*") {
        [Environment]::SetEnvironmentVariable("Path", "$cur;$dir", "Machine")
    }
    if ($env:Path -notlike "*$dir*") { $env:Path = "$env:Path;$dir" }
}

# Throws, and deletes the file, unless it hashes to what the pin says.
function Assert-Sha256($file, $expected) {
    $actual = (Get-FileHash -Algorithm SHA256 -Path $file).Hash
    if ($actual -ne $expected) {
        Remove-Item $file -Force -ErrorAction SilentlyContinue
        throw "SHA-256 mismatch for ${file}: expected $expected, got $actual"
    }
}

# For a download that has no stable hash: it must carry a valid Authenticode
# signature, and when -Subject is given the signer must contain it.
function Assert-Signed($file, [string]$Subject) {
    $sig = Get-AuthenticodeSignature -FilePath $file
    if ($sig.Status -ne "Valid") {
        Remove-Item $file -Force -ErrorAction SilentlyContinue
        throw "$file has no valid signature (status $($sig.Status))"
    }
    if ($Subject -and $sig.SignerCertificate.Subject -notlike "*$Subject*") {
        Remove-Item $file -Force -ErrorAction SilentlyContinue
        throw "$file is signed by $($sig.SignerCertificate.Subject), expected $Subject"
    }
}

# Download a pinned file and verify it before returning.
function Get-Pinned($pin, $out) {
    Invoke-WebRequest $pin.url -OutFile $out -UseBasicParsing
    Assert-Sha256 $out $pin.sha256
}

function Get-Zip($pin, $dest) {
    $tmp = "$env:TEMP\$([guid]::NewGuid()).zip"
    Get-Pinned $pin $tmp
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Expand-Archive $tmp -DestinationPath $dest -Force
    Remove-Item $tmp -Force
}

# A fresh Windows refuses to run .ps1 files at all, and pnpm ships as one.
# Without this the first `pnpm install` fails with a security error -- and if
# it is running detached, fails silently.
if ((Get-ExecutionPolicy -Scope LocalMachine) -in "Restricted", "Undefined") {
    Set-ExecutionPolicy -Scope LocalMachine RemoteSigned -Force
    Say "execution policy set to RemoteSigned"
}

$isArm = $env:PROCESSOR_ARCHITECTURE -eq "ARM64"
$pinArch = if ($isArm) { "arm64" } else { "x64" }
$rustTarget = if ($isArm) { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" }
Say "Windows $env:PROCESSOR_ARCHITECTURE, target $rustTarget"
New-Item -ItemType Directory -Force -Path $Root | Out-Null

# ---- Lock down C:\dev ------------------------------------------------------
# A folder an administrator creates directly under C:\ inherits "Authenticated
# Users: Modify", so any unelevated process could rewrite what is built from
# here. Only Administrators, SYSTEM and the developer get in. The SIDs
# (S-1-5-32-544, S-1-5-18) work on any display language.
if (-not $DevUser) { $DevUser = (Get-CimInstance Win32_ComputerSystem).UserName }
if (-not $DevUser) { throw "pass -DevUser <DOMAIN\user>" }
Say "developer account: $DevUser"
Run icacls @($Root, "/inheritance:r", "/grant:r", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "${DevUser}:(OI)(CI)M")
# Accepted residual: C:\dev\cargo, rustup, cef and the checkout stay
# developer-writable, because rustup, cargo and the CEF download write there
# during builds. cargo\bin is on the Machine PATH, so an elevated shell on the
# VM must not run builds. The tool directories below are locked at the end,
# once everything has been unpacked into them.

# ---- Visual Studio Build Tools -------------------------------------------
# The MSVC compiler and Windows SDK. cef-dll-sys builds libcef_dll_wrapper
# with CMake against these, and aws-lc-sys needs the SDK headers; without
# them both fail deep inside a C compile with no obvious cause.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$haveVs = (Test-Path $vswhere) -and (& $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null)
if ($haveVs) {
    Say "VS Build Tools already present"
} else {
    Say "installing VS Build Tools (several GB, slow)"
    $exe = "$env:TEMP\vs_BuildTools.exe"
    Invoke-WebRequest "https://aka.ms/vs/17/release/vs_BuildTools.exe" -OutFile $exe -UseBasicParsing
    # Microsoft publishes no stable hash for this link; check the signature.
    Assert-Signed $exe "O=Microsoft Corporation"
    $vsArgs = @(
        "--quiet", "--wait", "--norestart", "--nocache"
        "--add", "Microsoft.VisualStudio.Workload.VCTools"
        "--add", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
        "--add", "Microsoft.VisualStudio.Component.Windows11SDK.22621"
        # ring builds its assembly with clang, not MSVC, so a toolchain
        # without this fails on a crypto crate long before reaching any of
        # Dive's own code.
        "--add", "Microsoft.VisualStudio.ComponentGroup.NativeDesktop.Llvm.Clang"
        "--includeRecommended"
    )
    # Some build scripts still shell out to x64 helpers even on an ARM host,
    # so both toolsets go on.
    if ($isArm) { $vsArgs += @("--add", "Microsoft.VisualStudio.Component.VC.Tools.ARM64") }
    $p = Start-Process $exe -ArgumentList $vsArgs -Wait -PassThru
    # 3010 is "installed, reboot pending", which a build toolchain does not need.
    if ($p.ExitCode -notin 0, 3010) { throw "VS Build Tools installer exited $($p.ExitCode)" }
    Say "VS Build Tools installed"
}

# clang ships inside the VS install but not on PATH, and cc-rs looks it up by
# name. The ARM64 tree is the native compiler on an ARM host; the unsuffixed
# bin directory is x64.
$vs = & $vswhere -products * -property installationPath 2>$null | Select-Object -First 1
if ($vs) {
    $cand = if ($isArm) { @("$vs\VC\Tools\Llvm\ARM64\bin", "$vs\VC\Tools\Llvm\bin") }
            else { @("$vs\VC\Tools\Llvm\x64\bin", "$vs\VC\Tools\Llvm\bin") }
    $clang = $cand | Where-Object { Test-Path "$_\clang.exe" } | Select-Object -First 1
    if ($clang) { Add-MachinePath $clang; Say "clang at $clang" }
    else { Say "WARNING: no clang under $vs\VC\Tools\Llvm -- ring will not build" }
}

# ---- Rust ------------------------------------------------------------------
# Into C:\dev\cargo and C:\dev\rustup rather than a profile, so the toolchain is the same one
# whether SYSTEM or a person is driving the build.
$cargoHome = "$Root\cargo"; $rustupHome = "$Root\rustup"
[Environment]::SetEnvironmentVariable("CARGO_HOME", $cargoHome, "Machine")
[Environment]::SetEnvironmentVariable("RUSTUP_HOME", $rustupHome, "Machine")
$env:CARGO_HOME = $cargoHome; $env:RUSTUP_HOME = $rustupHome
Add-MachinePath "$cargoHome\bin"
if (Have rustc) {
    Say "rust already present: $(rustc --version)"
} else {
    Say "installing rust"
    $init = "$env:TEMP\rustup-init.exe"
    Get-Pinned $Pins.rustup[$pinArch] $init
    Run $init @("-y", "--no-modify-path", "--default-toolchain", "stable", "--profile", "minimal")
    Say "rust installed: $(& "$cargoHome\bin\rustc.exe" --version)"
}
Run "$cargoHome\bin\rustup.exe" @("component", "add", "clippy", "rustfmt")

# ---- Node and pnpm ---------------------------------------------------------
$npm = $null
if (Have node) {
    Say "node already present: $(node --version)"
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
} else {
    Say "installing node"
    # Pinned (see $Pins) to the Node major CI uses (node-version: 24). Not
    # "newest LTS": corepack is no longer bundled from Node 26 on, so a
    # floating pick leaves pnpm uninstallable. Bump together with CI.
    Get-Zip $Pins.node[$pinArch] $Root
    $nodeDir = (Get-ChildItem $Root -Directory -Filter "node-v*").FullName | Select-Object -First 1
    Add-MachinePath $nodeDir
    Say "node installed: $(& "$nodeDir\node.exe" --version)"
    $npm = "$nodeDir\npm.cmd"
}
if (-not $npm) { throw "node is present but npm.cmd was not found on PATH" }
Say "installing pnpm"
# Installed with npm, not corepack (not bundled from Node 26 on). The version
# must equal "packageManager" in the root package.json. The global pnpm.cmd
# lands in the Node directory, which Add-MachinePath already put on PATH.
Run $npm @("install", "--global", "pnpm@10.33.0")
Run "pnpm" @("--version")

# ---- CMake and Ninja -------------------------------------------------------
# cef-dll-sys needs both to build the CEF C++ wrapper.
if (-not (Have cmake)) {
    Say "installing cmake"
    Get-Zip $Pins.cmake[$pinArch] $Root
    $dir = (Get-ChildItem $Root -Directory -Filter "cmake-*").FullName | Select-Object -First 1
    Add-MachinePath "$dir\bin"
    Say "cmake installed"
}
if (-not (Have ninja)) {
    Say "installing ninja"
    Get-Zip $Pins.ninja[$pinArch] "$Root\ninja"
    Add-MachinePath "$Root\ninja"
    Say "ninja installed"
}

# ---- Git -------------------------------------------------------------------
if (-not (Have git)) {
    Say "installing git"
    $exe = "$env:TEMP\git-setup.exe"
    Get-Pinned $Pins.git[$pinArch] $exe
    # Runs elevated, so the signature is checked as well as the hash.
    Assert-Signed $exe
    Start-Process $exe -ArgumentList "/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-" -Wait
    Add-MachinePath "$env:ProgramFiles\Git\cmd"
    Say "git installed"
}

# ---- Lock the unpacked tools ----------------------------------------------
# These directories are on the Machine PATH, so an elevated shell would run
# whatever is in them. Make them read-and-execute for the developer: stop
# inheriting the developer's Modify from C:\dev, drop it, grant RX. Done last
# because the pnpm install above writes into the Node directory.
foreach ($d in @(Get-ChildItem $Root -Directory | Where-Object { $_.Name -like "node-*" -or $_.Name -like "cmake-*" -or $_.Name -eq "ninja" })) {
    Run icacls @($d.FullName, "/inheritance:d")
    Run icacls @($d.FullName, "/remove:g", $DevUser)
    Run icacls @($d.FullName, "/grant:r", "${DevUser}:(OI)(CI)RX")
    Say "locked $($d.FullName)"
}

# ---- CEF ------------------------------------------------------------------
# Downloaded by the first build, the same as on macOS; this only decides where.
$cef = "$Root\cef"
New-Item -ItemType Directory -Force -Path $cef | Out-Null
[Environment]::SetEnvironmentVariable("CEF_PATH", $cef, "Machine")
$env:CEF_PATH = $cef
Say "CEF_PATH = $cef"

Say "done"
Write-Output ""
Write-Output "Open a NEW shell so the machine PATH is picked up, then:"
Write-Output "    git clone https://github.com/ronaldxdale09/dive-browser.git C:\dev\dive"
Write-Output "    cd C:\dev\dive; . scripts\windows\msvc-runtime.ps1; pnpm install; pnpm dev"
Write-Output ""
Write-Output "The macOS-only code is not ported yet -- see docs/WINDOWS.md."
