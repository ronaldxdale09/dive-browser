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
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # or Invoke-WebRequest crawls

$Root = "C:\dev"
$Log = "C:\dive-setup.log"
function Say($m) { $l = "$(Get-Date -Format HH:mm:ss)  $m"; Write-Output $l; Add-Content $Log $l }
function Have($cmd) { $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }

# Native programs are judged by their exit code, never by whether they wrote
# to stderr. rustup, corepack and git all report progress there, and with
# ErrorActionPreference = Stop a `2>&1` pipe turns that chatter into a
# terminating error -- which is exactly how the first run of this script died
# one line after installing Rust successfully.
function Run($exe, [string[]]$exeArgs, [switch]$IgnoreExit) {
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

function Get-Zip($url, $dest) {
    $tmp = "$env:TEMP\$([guid]::NewGuid()).zip"
    Invoke-WebRequest $url -OutFile $tmp -UseBasicParsing
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Expand-Archive $tmp -DestinationPath $dest -Force
    Remove-Item $tmp -Force
}

$isArm = $env:PROCESSOR_ARCHITECTURE -eq "ARM64"
$rustTarget = if ($isArm) { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" }
Say "Windows $env:PROCESSOR_ARCHITECTURE, target $rustTarget"
New-Item -ItemType Directory -Force -Path $Root | Out-Null

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
    $vsArgs = @(
        "--quiet", "--wait", "--norestart", "--nocache"
        "--add", "Microsoft.VisualStudio.Workload.VCTools"
        "--add", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
        "--add", "Microsoft.VisualStudio.Component.Windows11SDK.22621"
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

# ---- Rust ------------------------------------------------------------------
# Into C:\dev\rust rather than a profile, so the toolchain is the same one
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
    $arch = if ($isArm) { "aarch64" } else { "x86_64" }
    $init = "$env:TEMP\rustup-init.exe"
    Invoke-WebRequest "https://static.rust-lang.org/rustup/dist/$arch-pc-windows-msvc/rustup-init.exe" -OutFile $init -UseBasicParsing
    Run $init @("-y", "--no-modify-path", "--default-toolchain", "stable", "--profile", "minimal")
    Say "rust installed: $(& "$cargoHome\bin\rustc.exe" --version)"
}
Run "$cargoHome\bin\rustup.exe" @("component", "add", "clippy", "rustfmt")

# ---- Node and pnpm ---------------------------------------------------------
if (Have node) {
    Say "node already present: $(node --version)"
} else {
    Say "installing node"
    # Resolved from the dist index rather than pinned, so this does not rot.
    $index = Invoke-RestMethod "https://nodejs.org/dist/index.json" -UseBasicParsing
    $want = if ($isArm) { "win-arm64-zip" } else { "win-x64-zip" }
    $rel = $index | Where-Object { $_.lts -and $_.files -contains $want } | Select-Object -First 1
    $arch = if ($isArm) { "arm64" } else { "x64" }
    Get-Zip "https://nodejs.org/dist/$($rel.version)/node-$($rel.version)-win-$arch.zip" $Root
    $nodeDir = (Get-ChildItem $Root -Directory -Filter "node-v*").FullName | Select-Object -First 1
    Add-MachinePath $nodeDir
    Say "node installed: $(& "$nodeDir\node.exe" --version)"
}
Say "enabling pnpm"
Run "corepack" @("enable")
Run "corepack" @("prepare", "pnpm@latest", "--activate")

# ---- CMake and Ninja -------------------------------------------------------
# cef-dll-sys needs both to build the CEF C++ wrapper.
if (-not (Have cmake)) {
    Say "installing cmake"
    $rel = Invoke-RestMethod "https://api.github.com/repos/Kitware/CMake/releases/latest" -Headers @{ "User-Agent" = "dive" }
    $suffix = if ($isArm) { "windows-arm64.zip" } else { "windows-x86_64.zip" }
    $asset = $rel.assets | Where-Object { $_.name -like "*$suffix" } | Select-Object -First 1
    Get-Zip $asset.browser_download_url $Root
    $dir = (Get-ChildItem $Root -Directory -Filter "cmake-*").FullName | Select-Object -First 1
    Add-MachinePath "$dir\bin"
    Say "cmake installed"
}
if (-not (Have ninja)) {
    Say "installing ninja"
    $rel = Invoke-RestMethod "https://api.github.com/repos/ninja-build/ninja/releases/latest" -Headers @{ "User-Agent" = "dive" }
    $want = if ($isArm) { "ninja-winarm64.zip" } else { "ninja-win.zip" }
    $asset = $rel.assets | Where-Object { $_.name -eq $want } | Select-Object -First 1
    Get-Zip $asset.browser_download_url "$Root\ninja"
    Add-MachinePath "$Root\ninja"
    Say "ninja installed"
}

# ---- Git -------------------------------------------------------------------
if (-not (Have git)) {
    Say "installing git"
    $rel = Invoke-RestMethod "https://api.github.com/repos/git-for-windows/git/releases/latest" -Headers @{ "User-Agent" = "dive" }
    $want = if ($isArm) { "*-arm64.exe" } else { "*-64-bit.exe" }
    $asset = $rel.assets | Where-Object { $_.name -like "Git-*$($want.TrimStart('*'))" -and $_.name -notlike "*Portable*" } | Select-Object -First 1
    $exe = "$env:TEMP\git-setup.exe"
    Invoke-WebRequest $asset.browser_download_url -OutFile $exe -UseBasicParsing
    Start-Process $exe -ArgumentList "/VERYSILENT", "/NORESTART", "/NOCANCEL", "/SP-" -Wait
    Add-MachinePath "$env:ProgramFiles\Git\cmd"
    Say "git installed"
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
Write-Output "    cd C:\dev\dive; pnpm install; pnpm dev"
Write-Output ""
Write-Output "The macOS-only code is not ported yet -- see docs/WINDOWS.md."
