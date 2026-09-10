# bootstrap.ps1 -- everything Dive needs to build on a fresh Windows machine.
#
#   Run in an ADMIN PowerShell:
#     Set-ExecutionPolicy -Scope Process Bypass -Force
#     .\bootstrap.ps1
#
# Installs the MSVC C++ toolchain, Rust, Node, pnpm, CMake and Ninja, then
# clones the repo and does the first build. CEF (~500 MB) is downloaded by the
# build itself into CEF_PATH, the same as on macOS.
#
# Written for Windows 11 on ARM (a Parallels VM on an Apple Silicon Mac) and
# for x64; the architecture is detected rather than assumed.
$ErrorActionPreference = "Stop"

function Step($msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Need($cmd) { $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }

$arch = $env:PROCESSOR_ARCHITECTURE
$isArm = $arch -eq "ARM64"
Step "Windows $arch detected"
if (-not (Need winget)) {
    throw "winget is missing. Install 'App Installer' from the Microsoft Store, then run this again."
}

Step "Visual Studio Build Tools (MSVC + Windows SDK)"
# The C++ workload is what cef-dll-sys and aws-lc-sys need; without it the
# build fails deep inside a C compile with no obvious cause. On ARM both the
# ARM64 and x64 tools are installed, because some build scripts still shell
# out to x64 helpers.
$vsComponents = @(
    "Microsoft.VisualStudio.Workload.VCTools"
    "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
    "Microsoft.VisualStudio.Component.Windows11SDK.22621"
)
if ($isArm) { $vsComponents += "Microsoft.VisualStudio.Component.VC.Tools.ARM64" }
$addArgs = ($vsComponents | ForEach-Object { "--add $_" }) -join " "
winget install --id Microsoft.VisualStudio.2022.BuildTools --accept-package-agreements --accept-source-agreements `
    --override "--quiet --wait --norestart $addArgs --includeRecommended"

Step "Git, Node, CMake, Ninja"
foreach ($id in @("Git.Git", "OpenJS.NodeJS", "Kitware.CMake", "Ninja-build.Ninja")) {
    winget install --id $id --accept-package-agreements --accept-source-agreements --silent
}

Step "Rust"
if (-not (Need rustup)) {
    $rustup = if ($isArm) { "https://static.rust-lang.org/rustup/dist/aarch64-pc-windows-msvc/rustup-init.exe" }
              else { "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe" }
    Invoke-WebRequest $rustup -OutFile "$env:TEMP\rustup-init.exe"
    & "$env:TEMP\rustup-init.exe" -y --default-toolchain stable
    $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
}
rustup target add $(if ($isArm) { "aarch64-pc-windows-msvc" } else { "x86_64-pc-windows-msvc" })

Step "pnpm"
corepack enable
corepack prepare pnpm@latest --activate

Step "CEF_PATH"
# Persisted, not just set for this shell: every later build and every new
# terminal needs it, and a missing CEF_PATH fails late and confusingly.
$cefPath = "$env:LOCALAPPDATA\dive\cef"
New-Item -ItemType Directory -Force -Path $cefPath | Out-Null
[Environment]::SetEnvironmentVariable("CEF_PATH", $cefPath, "User")
$env:CEF_PATH = $cefPath
Write-Host "CEF_PATH = $cefPath"

Step "clone"
$repo = "$env:USERPROFILE\dive-browser"
if (-not (Test-Path $repo)) {
    git clone https://github.com/ronaldxdale09/dive-browser.git $repo
}
Set-Location $repo
git pull --ff-only

Step "install dependencies"
pnpm install --frozen-lockfile

Write-Host "`nReady." -ForegroundColor Green
Write-Host "Open a NEW terminal (so PATH and CEF_PATH are picked up), then:"
Write-Host "    cd $repo"
Write-Host "    pnpm dev            # first run downloads CEF, ~500 MB"
Write-Host ""
Write-Host "Expect compile errors the first time: the macOS-only code has not been"
Write-Host "ported yet. See docs/WINDOWS.md for the list and the order to do it in."
