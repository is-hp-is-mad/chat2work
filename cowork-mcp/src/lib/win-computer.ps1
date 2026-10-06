# Computer-use backend for cowork-mcp on Windows.
#
# Runs as a persistent host: reads one JSON request per line from stdin,
# writes one JSON response followed by a framing marker. Keeping the process
# alive matters — the P/Invoke types are compiled once, so an action costs a
# few milliseconds instead of the ~300 ms a fresh PowerShell would.

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { [Console]::InputEncoding  = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class CU
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
    const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004, KEYEVENTF_EXTENDEDKEY = 0x0001;

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowTextW(IntPtr h, StringBuilder s, int max);
    [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr param);

    public delegate bool EnumProc(IntPtr h, IntPtr param);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public class Win { public long Handle; public string Title; public uint Pid; public int X, Y, W, H; public bool Foreground; }

    public static void DpiAware() { try { SetProcessDPIAware(); } catch {} }

    public static void Move(int x, int y) { SetCursorPos(x, y); }

    public static int[] Position() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }

    static void Send(INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }

    static INPUT Mouse(uint flags, uint data)
    {
        INPUT i = new INPUT();
        i.type = INPUT_MOUSE;
        i.u.mi.dwFlags = flags;
        i.u.mi.mouseData = data;
        return i;
    }

    public static void MouseDown(string button)
    {
        uint f = button == "right" ? MOUSEEVENTF_RIGHTDOWN : button == "middle" ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN;
        Send(new INPUT[] { Mouse(f, 0) });
    }

    public static void MouseUp(string button)
    {
        uint f = button == "right" ? MOUSEEVENTF_RIGHTUP : button == "middle" ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP;
        Send(new INPUT[] { Mouse(f, 0) });
    }

    /// <summary>Positive dy scrolls up; positive dx scrolls right. One unit = one notch.</summary>
    public static void Wheel(int dx, int dy)
    {
        List<INPUT> list = new List<INPUT>();
        if (dy != 0) list.Add(Mouse(MOUSEEVENTF_WHEEL, unchecked((uint)(dy * 120))));
        if (dx != 0) list.Add(Mouse(MOUSEEVENTF_HWHEEL, unchecked((uint)(dx * 120))));
        if (list.Count > 0) Send(list.ToArray());
    }

    static INPUT Key(ushort vk, bool up, bool extended)
    {
        INPUT i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = vk;
        i.u.ki.dwFlags = (up ? KEYEVENTF_KEYUP : 0) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
        return i;
    }

    public static void KeyDown(int vk, bool extended) { Send(new INPUT[] { Key((ushort)vk, false, extended) }); }
    public static void KeyUp(int vk, bool extended) { Send(new INPUT[] { Key((ushort)vk, true, extended) }); }

    /// <summary>Press a chord: modifiers down in order, key, then release in reverse.</summary>
    public static void Chord(int[] vks, bool[] extended)
    {
        List<INPUT> list = new List<INPUT>();
        for (int i = 0; i < vks.Length; i++) list.Add(Key((ushort)vks[i], false, extended[i]));
        for (int i = vks.Length - 1; i >= 0; i--) list.Add(Key((ushort)vks[i], true, extended[i]));
        Send(list.ToArray());
    }

    /// <summary>Type literal text as Unicode, so it is layout- and language-independent.</summary>
    public static void TypeText(string text)
    {
        List<INPUT> list = new List<INPUT>();
        foreach (char c in text)
        {
            if (c == '\n' || c == '\r')
            {
                if (c == '\r') continue;
                list.Add(Key(0x0D, false, false));
                list.Add(Key(0x0D, true, false));
                continue;
            }
            INPUT d = new INPUT();
            d.type = INPUT_KEYBOARD;
            d.u.ki.wScan = c;
            d.u.ki.dwFlags = KEYEVENTF_UNICODE;
            INPUT u = d;
            u.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            list.Add(d);
            list.Add(u);
            // Flush periodically; a single SendInput call has a practical size limit.
            if (list.Count >= 200) { Send(list.ToArray()); list.Clear(); }
        }
        if (list.Count > 0) Send(list.ToArray());
    }

    public static List<Win> Windows()
    {
        List<Win> found = new List<Win>();
        IntPtr fg = GetForegroundWindow();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLengthW(h);
            if (len == 0) return true;
            StringBuilder sb = new StringBuilder(len + 1);
            GetWindowTextW(h, sb, sb.Capacity);
            RECT r;
            GetWindowRect(h, out r);
            if (r.Right - r.Left <= 0 || r.Bottom - r.Top <= 0) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            Win w = new Win();
            w.Handle = h.ToInt64(); w.Title = sb.ToString(); w.Pid = pid;
            w.X = r.Left; w.Y = r.Top; w.W = r.Right - r.Left; w.H = r.Bottom - r.Top;
            w.Foreground = (h == fg);
            found.Add(w);
            return true;
        }, IntPtr.Zero);
        return found;
    }

    public static bool Focus(long handle)
    {
        IntPtr h = new IntPtr(handle);
        ShowWindow(h, 9); // SW_RESTORE
        return SetForegroundWindow(h);
    }
}
'@

[CU]::DpiAware()

function Get-Displays {
    $list = @()
    $i = 0
    foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
        $list += [pscustomobject]@{
            id = $i; primary = $s.Primary; name = $s.DeviceName
            x = $s.Bounds.X; y = $s.Bounds.Y
            width = $s.Bounds.Width; height = $s.Bounds.Height
        }
        $i++
    }
    return $list
}

function Save-Screenshot {
    param($X, $Y, $W, $H, $MaxDim, $Path, $Quality)

    # ConvertFrom-Json yields Int64, which makes PowerShell pick the wrong
    # Bitmap/Graphics overloads. Pin everything to Int32 up front.
    $X = [int]$X; $Y = [int]$Y; $W = [int]$W; $H = [int]$H
    $MaxDim = [int]$MaxDim; $Quality = [int]$Quality
    if ($W -le 0 -or $H -le 0) { throw "invalid capture size ${W}x${H}" }

    $bmp = New-Object System.Drawing.Bitmap($W, $H)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)))
    $g.Dispose()

    $scale = 1.0
    $out = $bmp
    if ($MaxDim -gt 0 -and ([Math]::Max($W, $H) -gt $MaxDim)) {
        $scale = $MaxDim / [Math]::Max($W, $H)
        $nw = [int][Math]::Round($W * $scale)
        $nh = [int][Math]::Round($H * $scale)
        $resized = New-Object System.Drawing.Bitmap($nw, $nh)
        $rg = [System.Drawing.Graphics]::FromImage($resized)
        $rg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $rg.DrawImage($bmp, 0, 0, $nw, $nh)
        $rg.Dispose()
        $bmp.Dispose()
        $out = $resized
    }

    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
    $out.Save($Path, $codec, $params)

    $result = [pscustomobject]@{
        path = $Path; width = $out.Width; height = $out.Height
        sourceWidth = $W; sourceHeight = $H; originX = $X; originY = $Y; scale = $scale
    }
    $out.Dispose()
    return $result
}

function Invoke-Action {
    param($req)
    switch ($req.action) {
        'ping'            { return @{ ok = $true } }
        'displays'        { return @{ displays = @(Get-Displays) } }
        'cursor_position' { $p = [CU]::Position(); return @{ x = $p[0]; y = $p[1] } }
        'move'            { [CU]::Move([int]$req.x, [int]$req.y); return @{} }
        'mouse_down'      { [CU]::MouseDown([string]$req.button); return @{} }
        'mouse_up'        { [CU]::MouseUp([string]$req.button); return @{} }
        'wheel'           { [CU]::Wheel([int]$req.dx, [int]$req.dy); return @{} }
        'key_down'        { [CU]::KeyDown([int]$req.vk, [bool]$req.extended); return @{} }
        'key_up'          { [CU]::KeyUp([int]$req.vk, [bool]$req.extended); return @{} }
        'chord'           {
            $vks = @(); foreach ($v in $req.vks) { $vks += [int]$v }
            $ext = @(); foreach ($e in $req.extended) { $ext += [bool]$e }
            [CU]::Chord($vks, $ext); return @{}
        }
        'type'            { [CU]::TypeText([string]$req.text); return @{} }
        'screenshot'      {
            return @{ shot = (Save-Screenshot -X $req.x -Y $req.y -W $req.width -H $req.height -MaxDim $req.maxDim -Path $req.path -Quality $req.quality) }
        }
        'read_clipboard'  { $t = Get-Clipboard -Raw -ErrorAction SilentlyContinue; return @{ text = [string]$t } }
        'write_clipboard' { Set-Clipboard -Value ([string]$req.text); return @{} }
        'windows'         { return @{ windows = @([CU]::Windows()) } }
        'focus'           { return @{ focused = [CU]::Focus([long]$req.handle) } }
        'launch'          {
            $args = @{ FilePath = [string]$req.program }
            if ($req.args -and $req.args.Count -gt 0) { $args['ArgumentList'] = @($req.args) }
            $p = Start-Process @args -PassThru
            return @{ pid = $p.Id }
        }
        default           { throw "unknown action: $($req.action)" }
    }
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
        $req = $line | ConvertFrom-Json
        if ($req.action -eq 'exit') { break }
        $res = Invoke-Action $req
        $payload = @{ ok = $true; result = $res }
    } catch {
        $payload = @{ ok = $false; error = "$($_.Exception.Message)" }
    }
    $json = $payload | ConvertTo-Json -Depth 8 -Compress
    [Console]::Out.Write($json + "`n<<<COWORK_END>>>`n")
    [Console]::Out.Flush()
}
