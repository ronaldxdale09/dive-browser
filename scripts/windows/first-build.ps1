# first-build.ps1 -- clone (or update) the repo in a prepared Windows VM and
# take a compile pass, writing everything to C:\dive-build.log.
#
# Run it after bootstrap.ps1, detached, so no `prlctl exec` session has to
# stay open for the length of a CEF download:
#
#   Start-Process powershell -ArgumentList "-File","C:\dive-build.ps1" -WindowStyle Hidden
#
$ProgressPreference = "SilentlyContinue"
$log = "C:\dive-build.log"
Remove-Item $log -ErrorAction SilentlyContinue
function Say($m) { Add-Content $log "$(Get-Date -Format HH:mm:ss)  $m" }

# Machine env was set by the bootstrap; this process started before that.
foreach ($v in "Path","CARGO_HOME","RUSTUP_HOME","CEF_PATH") {
  Set-Item "env:$v" ([Environment]::GetEnvironmentVariable($v, "Machine"))
}
$repo = "C:\dev\dive"
if (-not (Test-Path $repo)) {
  Say "cloning"
  git clone --depth 1 https://github.com/ronaldxdale09/dive-browser.git $repo 2>&1 | Add-Content $log
} else {
  Say "pulling"
  git -C $repo pull --ff-only 2>&1 | Add-Content $log
}
Set-Location $repo
# Windows will not replace a binary that is still open, so a build after a
# test run fails on "failed to remove file dive-desktop.exe" rather than on
# anything to do with the code.
Get-Process dive-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
Say "pnpm install"
pnpm install --frozen-lockfile 2>&1 | Add-Content $log
Say "cargo check (downloads CEF ~1GB, builds the C++ wrapper -- slow)"
# check, not build: we want the error list, and linking is not needed for it.
cargo check -p dive-desktop --message-format short 2>&1 | Add-Content $log
Say "EXITCODE $LASTEXITCODE"
Say "DONE"
