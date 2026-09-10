Add-Type @"
using System;using System.Runtime.InteropServices;
public class K {
 [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,IntPtr e);
}
"@
Write-Output ("idle: LBUTTON={0} ESC={1}" -f [K]::GetAsyncKeyState(0x01), [K]::GetAsyncKeyState(0x1B))
[K]::mouse_event(0x0002,0,0,0,[IntPtr]::Zero)
$seen = [K]::GetAsyncKeyState(0x01)
[K]::mouse_event(0x0004,0,0,0,[IntPtr]::Zero)
Write-Output ("while synthetic button held: {0} (negative means the high bit is set)" -f $seen)
Write-Output ("after release: {0}" -f [K]::GetAsyncKeyState(0x01))
