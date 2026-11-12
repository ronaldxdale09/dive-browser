# first-build.ps1 -- clone (or update) the repo in a prepared Windows VM and
# take a compile pass, writing everything to C:\dev\logs\first-build.log.
#
# Run it after bootstrap.ps1, detached, so no `prlctl exec` session has to
# stay open for the length of a CEF download. Copy this file into the VM (for
# example to C:\dev\first-build.ps1), then either run it as a task that
# belongs to the developer, never SYSTEM (the script must live under C:\dev,
# whose ACL bootstrap.ps1 restricts; /it needs the developer logged on):
#
#   schtasks /create /tn DiveFirstBuild /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\dev\first-build.ps1" /sc once /st 00:00 /ru <DOMAIN\user> /it /f
#   schtasks /run /tn DiveFirstBuild
#
# or, from the developer's own shell:
#
#   Start-Process powershell -ArgumentList "-NoProfile","-ExecutionPolicy","Bypass","-File","C:\dev\first-build.ps1" -WindowStyle Hidden
#
# then poll the log for DONE (and FAILED on a failed step).
$ProgressPreference = "SilentlyContinue"
$logDir = "C:\dev\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = "$logDir\first-build.log"
Remove-Item $log -ErrorAction SilentlyContinue
function Say($m) { Add-Content $log "$(Get-Date -Format HH:mm:ss)  $m" }

# Every step goes through cmd with its own redirect rather than PowerShell's
# pipeline. Piping a native build tool into Add-Content can take the whole
# script down mid-run with no error, and it hides the exit code. A redirect
# cannot do that, and it keeps each step's exit code honest.
function Run($label, $command) {
  Say $label
  cmd /c "$command >> ""$log"" 2>&1"
  $code = $LASTEXITCODE
  Say "$label EXIT $code"
  if ($code -ne 0) { Say "FAILED"; Say "DONE"; exit $code }
}

# Machine env was set by the bootstrap; this process started before that.
foreach ($v in "Path","CARGO_HOME","RUSTUP_HOME","CEF_PATH") {
  Set-Item "env:$v" ([Environment]::GetEnvironmentVariable($v, "Machine"))
}
$repo = "C:\dev\dive"
if (-not (Test-Path $repo)) {
  Run "clone" "git clone --depth 1 https://github.com/ronaldxdale09/dive-browser.git $repo"
} else {
  Run "pull" "git -C $repo pull --ff-only"
}
Set-Location $repo
# The static C++ runtime flags CI sets, for this process only. Taken from the
# checkout, so it is there even when this script was copied elsewhere.
. "$repo\scripts\windows\msvc-runtime.ps1"
# Windows will not replace a binary that is still open, so a build after a
# test run fails on "failed to remove file dive-desktop.exe" rather than on
# anything to do with the code.
Get-Process dive-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
Run "pnpm install" "pnpm install --frozen-lockfile"
Say "CEF is downloaded by this build (several hundred MB, about 1 GB unpacked) and the C++ wrapper is built -- slow"
# check, not build: we want the error list, and linking is not needed for it.
Run "cargo check" "cargo check -p dive-desktop --message-format short"
Say "DONE"
