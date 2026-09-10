# show-suggestions.ps1 -- put the address bar suggestions on screen.
#
# The suggestion list is a chrome overlay drawn over a page that keeps
# rendering, which on Windows means the chrome webview has to be raised over
# the page webview and masked. Whether that worked is a question about
# pixels, so this only stages the shot: focus Dive, type into the address
# bar, and leave the list open for a screenshot from the host.
#
#   powershell -ExecutionPolicy Bypass -File show-suggestions.ps1
Add-Type @"
using System;using System.Runtime.InteropServices;
public class W {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,IntPtr e);
 public struct R { public int L,T,Rt,B; }
}
"@
$p = Get-Process dive-desktop -ErrorAction SilentlyContinue |
     Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output "no dive window"; exit 1 }
$h = $p.MainWindowHandle
[W]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 600

$r = New-Object W+R; [W]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Output ("window {0},{1} {2}x{3}" -f $r.L,$r.T,($r.Rt-$r.L),($r.B-$r.T))

$shell = New-Object -ComObject WScript.Shell
# A live page underneath is the whole point: the list has to float over
# content that keeps rendering, not over the welcome screen.
$shell.SendKeys("^t")
Start-Sleep -Seconds 2
$shell.SendKeys("example.com{ENTER}")
Start-Sleep -Seconds 6

# Back to the address bar, and type enough to bring the list up.
$shell.SendKeys("^l")
Start-Sleep -Milliseconds 800
$shell.SendKeys("goo")
Start-Sleep -Seconds 2
Write-Output "page loaded and suggestions opened"
