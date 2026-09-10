# check-window-controls.ps1 -- does the chrome's own minimise button work?
#
# The chrome draws the window controls on Windows, and a Tauri window command
# the capability does not grant rejects silently -- which looks exactly like a
# button that does nothing. This clicks the real button and asks the window
# whether it minimised, so the answer is not a matter of opinion.
#
#   powershell -ExecutionPolicy Bypass -File check-window-controls.ps1
Add-Type @"
using System;using System.Runtime.InteropServices;
public class U {
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,IntPtr e);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
 public struct R { public int L,T,Rt,B; }
}
"@
$p = Get-Process dive-desktop -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output "no dive window"; exit }
$h = $p.MainWindowHandle
$r = New-Object U+R; [U]::GetWindowRect($h, [ref]$r) | Out-Null
Write-Output ("window {0},{1} {2}x{3}  minimized={4}" -f $r.L, $r.T, ($r.Rt-$r.L), ($r.B-$r.T), [U]::IsIconic($h))

# The controls are 46px wide each at the right edge: close, maximise, minimise.
$y = $r.T + 22
$minimise = $r.Rt - 115
Write-Output ("clicking minimise at {0},{1}" -f $minimise, $y)
[U]::SetCursorPos($minimise, $y) | Out-Null
Start-Sleep -Milliseconds 400
[U]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # left down
Start-Sleep -Milliseconds 80
[U]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # left up
Start-Sleep -Seconds 2
Write-Output ("after click: minimized={0}" -f [U]::IsIconic($h))
# put it back so the next screenshot shows something
[U]::ShowWindow($h, 9) | Out-Null
Start-Sleep -Seconds 1
Write-Output ("restored: minimized={0}" -f [U]::IsIconic($h))
