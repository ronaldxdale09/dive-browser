# rebuild.ps1 -- pull and rebuild the release binary in a prepared VM.
#
# Detached, so a release build outlives any `prlctl exec` session (which the
# VM allows only one of at a time):
#
#   schtasks /create /tn DiveRebuild /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\rebuild.ps1" /sc once /st 00:00 /ru SYSTEM /f
#   schtasks /run /tn DiveRebuild
#
# then poll C:\dive-rebuild.log for DONE.
$ProgressPreference = "SilentlyContinue"
$log = "C:\dive-rebuild.log"
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
Run "pull" "git fetch --depth 1 origin main && git reset --hard origin/main"
# Windows will not replace a binary that is still open.
Get-Process dive-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
Run "pnpm install" "pnpm install --frozen-lockfile"
# It has to be `tauri build`, not vite + `cargo build`. Building the crate
# directly skips the Tauri CLI, and the binary that comes out never loads the
# frontend: the chrome webview is created, nothing renders in it, no error is
# logged anywhere, and the window is simply black. `--no-bundle` stops before
# the installer, which is all that was worth avoiding here.
Run "tauri build" "pnpm --filter @dive/desktop tauri build --no-bundle --config src-tauri/tauri.no-updater.conf.json"
Say "DONE"
