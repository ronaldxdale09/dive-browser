# rebuild.ps1 -- pull and rebuild the release binary in a prepared VM.
#
# Detached, because a release build outlives any `prlctl exec` session:
#   Start-Process powershell -ArgumentList "-File","C:\rebuild.ps1" -WindowStyle Hidden
# then poll C:\dive-rebuild.log for DONE.
$ProgressPreference = "SilentlyContinue"
$log = "C:\dive-rebuild.log"
Remove-Item $log -ErrorAction SilentlyContinue
function Say($m) { Add-Content $log "$(Get-Date -Format HH:mm:ss)  $m" }

foreach ($v in "Path","CARGO_HOME","RUSTUP_HOME","CEF_PATH") {
  Set-Item "env:$v" ([Environment]::GetEnvironmentVariable($v, "Machine"))
}
$repo = "C:\dev\dive"
Set-Location $repo
Say "pulling"
git fetch --depth 1 origin main 2>&1 | Add-Content $log
git reset --hard origin/main 2>&1 | Add-Content $log
# Windows will not replace a binary that is still open.
Get-Process dive-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
Say "pnpm install"
pnpm install --frozen-lockfile 2>&1 | Add-Content $log
Say "pnpm build (web assets)"
pnpm --filter @dive/desktop build 2>&1 | Add-Content $log
Say "cargo build --release"
cargo build --release -p dive-desktop --message-format short 2>&1 | Add-Content $log
Say "EXITCODE $LASTEXITCODE"
Say "DONE"
