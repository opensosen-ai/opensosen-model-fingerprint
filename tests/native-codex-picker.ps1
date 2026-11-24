param([Parameter(Mandatory)][string]$Request)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class FingerprintPicker {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")]
  private static extern IntPtr SetText(IntPtr h, uint m, IntPtr w, string value, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")]
  private static extern IntPtr GetText(IntPtr h, uint m, IntPtr w, StringBuilder value, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")]
  private static extern IntPtr Send(IntPtr h, uint m, IntPtr w, IntPtr value, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  private static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);

  public static void Choose(IntPtr dialog, IntPtr combo, IntPtr edit, IntPtr button, string path) {
    IntPtr result;
    var actual = new StringBuilder(2048);
    if (SetText(edit, 12, IntPtr.Zero, path, 2, 2000, out result) == IntPtr.Zero)
      throw new Exception("WM_SETTEXT timed out");
    if (GetText(edit, 13, new IntPtr(actual.Capacity), actual, 2, 2000, out result) == IntPtr.Zero || actual.ToString() != path)
      throw new Exception("Native filename readback differed");
    if (combo != IntPtr.Zero) Send(dialog, 0x111, new IntPtr((5 << 16) | 1148), combo, 2, 2000, out result);
    if (!PostMessage(button, 0x00F5, IntPtr.Zero, IntPtr.Zero)) throw new Exception("Native Open click failed");
  }

  public static void Notify(IntPtr dialog, IntPtr button, int id) {
    if (IsWindow(dialog) && !PostMessage(dialog, 0x111, new IntPtr(id), button))
      throw new Exception("Native picker notification failed");
  }
}
'@

$action = Get-Content -Raw -Encoding utf8 -LiteralPath $Request | ConvertFrom-Json
$ae = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
$filter = New-Object System.Windows.Automation.PropertyCondition($ae::ProcessIdProperty, [int]$action.pid)
$deadline = [DateTime]::UtcNow.AddSeconds(15)
do {
  $dialog = $ae::RootElement.FindAll($scope::Children, $filter) |
    Where-Object { $_.Current.ClassName -eq '#32770' -and $_.Current.Name -match 'Codex' } | Select-Object -First 1
  if ($dialog) { break }
  Start-Sleep -Milliseconds 150
} while ([DateTime]::UtcNow -lt $deadline)
if (!$dialog) { throw 'Codex file picker did not open' }

$dialogHandle = [intptr]$dialog.Current.NativeWindowHandle
if (!$action.pick) {
  [FingerprintPicker]::Notify($dialogHandle, [intptr]::Zero, 2)
  return
}

$fixturePath = (Resolve-Path -LiteralPath $action.pick).Path
$fixtureDirectory = (Resolve-Path -LiteralPath (Split-Path -Parent $Request)).Path
if (!$fixturePath.StartsWith($fixtureDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The picker fixture must be inside the isolated test directory'
}
$controls = $dialog.FindAll($scope::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$edit = $controls | Where-Object { $_.Current.AutomationId -eq '1148' -and $_.Current.ClassName -eq 'Edit' } | Select-Object -First 1
$combo = $controls | Where-Object { $_.Current.AutomationId -eq '1148' -and $_.Current.ClassName -eq 'ComboBoxEx32' } | Select-Object -First 1
$open = $controls | Where-Object { $_.Current.AutomationId -eq '1' -and $_.Current.ClassName -eq 'Button' } | Select-Object -First 1
if (!$edit -or !$open) { throw 'Native picker fields were unavailable' }
$buttonHandle = [intptr]$open.Current.NativeWindowHandle
$comboHandle = if ($combo) { [intptr]$combo.Current.NativeWindowHandle } else { [intptr]::Zero }
[FingerprintPicker]::Choose($dialogHandle, $comboHandle, [intptr]$edit.Current.NativeWindowHandle, $buttonHandle, $fixturePath)
Start-Sleep -Milliseconds 500
[FingerprintPicker]::Notify($dialogHandle, $buttonHandle, 1)
