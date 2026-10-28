# dsh-web-tabs native window helper (Windows / PowerShell 5.1+)
# JSON-lines protocol on stdin/stdout. One command per line, one reply per line.
#
#   {"op":"ping"}
#   {"op":"snap"}                                  -> [hwnd,...]  (visible app windows, for diffing)
#   {"op":"findhost","pid":123}                    -> main window of a process
#   {"op":"client","hwnd":123}                     -> client area origin + size (screen px)
#   {"op":"adopt","hwnd":C,"owner":P,"x":..,"y":..,"w":..,"h":..}
#   {"op":"follow","hwnd":C,"x":..,"y":..,"w":..,"h":..}   (x/y relative to owner client origin)
#   {"op":"show","hwnd":C} {"op":"hide","hwnd":C}
#   {"op":"detach","hwnd":C} {"op":"close","hwnd":C}
#   {"op":"info","hwnd":C}
#   {"op":"content","hwnd":C}                       -> web content rect + caption height (UIA)
#   {"op":"foreground","hwnd":W}                    -> bring a top-level window to the front
#   {"op":"keys","hwnd":C,"keys":"^r"}              -> focus child, then SendKeys the chord
Add-Type -AssemblyName System.Windows.Forms | Out-Null
# Window titles contain CJK text (e.g. the Claude tab). PowerShell 5.1 writes
# Console.Out in the OEM code page (936/GBK on zh-CN), so Node reading the pipe
# as UTF-8 sees mojibake. Pin both directions to BOM-less UTF-8.
# NOTE: keep this whole file ASCII-only -- PS 5.1 parses a BOM-less script as
# the OEM code page, and non-ASCII bytes here can break the parser.
try {
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [Console]::OutputEncoding = $utf8
  [Console]::InputEncoding = $utf8
} catch { }
$uiaReady = $false
try {
  Add-Type -AssemblyName UIAutomationClient | Out-Null
  Add-Type -AssemblyName UIAutomationTypes | Out-Null
  $uiaReady = $true
} catch { $uiaReady = $false }

$src = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class DshWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int idx, IntPtr val);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint to, bool on);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("user32.dll")] public static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);

  public const int GWL_STYLE = -16;
  public const int GWL_EXSTYLE = -20;
  public const long WS_CHILD = 0x40000000L;
  public const long WS_POPUP = 0x80000000L;
  public const long WS_CAPTION = 0x00C00000L;
  public const long WS_THICKFRAME = 0x00080000L;
  public const long WS_SYSMENU = 0x00080000L;      // overlap-free value used below
  public const long WS_MINIMIZEBOX = 0x00020000L;
  public const long WS_MAXIMIZEBOX = 0x00010000L;
  public const long WS_VISIBLE = 0x10000000L;
  public const long WS_CLIPCHILDREN = 0x02000000L;
  public const long WS_CLIPSIBLINGS = 0x04000000L;
  public const long WS_EX_APPWINDOW = 0x00040000L;
  public const long WS_EX_TOOLWINDOW = 0x00000080L;
  public const long WS_EX_NOACTIVATE = 0x08000000L;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_FRAMECHANGED = 0x0020;
  public const uint SWP_SHOWWINDOW = 0x0040;
  public const uint SWP_HIDEWINDOW = 0x0080;
  public const int SW_SHOW = 5;
  public const int SW_HIDE = 0;
  public const uint WM_CLOSE = 0x0010;

  static string Esc(string s) {
    if (s == null) return "";
    StringBuilder b = new StringBuilder();
    foreach (char c in s) {
      if (c == '"') b.Append("\\\"");
      else if (c == '\\') b.Append("\\\\");
      else if (c == '\n') b.Append("\\n");
      else if (c == '\r') b.Append("\\r");
      else if (c == '\t') b.Append("\\t");
      else if (c < ' ') b.Append(' ');
      else b.Append(c);
    }
    return b.ToString();
  }

  public static string Describe(IntPtr h) {
    RECT r; if (!GetWindowRect(h, out r)) { r.Left = r.Top = r.Right = r.Bottom = 0; }
    StringBuilder cs = new StringBuilder(256); GetClassName(h, cs, 256);
    StringBuilder ts = new StringBuilder(1024); GetWindowText(h, ts, 1024);
    uint pid; GetWindowThreadProcessId(h, out pid);
    long s = GetWindowLongPtr(h, GWL_STYLE).ToInt64();
    uint dpi = 96;
    try { uint d = GetDpiForWindow(h); if (d >= 48 && d <= 480) dpi = d; } catch { }
    return "{\"hwnd\":" + h.ToInt64() + ",\"pid\":" + pid + ",\"cls\":\"" + Esc(cs.ToString()) + "\",\"title\":\"" + Esc(ts.ToString()) +
      "\",\"x\":" + r.Left + ",\"y\":" + r.Top + ",\"w\":" + (r.Right - r.Left) + ",\"h\":" + (r.Bottom - r.Top) +
      ",\"visible\":" + (IsWindowVisible(h) ? "true" : "false") + ",\"style\":" + s + ",\"parent\":" + GetParent(h).ToInt64() + ",\"dpi\":" + dpi + "}";
  }

  static bool IsAppWindow(IntPtr h) {
    if (!IsWindowVisible(h)) return false;
    RECT r; if (!GetWindowRect(h, out r)) return false;
    if (r.Right - r.Left < 120 || r.Bottom - r.Top < 80) return false;
    StringBuilder cs = new StringBuilder(256); GetClassName(h, cs, 256);
    StringBuilder ts = new StringBuilder(1024); GetWindowText(h, ts, 1024);
    if (ts.Length == 0) return false;
    return true;
  }

  public static string Snap() {
    List<string> ids = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (IsAppWindow(h)) ids.Add(h.ToInt64().ToString());
      return true;
    }, IntPtr.Zero);
    return "[" + String.Join(",", ids.ToArray()) + "]";
  }

  public static string List() {
    List<string> rows = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (IsAppWindow(h)) rows.Add(Describe(h));
      return true;
    }, IntPtr.Zero);
    return "[" + String.Join(",", rows.ToArray()) + "]";
  }

  public static string FindHost(uint pid) {
    long best = 0; long bestArea = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      if (!IsWindowVisible(h)) return true;
      StringBuilder cs = new StringBuilder(256); GetClassName(h, cs, 256);
      if (cs.ToString() != "Chrome_WidgetWin_1") return true;
      StringBuilder ts = new StringBuilder(1024); GetWindowText(h, ts, 1024);
      if (ts.Length == 0) return true;
      RECT r; GetWindowRect(h, out r);
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > bestArea) { bestArea = area; best = h.ToInt64(); }
      return true;
    }, IntPtr.Zero);
    return "{\"hwnd\":" + best + "}";
  }

  public static string Client(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return "{\"ok\":false,\"reason\":\"gone\"}";
    POINT p = new POINT(); p.X = 0; p.Y = 0;
    ClientToScreen(h, ref p);
    RECT c; GetClientRect(h, out c);
    return "{\"ok\":true,\"x\":" + p.X + ",\"y\":" + p.Y + ",\"w\":" + (c.Right - c.Left) + ",\"h\":" + (c.Bottom - c.Top) + "}";
  }

  // Turn a top-level Chromium window into a frameless child of `owner`, placed at
  // (x,y) relative to the owner's client origin.
  public static string Adopt(long hwnd, long owner, int x, int y, int w, int h) {
    IntPtr c = new IntPtr(hwnd), p = new IntPtr(owner);
    if (!IsWindow(c)) return "{\"ok\":false,\"reason\":\"child-gone\"}";
    if (!IsWindow(p)) return "{\"ok\":false,\"reason\":\"owner-gone\"}";

    IntPtr prev = SetParent(c, p);

    long s = GetWindowLongPtr(c, GWL_STYLE).ToInt64();
    s &= ~WS_POPUP;
    s &= ~WS_CAPTION;
    s &= ~WS_THICKFRAME;
    s &= ~WS_MINIMIZEBOX;
    s &= ~WS_MAXIMIZEBOX;
    s |= WS_CHILD;
    s |= WS_VISIBLE;
    s |= WS_CLIPCHILDREN;
    s |= WS_CLIPSIBLINGS;
    SetWindowLongPtr(c, GWL_STYLE, new IntPtr(s));

    long e = GetWindowLongPtr(c, GWL_EXSTYLE).ToInt64();
    e &= ~WS_EX_APPWINDOW;
    e |= WS_EX_TOOLWINDOW;
    SetWindowLongPtr(c, GWL_EXSTYLE, new IntPtr(e));

    // After SetParent, child coordinates are relative to the parent's client
    // area, so x/y go through unchanged (adding ClientToScreen here double
    // counted the owner origin - bug in the first probe).
    SetWindowPos(c, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    MoveWindow(c, x, y, w, h, true);
    ShowWindow(c, SW_SHOW);

    return "{\"ok\":true,\"prev\":" + prev.ToInt64() + ",\"parent\":" + GetParent(c).ToInt64() + ",\"info\":" + Describe(c) + "}";
  }

  // Reposition (and show/hide) without touching styles. Cheap enough to call at ~60ms.
  public static string Follow(long hwnd, long owner, int x, int y, int w, int h, bool visible) {
    IntPtr c = new IntPtr(hwnd);
    if (!IsWindow(c)) return "{\"ok\":false,\"reason\":\"gone\"}";
    if (!visible) {
      if (IsWindowVisible(c)) ShowWindow(c, SW_HIDE);
      return "{\"ok\":true,\"visible\":false}";
    }
    IntPtr p = new IntPtr(owner);
    if (!IsWindow(p)) return "{\"ok\":false,\"reason\":\"owner-gone\",\"visible\":true}";
    // Compare in screen space (GetWindowRect), move in parent-client space.
    POINT o = new POINT(); ClientToScreen(p, ref o);
    RECT r;
    bool moved = true;
    if (GetWindowRect(c, out r)) {
      moved = (r.Left != o.X + x || r.Top != o.Y + y || (r.Right - r.Left) != w || (r.Bottom - r.Top) != h);
    }
    if (!IsWindowVisible(c)) {
      SetWindowPos(c, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
      return "{\"ok\":true,\"visible\":true,\"moved\":true,\"shown\":true}";
    }
    if (moved) {
      SetWindowPos(c, IntPtr.Zero, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
      MoveWindow(c, x, y, w, h, true);
      return "{\"ok\":true,\"visible\":true,\"moved\":true}";
    }
    return "{\"ok\":true,\"visible\":true,\"moved\":false}";
  }

  // Chromium keeps painting its own titlebar even as a WS_CHILD window. Rather
  // than fight the frame layout, clip it off with a window region: the caller
  // positions the window `clipTop` pixels above the target and adds the same
  // amount to the height, so the web content lands exactly on the target rect.
  public static string Clip(long hwnd, int left, int top, int right, int bottom) {
    IntPtr c = new IntPtr(hwnd);
    if (!IsWindow(c)) return "{\"ok\":false,\"reason\":\"gone\"}";
    IntPtr rgn = CreateRectRgn(left, top, right, bottom);
    if (rgn == IntPtr.Zero) return "{\"ok\":false,\"reason\":\"region\"}";
    int mode = SetWindowRgn(c, rgn, true);
    // SetWindowRgn takes ownership of the region on success; only delete on failure.
    if (mode == 0) DeleteObject(rgn);
    return "{\"ok\":" + (mode != 0 ? "true" : "false") + "}";
  }

  public static string Detach(long hwnd) {
    IntPtr c = new IntPtr(hwnd);
    if (!IsWindow(c)) return "{\"ok\":true,\"already\":true}";
    SetParent(c, IntPtr.Zero);
    long s = GetWindowLongPtr(c, GWL_STYLE).ToInt64();
    s &= ~WS_CHILD;
    s |= WS_CAPTION;
    s |= WS_THICKFRAME;
    SetWindowLongPtr(c, GWL_STYLE, new IntPtr(s));
    return "{\"ok\":true}";
  }

  public static string Close(long hwnd) {
    IntPtr c = new IntPtr(hwnd);
    if (!IsWindow(c)) return "{\"ok\":true,\"already\":true}";
    PostMessage(c, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    return "{\"ok\":true}";
  }

  public static string Focus(long hwnd) {
    IntPtr c = new IntPtr(hwnd);
    if (!IsWindow(c)) return "{\"ok\":false,\"reason\":\"gone\"}";
    // SetFocus only works when the calling thread owns the foreground input
    // queue, so borrow it from whoever owns the foreground right now. Without
    // this a background helper silently does nothing.
    IntPtr fg = GetForegroundWindow();
    uint fgPid; uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
    uint self = GetCurrentThreadId();
    bool attached = fgThread != 0 && fgThread != self && AttachThreadInput(self, fgThread, true);
    try {
      SetForegroundWindow(new IntPtr(hwnd));
      SetFocus(c);
    } finally {
      if (attached) AttachThreadInput(self, fgThread, false);
    }
    return "{\"ok\":true}";
  }

  public static string Foreground(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (!IsWindow(h)) return "{\"ok\":false,\"reason\":\"gone\"}";
    bool raised = SetForegroundWindow(h);
    return "{\"ok\":true,\"raised\":" + (raised ? "true" : "false") + "}";
  }
}
'@
Add-Type -TypeDefinition $src -ReferencedAssemblies System.Windows.Forms, System.Drawing | Out-Null

function Reply([string]$json) {
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

Reply '{"ok":true,"ready":true}'

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }
  try {
    $cmd = $line | ConvertFrom-Json
  } catch {
    Reply '{"ok":false,"reason":"bad-json"}'
    continue
  }
  try {
    switch ($cmd.op) {
      "ping"     { Reply '{"ok":true,"pong":true}' }
      "list"     { Reply ('{"ok":true,"windows":' + [DshWin]::List() + '}') }
      "snap"     { Reply ('{"ok":true,"windows":' + [DshWin]::Snap() + '}') }
      "findhost" { $r = [DshWin]::FindHost([uint32]$cmd.pid); Reply ($r -replace '^\{', '{"ok":true,') }
      "client"   { Reply ([DshWin]::Client([int64]$cmd.hwnd)) }
      "info"     { Reply ('{"ok":true,"info":' + [DshWin]::Describe([IntPtr][int64]$cmd.hwnd) + '}') }
      "adopt"    { Reply ([DshWin]::Adopt([int64]$cmd.hwnd, [int64]$cmd.owner, [int]$cmd.x, [int]$cmd.y, [int]$cmd.w, [int]$cmd.h)) }
      "follow"   {
                   $vis = $true
                   if ($null -ne $cmd.visible) { $vis = [bool]$cmd.visible }
                   Reply ([DshWin]::Follow([int64]$cmd.hwnd, [int64]$cmd.owner, [int]$cmd.x, [int]$cmd.y, [int]$cmd.w, [int]$cmd.h, $vis))
                 }
      "show"     { Reply ([DshWin]::Follow([int64]$cmd.hwnd, [int64]$cmd.owner, [int]$cmd.x, [int]$cmd.y, [int]$cmd.w, [int]$cmd.h, $true)) }
      "hide"     { Reply ([DshWin]::Follow([int64]$cmd.hwnd, [int64]$cmd.owner, 0, 0, 0, 0, $false)) }
      "clip"     { Reply ([DshWin]::Clip([int64]$cmd.hwnd, [int]$cmd.left, [int]$cmd.top, [int]$cmd.right, [int]$cmd.bottom)) }
      "detach"   { Reply ([DshWin]::Detach([int64]$cmd.hwnd)) }
      "close"    { Reply ([DshWin]::Close([int64]$cmd.hwnd)) }
      "focus"    { Reply ([DshWin]::Focus([int64]$cmd.hwnd)) }
      "foreground" { Reply ([DshWin]::Foreground([int64]$cmd.hwnd)) }
      "keys"     {
                   $f = [DshWin]::Focus([int64]$cmd.hwnd)
                   if ($f -like '*"ok":false*') { Reply $f } else {
                     Start-Sleep -Milliseconds 60
                     try {
                       [System.Windows.Forms.SendKeys]::SendWait([string]$cmd.keys)
                       Reply '{"ok":true}'
                     } catch {
                       Reply '{"ok":false,"reason":"sendkeys"}'
                     }
                   }
                 }
      "content"  {
                   $h = [int64]$cmd.hwnd
                   $d = [DshWin]::Describe([IntPtr]$h)
                   $win = $d | ConvertFrom-Json
                   if ($null -eq $win.title) { Reply '{"ok":false,"reason":"gone"}'; continue }
                   $cap = 30
                   $x = $win.x; $y = $win.y; $w = $win.w; $hgt = $win.h; $name = $win.title; $help = ""
                   if ($uiaReady) {
                     try {
                       $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$h)
                       $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
                       $doc = $el.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
                       if ($null -ne $doc) {
                         $b = $doc.Current.BoundingRectangle
                         if ($b.Width -gt 0 -and $b.Height -gt 0) {
                           $x = [int]$b.X; $y = [int]$b.Y; $w = [int]$b.Width; $hgt = [int]$b.Height
                           $cap = $y - $win.y
                           $name = $doc.Current.Name
                           $help = $doc.Current.HelpText
                         }
                       }
                     } catch { }
                   }
                   $name = ("" + $name) -replace '\\', '\\\\' -replace '"', '\"'
                   $help = ("" + $help) -replace '\\', '\\\\' -replace '"', '\"'
                   Reply ('{"ok":true,"x":' + $x + ',"y":' + $y + ',"w":' + $w + ',"h":' + $hgt + ',"caption":' + $cap + ',"winX":' + $win.x + ',"winY":' + $win.y + ',"winW":' + $win.w + ',"winH":' + $win.h + ',"name":"' + $name + '","help":"' + $help + '"}')
                 }
      default    { Reply '{"ok":false,"reason":"unknown-op"}' }
    }
  } catch {
    $msg = $_.Exception.Message -replace '\\', '\\\\' -replace '"', '\"'
    Reply ('{"ok":false,"reason":"exception","detail":"' + $msg + '"}')
  }
}
