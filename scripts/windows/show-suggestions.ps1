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

# The address bar runs across the middle of the toolbar strip.
$x = [int](($r.L + $r.Rt) / 2)
$y = $r.T + 46
[W]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 200
[W]::mouse_event(0x0002,0,0,0,[IntPtr]::Zero)
[W]::mouse_event(0x0004,0,0,0,[IntPtr]::Zero)
Start-Sleep -Milliseconds 600

$shell = New-Object -ComObject WScript.Shell
$shell.SendKeys("goo")
Start-Sleep -Seconds 2
Write-Output "typed; suggestions should be open"
