param([string]$TestRoot=$PSScriptRoot,[string]$WidgetSource)
$ErrorActionPreference='Stop'
if(!$WidgetSource){$WidgetSource=Join-Path (Split-Path $TestRoot -Parent) 'widget.ps1'}
$source=[IO.File]::ReadAllText($WidgetSource,[Text.Encoding]::UTF8)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors|Out-String)}
$move=$ast.Find({param($node)$node-is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text-eq '$pressMove'},$true)
$pressMove=[ScriptBlock]::Create($move.Right.Extent.Text.Trim().Substring(1,$move.Right.Extent.Text.Trim().Length-2))
$tick=$ast.Find({param($node)$node-is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name-eq 'Tick-Widget'},$true)
. ([ScriptBlock]::Create($tick.Extent.Text))
Add-Type -TypeDefinition @'
using System;
public static class GptWidgetNative {
 public struct Point {public int X,Y;}
 public static int X,Y,Width,Height,Calls;public static uint Flags;
 public static bool GetCursorPos(out Point point){point=new Point{X=X,Y=Y};return true;}
 public static bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int width,int height,uint flags){Width=width;Height=height;Flags=flags;Calls++;return true;}
 public static IntPtr GetForegroundWindow(){return new IntPtr(1);}
 public static IntPtr GetAncestor(IntPtr h,uint flags){return h;}
 public static bool IsWindow(IntPtr h){return true;}
 public static bool IsIconic(IntPtr h){return false;}
}
public static class GptWidgetZOrderNative {public static bool VisibleSurface(IntPtr h){return true;}}
'@
function Get-WidgetPlacementFrame {return [pscustomobject]@{Left=0;Top=0;Right=8000;Bottom=6000}}
function Get-WidgetPlacementDpi {return $script:testDpi}
function Set-Facing {}
function Tick-Scene {}
function Tick-WidgetUpdater {}
function Ensure-QuotaWorker {}
function Test-WidgetHostReady {return $true}
function Set-WidgetAboveHost {}
function Set-WidgetDesktopLayer {}
function Assert-SizeAfterNativeMove([string]$Context){
  # Reproduce the failure when the host DPI differs from the WPF window DPI:
  # WM_SIZE feeds a native resize back into Window.Width/Height in its own DIPs.
  if(([GptWidgetNative]::Flags-band 1)-eq 0){
    $script:window.Width=[GptWidgetNative]::Width
    $script:window.Height=[GptWidgetNative]::Height
  }
  if($script:window.Width-ne 378 -or $script:window.Height-ne 378){throw ('Window size changed during '+$Context+' at DPI '+$script:testDpi)}
  if($script:scale-ne 1){throw 'Placement changed the user scale.'}
}
$script:hostHandle=[IntPtr](1);$script:widgetHandle=[IntPtr](2)
$script:hostReadiness=[pscustomobject]@{desktopStarted=$true}
$script:context=[pscustomobject]@{IsOpen=$false}
$script:hostFollower=New-Object PSObject
$script:hostFollower|Add-Member ScriptMethod Configure {}
$script:lastForeground=[IntPtr](1);$script:attachedHost=[IntPtr](1)
$script:lastPresence=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+3600000
$script:dataDir=$TestRoot
$cases=0
foreach($follow in @($true,$false)){
  foreach($dpi in @(1.0,1.5,2.0)){
    $script:testDpi=$dpi;$script:followHost=$follow
    $script:window=[pscustomobject]@{Width=378;Height=378;IsVisible=$true}
    $script:scale=1.0;$script:displayScale=1.0
    $script:offsetLeft=20;$script:offsetRight=0;$script:offsetBottom=0;$script:anchor='free'
    $script:desktopLeft=100;$script:desktopTop=100
    $script:drag=@{x=0;y=0;left=100;top=100;moved=$false}
    $event=[pscustomobject]@{Handled=$false}
    for($i=0;$i-lt 20;$i++){
      [GptWidgetNative]::X=100+$i*10;[GptWidgetNative]::Y=100+$i*7
      $before=[GptWidgetNative]::Calls
      & $pressMove $null $event
      if([GptWidgetNative]::Calls-ne $before+1){throw 'Drag did not move the native window.'}
      Assert-SizeAfterNativeMove 'dragging'
    }
    $script:drag=$null
    for($i=0;$i-lt 20;$i++){
      $script:lastPosition=$null;$before=[GptWidgetNative]::Calls
      Tick-Widget
      if([GptWidgetNative]::Calls-ne $before+1){throw 'Placement tick did not move the native window.'}
      Assert-SizeAfterNativeMove 'placement ticks'
    }
    $cases++
  }
}
Write-Output ('PASS: '+$cases+' host/desktop DPI cases preserve 100% size through 20 drags and 20 placement ticks each')
