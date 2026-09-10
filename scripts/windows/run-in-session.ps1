# run-in-session.ps1 -- run a script on the interactive desktop, from session 0.
#
# `prlctl exec` lands in session 0 as SYSTEM, which is a different window
# station: it can see Dive's processes but every MainWindowHandle reads 0, and
# anything it launches is invisible. Window-level checks have to run where the
# windows actually are. This hands the script to the Task Scheduler as the
# logged-on user, waits for it, and prints what it wrote.
#
#   powershell -ExecutionPolicy Bypass -File run-in-session.ps1 -Script C:\check.ps1
param(
  [Parameter(Mandatory = $true)][string] $Script,
  [string] $Out = "",
  [int] $TimeoutSeconds = 120
)

$user = (Get-CimInstance Win32_ComputerSystem).UserName
$name = "DiveSessionRun"
# The logged-on user is not elevated, so the task cannot write to C:\ root --
# it just exits 1 and leaves no output. Land in that user's own temp instead.
if (-not $Out) {
  # Not $home: that one is read-only, and assigning to it fails without
  # stopping the script, so the path silently stays SYSTEM's own profile.
  $profileDir = "C:\Users\" + $user.Split("\")[-1]
  $Out = Join-Path $profileDir "AppData\Local\Temp\dive-session-out.txt"
}
Remove-Item $Out -ErrorAction SilentlyContinue

# schtasks /tr mangles nested quotes, so the redirect lives in a .cmd wrapper.
$wrapper = Join-Path (Split-Path $Out) "dive-session-run.cmd"
$cmd = '@echo off' + "`r`n" + 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $Script + '" > "' + $Out + '" 2>&1'
Set-Content $wrapper $cmd -Encoding ASCII
schtasks /create /tn $name /tr $wrapper /sc once /st 00:00 /ru $user /it /f | Out-Null
schtasks /run /tn $name | Out-Null

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $state = (schtasks /query /tn $name /fo list | Select-String "^Status:").ToString()
  if ($state -notmatch "Running") { break }
}
schtasks /delete /tn $name /f | Out-Null

if (Test-Path $Out) { Get-Content $Out } else { Write-Output "no output from $Script" }
