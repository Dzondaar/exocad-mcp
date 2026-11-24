param(
  [Parameter(Mandatory)][string]$Action,
  [Parameter(Mandatory)][string]$Pattern,
  [string]$ArgsB64 = ''
)
# Windows UI Automation helper. One action per call; prints one JSON object on stdout.
# Everything is confined to the top-level window whose title matches $Pattern.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class W32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
[void][W32]::SetProcessDPIAware()

$Deny = @('WindowsTerminal','conhost','powershell','pwsh','cmd','Code','claude','chrome','msedge','firefox','explorer','node')
$Opt = @{}
if ($ArgsB64) {
  $parsed = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgsB64)) | ConvertFrom-Json
  foreach ($p in $parsed.PSObject.Properties) { $Opt[$p.Name] = $p.Value }
}
function Opt($name, $default) { if ($Opt.ContainsKey($name) -and $null -ne $Opt[$name]) { $Opt[$name] } else { $default } }

function Get-Candidates {
  $all = [Windows.Automation.AutomationElement]::RootElement.FindAll(
    [Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
  foreach ($e in $all) {
    $c = $e.Current
    if ($c.NativeWindowHandle -eq 0 -or $c.Name -notmatch $Pattern) { continue }
    $proc = (Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue).ProcessName
    if ($Deny -contains $proc) { continue }
    [pscustomobject]@{ title = $c.Name; pid = $c.ProcessId; process = $proc; handle = [int64]$c.NativeWindowHandle; element = $e }
  }
}
function Get-Target {
  $list = @(Get-Candidates)
  if ($list.Count -eq 0) { throw "No window title matches /$Pattern/. Is the program running and visible? Use exocad_list_windows, or set EXOCAD_WINDOW_RE." }
  $h = Opt 'handle' $null
  if ($h) { $hit = $list | Where-Object { $_.handle -eq [int64]$h }; if (-not $hit) { throw "Window handle $h is not one of the matching windows." }; return $hit }
  return $list[0]
}
function Get-Rect($t) {
  $r = New-Object W32+RECT
  [void][W32]::GetWindowRect([IntPtr]$t.handle, [ref]$r)
  [pscustomobject]@{ L = $r.L; T = $r.T; W = $r.R - $r.L; H = $r.B - $r.T }
}
function Set-Focus($t) {
  $h = [IntPtr]$t.handle
  if ([W32]::IsIconic($h)) { [void][W32]::ShowWindow($h, 9) }
  # A tap on Alt lets a background process take the foreground (Windows foreground-lock workaround)
  for ($try = 0; $try -lt 3 -and [W32]::GetForegroundWindow() -ne $h; $try++) {
    [W32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [W32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [void][W32]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 150
  }
  if ([W32]::GetForegroundWindow() -ne $h) { throw "Could not bring '$($t.title)' to the foreground (another window may be blocking focus)." }
}
function To-Screen($t, $x, $y) {
  $s = [double](Opt 'scale' 1.0)
  $r = Get-Rect $t
  $px = [math]::Round($x / $s); $py = [math]::Round($y / $s)
  if ($px -lt 0 -or $py -lt 0 -or $px -ge $r.W -or $py -ge $r.H) { throw "Point ($x,$y) is outside the window ($([math]::Round($r.W*$s))x$([math]::Round($r.H*$s)) in screenshot pixels). Refusing to act outside the target window." }
  [pscustomobject]@{ X = $r.L + $px; Y = $r.T + $py }
}
function Send-Mouse($button, $down) {
  $flags = @{ left = @(0x2, 0x4); right = @(0x8, 0x10); middle = @(0x20, 0x40) }[$button]
  if (-not $flags) { throw "button must be left, right or middle" }
  [W32]::mouse_event($(if ($down) { $flags[0] } else { $flags[1] }), 0, 0, 0, [UIntPtr]::Zero)
}
function Convert-Keys([string]$combo) {
  $map = @{ enter = '{ENTER}'; esc = '{ESC}'; escape = '{ESC}'; tab = '{TAB}'; space = ' '; backspace = '{BACKSPACE}'; delete = '{DELETE}'; up = '{UP}'; down = '{DOWN}'; left = '{LEFT}'; right = '{RIGHT}'; home = '{HOME}'; end = '{END}'; pageup = '{PGUP}'; pagedown = '{PGDN}' }
  $mods = ''; $key = ''
  foreach ($p in $combo.ToLower().Split('+')) {
    switch ($p) {
      'ctrl' { $mods += '^' }
      'alt' { $mods += '%' }
      'shift' { $mods += '+' }
      default {
        if ($map.ContainsKey($p)) { $key = $map[$p] }
        elseif ($p -match '^f([1-9]|1[0-2])$') { $key = '{' + $p.ToUpper() + '}' }
        elseif ($p.Length -eq 1) { $key = $p }
        else { throw "Unknown key '$p'. Use e.g. ctrl+s, alt+f4, enter, tab, f5." }
      }
    }
  }
  return $mods + $key
}
function Rel-Rect($el, $win) {
  $b = $el.Current.BoundingRectangle
  if ($b.IsEmpty) { return $null }
  @([int]($b.X - $win.L), [int]($b.Y - $win.T), [int]$b.Width, [int]$b.Height)
}
function Find-Control($t, $name, $type) {
  $cond = New-Object Windows.Automation.PropertyCondition ([Windows.Automation.AutomationElement]::NameProperty), $name, ([Windows.Automation.PropertyConditionFlags]::IgnoreCase)
  $found = @($t.element.FindAll([Windows.Automation.TreeScope]::Descendants, $cond))
  if ($type) { $found = @($found | Where-Object { $_.Current.ControlType.ProgrammaticName -like "*$type" }) }
  return $found
}

try {
  switch ($Action) {
    'windows' {
      $out = @(Get-Candidates | ForEach-Object { [pscustomobject]@{ title = $_.title; pid = $_.pid; process = $_.process; handle = $_.handle } })
      @{ windows = $out } | ConvertTo-Json -Compress -Depth 5; break
    }
    'focus' { $t = Get-Target; Set-Focus $t; @{ ok = $true; title = $t.title } | ConvertTo-Json -Compress; break }
    'screenshot' {
      $t = Get-Target; Set-Focus $t
      $r = Get-Rect $t
      $scale = [double](Opt 'scale' 1.0)
      $bmp = New-Object Drawing.Bitmap $r.W, $r.H
      $g = [Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
      $g.Dispose()
      if ($scale -ne 1.0) {
        $small = New-Object Drawing.Bitmap ([int]($r.W * $scale)), ([int]($r.H * $scale))
        $g2 = [Drawing.Graphics]::FromImage($small)
        $g2.InterpolationMode = 'HighQualityBicubic'
        $g2.DrawImage($bmp, 0, 0, $small.Width, $small.Height)
        $g2.Dispose(); $bmp.Dispose(); $bmp = $small
      }
      $ms = New-Object IO.MemoryStream
      $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
      @{ width = $bmp.Width; height = $bmp.Height; scale = $scale; title = $t.title; png_base64 = [Convert]::ToBase64String($ms.ToArray()) } | ConvertTo-Json -Compress
      break
    }
    'click' {
      $t = Get-Target; Set-Focus $t
      $pt = To-Screen $t (Opt 'x' 0) (Opt 'y' 0)
      [void][W32]::SetCursorPos($pt.X, $pt.Y); Start-Sleep -Milliseconds 40
      $b = Opt 'button' 'left'
      $n = if (Opt 'double' $false) { 2 } else { 1 }
      for ($i = 0; $i -lt $n; $i++) { Send-Mouse $b $true; Send-Mouse $b $false; Start-Sleep -Milliseconds 60 }
      @{ ok = $true } | ConvertTo-Json -Compress; break
    }
    'drag' {
      $t = Get-Target; Set-Focus $t
      $a = To-Screen $t (Opt 'x1' 0) (Opt 'y1' 0); $z = To-Screen $t (Opt 'x2' 0) (Opt 'y2' 0)
      $b = Opt 'button' 'left'
      [void][W32]::SetCursorPos($a.X, $a.Y); Start-Sleep -Milliseconds 40
      Send-Mouse $b $true
      $steps = 12
      for ($i = 1; $i -le $steps; $i++) {
        [void][W32]::SetCursorPos([int]($a.X + ($z.X - $a.X) * $i / $steps), [int]($a.Y + ($z.Y - $a.Y) * $i / $steps)); Start-Sleep -Milliseconds 16
      }
      Send-Mouse $b $false
      @{ ok = $true } | ConvertTo-Json -Compress; break
    }
    'scroll' {
      $t = Get-Target; Set-Focus $t
      $pt = To-Screen $t (Opt 'x' 0) (Opt 'y' 0)
      [void][W32]::SetCursorPos($pt.X, $pt.Y); Start-Sleep -Milliseconds 40
      [W32]::mouse_event(0x800, 0, 0, [int]((Opt 'amount' 1) * 120), [UIntPtr]::Zero)
      @{ ok = $true } | ConvertTo-Json -Compress; break
    }
    'type' {
      $t = Get-Target; Set-Focus $t
      [Windows.Forms.SendKeys]::SendWait([regex]::Replace([string](Opt 'text' ''), '[+^%~(){}\[\]]', '{$0}'))
      @{ ok = $true } | ConvertTo-Json -Compress; break
    }
    'key' {
      $t = Get-Target; Set-Focus $t
      [Windows.Forms.SendKeys]::SendWait((Convert-Keys ([string](Opt 'keys' ''))))
      @{ ok = $true } | ConvertTo-Json -Compress; break
    }
    'tree' {
      $t = Get-Target; $win = Get-Rect $t
      $maxDepth = [int](Opt 'depth' 6); $limit = [int](Opt 'limit' 300)
      $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
      $items = New-Object System.Collections.ArrayList
      function Walk($el, $d) {
        if ($items.Count -ge $limit -or $d -gt $maxDepth) { return }
        $c = $el.Current
        if ($c.Name -or $c.AutomationId) {
          [void]$items.Add([pscustomobject]@{ depth = $d; type = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', ''); name = $c.Name; id = $c.AutomationId; rect = (Rel-Rect $el $win); enabled = $c.IsEnabled })
        }
        for ($ch = $walker.GetFirstChild($el); $ch; $ch = $walker.GetNextSibling($ch)) { Walk $ch ($d + 1) }
      }
      Walk $t.element 0
      @{ title = $t.title; count = $items.Count; truncated = ($items.Count -ge $limit); controls = @($items) } | ConvertTo-Json -Compress -Depth 6
      break
    }
    'invoke' {
      $t = Get-Target; Set-Focus $t; $win = Get-Rect $t
      $found = @(Find-Control $t ([string](Opt 'name' '')) (Opt 'type' $null))
      if ($found.Count -eq 0) { throw "No control named '$(Opt 'name' '')' found. Use exocad_list_controls to see names." }
      if ($found.Count -gt 1) { throw "$($found.Count) controls are named '$(Opt 'name' '')'. Pass 'control_type' (e.g. Button) or click by coordinates." }
      $el = $found[0]; $how = ''
      foreach ($pat in @([Windows.Automation.InvokePattern], [Windows.Automation.TogglePattern], [Windows.Automation.SelectionItemPattern], [Windows.Automation.ExpandCollapsePattern])) {
        $o = $null
        if ($el.TryGetCurrentPattern($pat::Pattern, [ref]$o)) {
          switch ($pat.Name) { 'InvokePattern' { $o.Invoke() } 'TogglePattern' { $o.Toggle() } 'SelectionItemPattern' { $o.Select() } 'ExpandCollapsePattern' { $o.Expand() } }
          $how = $pat.Name; break
        }
      }
      if (-not $how) {
        $b = $el.Current.BoundingRectangle
        if ($b.IsEmpty) { throw "Control has no on-screen position and no invoke pattern." }
        [void][W32]::SetCursorPos([int]($b.X + $b.Width / 2), [int]($b.Y + $b.Height / 2)); Start-Sleep -Milliseconds 40
        Send-Mouse 'left' $true; Send-Mouse 'left' $false; $how = 'mouse-click-center'
      }
      @{ ok = $true; method = $how } | ConvertTo-Json -Compress; break
    }
    default { throw "Unknown action '$Action'" }
  }
} catch {
  @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
