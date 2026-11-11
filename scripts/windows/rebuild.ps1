# rebuild.ps1 -- pull and rebuild the release binary in a prepared VM.
#
# Detached, so a release build outlives any `prlctl exec` session (which the
# VM allows only one of at a time):
#
#   schtasks /create /tn DiveRebuild /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\rebuild.ps1" /sc once /st 00:00 /ru SYSTEM /f
#   schtasks /run /tn DiveRebuild
#
# then poll C:\dev\logs\rebuild.log for DONE (FAILED appears before it when a
# step failed).
#
# The pull is fast-forward only and refuses to run over local changes in
# C:\dev\dive. -Reset discards them (fetch + git reset --hard origin/main).
# -Installer also builds the .exe installer. NSIS rather than WiX: WiX v3
# candle does not run on Windows-on-ARM, and `--bundles all` stops there
# before it reaches anything else.
param([switch] $Installer, [switch] $Reset)

$ProgressPreference = "SilentlyContinue"
$logDir = "C:\dev\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = "$logDir\rebuild.log"
Remove-Item $log -ErrorAction SilentlyContinue
function Say($m) { Add-Content $log "$(Get-Date -Format HH:mm:ss)  $m" }

# Every step goes through cmd with its own redirect rather than PowerShell's
# pipeline. Piping a native build tool into Add-Content took the whole script
# down mid-run once, with no error and no further output -- the log simply
# stopped after vite and cargo never started. A redirect cannot do that, and
# it keeps each step's exit code honest.
function Run($label, $command) {
  Say $label
  cmd /c "$command >> ""$log"" 2>&1"
  $code = $LASTEXITCODE
  Say "$label EXIT $code"
  if ($code -ne 0) { Say "FAILED"; Say "DONE"; exit $code }
}

foreach ($v in "Path","CARGO_HOME","RUSTUP_HOME","CEF_PATH") {
  Set-Item "env:$v" ([Environment]::GetEnvironmentVariable($v, "Machine"))
}
$repo = "C:\dev\dive"
Set-Location $repo
# The static C++ runtime flags CI sets, for this process only.
. "$repo\scripts\windows\msvc-runtime.ps1"
if ($Reset) {
  Run "pull (reset)" "git fetch --depth 1 origin main && git reset --hard origin/main"
} else {
  $dirty = git -C $repo status --porcelain
  if ($dirty) {
    Say "the checkout has local changes; commit them or pass -Reset to discard them"
    Say "FAILED"; Say "DONE"; exit 1
  }
  Run "pull" "git pull --ff-only origin main"
}
# Windows will not replace a binary that is still open.
Get-Process dive-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
Run "pnpm install" "pnpm install --frozen-lockfile"
# It has to be `tauri build`, not vite + `cargo build`. Building the crate
# directly skips the Tauri CLI, and the binary that comes out never loads the
# frontend: the chrome webview is created, nothing renders in it, no error is
# logged anywhere, and the window is simply black. `--no-bundle` stops before
# the installer, which is all that was worth avoiding here.
$bundle = if ($Installer) { "--bundles nsis" } else { "--no-bundle" }
Run "tauri build" "pnpm --filter @dive/desktop tauri build $bundle --config src-tauri/tauri.no-updater.conf.json"
Say "DONE"
