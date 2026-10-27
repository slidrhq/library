#Requires -Version 7.5
<#
.SYNOPSIS
The checks of section 10 of docs/custom-agent-cli.md, run against openwebui-agent.ps1 with a
stand-in tool bridge (fake-bridge.ps1) and the Open WebUI the CLI is signed in to.

.DESCRIPTION
Sign in first (`openwebui-agent.ps1 slidr login`). Several checks ask the model to do something
and read what it did, so they depend on the model: tool use, vision, a context of 128,000 tokens.

.PARAMETER Model
The model of the turns. Default: the CLI's own default.

.PARAMETER SkipImages
Leave out the image checks (11, 12), which make real images.
#>
param(
    [string] $Model,
    [switch] $SkipImages
)

$ErrorActionPreference = 'Stop'
$cli = (Resolve-Path (Join-Path $PSScriptRoot '..' 'openwebui-agent.ps1')).Path
$pwsh = (Get-Process -Id $PID).Path
$utf8 = [System.Text.UTF8Encoding]::new($false)
$work = Join-Path ([System.IO.Path]::GetTempPath()) "slidr-openwebui-conformance-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
[void][System.IO.Directory]::CreateDirectory($work)
$results = [System.Collections.Generic.List[object]]::new()

function Add-Result([string] $Check, [string] $Outcome, [string] $Detail) {
    $results.Add([pscustomobject]@{ Check = $Check; Outcome = $Outcome; Detail = $Detail })
    $color = switch ($Outcome) { 'PASS' { 'Green' } 'FAIL' { 'Red' } default { 'Yellow' } }
    Write-Host ('{0,-5} {1}  {2}' -f $Outcome, $Check, $Detail) -ForegroundColor $color
}

# Starts the CLI as the app does: no window, the request on standard input, then its end.
function Start-Cli([string] $Subcommand, [string] $Stdin, [hashtable] $Environment, [string] $WorkingDirectory = $work) {
    $info = [System.Diagnostics.ProcessStartInfo]::new($pwsh)
    foreach ($argument in '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $cli, 'slidr', $Subcommand) { $info.ArgumentList.Add($argument) }
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardInputEncoding = $utf8
    $info.StandardOutputEncoding = $utf8
    $info.StandardErrorEncoding = $utf8
    $info.WorkingDirectory = $WorkingDirectory
    $info.Environment['SLIDR_PROTOCOL'] = '1'
    if ($Environment) { foreach ($name in $Environment.Keys) { $info.Environment[$name] = $Environment[$name] } }
    $process = [System.Diagnostics.Process]::Start($info)
    $errors = $process.StandardError.ReadToEndAsync()
    if ($Stdin) { $process.StandardInput.Write($Stdin) }
    $process.StandardInput.Close()
    return @{ Process = $process; Errors = $errors; Started = [DateTime]::UtcNow; Lines = [System.Collections.Generic.List[string]]::new() }
}

# Reads the run's lines until `$Until` holds for one (or the output ends); `$true` when it held.
function Read-Lines([hashtable] $Run, [scriptblock] $Until, [int] $TimeoutSeconds = 300) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $next = $Run.Process.StandardOutput.ReadLineAsync()
        if (-not $next.Wait([Math]::Max(1, ($deadline - [DateTime]::UtcNow).TotalMilliseconds))) { return $false }
        $line = $next.Result
        if ($null -eq $line) { return $false }
        $Run.Lines.Add($line)
        if ($Until -and (& $Until $line)) { return $true }
    }
    return $false
}

function Invoke-Cli([string] $Subcommand, $Request, [hashtable] $Environment, [int] $TimeoutSeconds = 300, [string] $WorkingDirectory = $work) {
    $stdin = if ($null -eq $Request) { '' } elseif ($Request -is [string]) { $Request } else { ConvertTo-Json $Request -Depth 30 -Compress -EscapeHandling Default }
    $run = Start-Cli $Subcommand $stdin $Environment $WorkingDirectory
    [void](Read-Lines $run $null $TimeoutSeconds)
    if (-not $run.Process.WaitForExit(5000)) { $run.Process.Kill($true); $run.Process.WaitForExit() }
    $events = [System.Collections.Generic.List[object]]::new()
    $notJson = 0
    foreach ($line in $run.Lines) {
        try { $events.Add((ConvertFrom-Json $line -AsHashtable)) } catch { $notJson++ }
    }
    return @{
        Exit    = $run.Process.ExitCode
        Seconds = ([DateTime]::UtcNow - $run.Started).TotalSeconds
        Lines   = $run.Lines
        Events  = $events
        NotJson = $notJson
        Errors  = $run.Errors.Result
        Text    = (@($events | Where-Object { $_['type'] -eq 'text_delta' } | ForEach-Object { $_['text'] }) -join '')
    }
}

function New-Turn([string] $Text, [string] $SessionId, [bool] $Resume, [hashtable] $Tools) {
    $request = [ordered]@{
        protocol     = 1
        session      = [ordered]@{ id = $SessionId; resume = $Resume }
        systemPrompt = 'You are a test agent. Do exactly what the user asks, using the tools when asked. Keep replies short.'
        context      = $null
        text         = $Text
        images       = @()
        model        = if ($Model) { $Model } else { $null }
        effort       = $null
        webAccess    = $false
        tools        = $Tools
    }
    return $request
}

function Get-Last([hashtable] $Result, [string] $Type) { @($Result.Events | Where-Object { $_['type'] -eq $Type }) }

function Show-Failure([hashtable] $Result) {
    $fault = Get-Last $Result 'error' | Select-Object -First 1
    if ($fault) { return "$($fault['kind']): $($fault['message'])" }
    return ($Result.Errors -split "`n" | Where-Object { $_ } | Select-Object -Last 3) -join ' | '
}

# The stand-in bridge.
$probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$probe.Start()
$port = $probe.LocalEndpoint.Port
$probe.Stop()
$key = [guid]::NewGuid().ToString('N')
$token = [guid]::NewGuid().ToString('N')
$callsLog = Join-Path $work 'calls.jsonl'
$bridge = Start-Process $pwsh -ArgumentList '-NoLogo', '-NoProfile', '-File', (Join-Path $PSScriptRoot 'fake-bridge.ps1'), '-Port', $port, '-Key', $key, '-Token', $token, '-CallsLog', $callsLog -WindowStyle Hidden -PassThru
$tools = @{ url = "http://127.0.0.1:$port/mcp/$key"; server = 'slidr' }
$toolEnv = @{ SLIDR_MCP_TOKEN = $token }
$ready = $false
for ($i = 0; $i -lt 50 -and -not $ready; $i++) {
    Start-Sleep -Milliseconds 200
    try { $ready = (Invoke-WebRequest $tools.url -Method Post -SkipHttpErrorCheck -TimeoutSec 2).StatusCode -eq 401 } catch { }
}
if (-not $ready) { throw 'The stand-in bridge did not start.' }

function Get-Calls {
    if (-not (Test-Path $callsLog)) { return @() }
    @(Get-Content $callsLog -Encoding utf8 | Where-Object { $_ } | ForEach-Object { ConvertFrom-Json $_ -AsHashtable -DateKind String })
}

try {
    # 1. Setup subcommands: in time, nothing on standard output but their JSON.
    $describe = Invoke-Cli 'describe' $null @{} 15
    $status = Invoke-Cli 'status' $null @{} 15
    $models = Invoke-Cli 'models' $null @{} 60
    $ok = $describe.Exit -eq 0 -and $describe.NotJson -eq 0 -and $describe.Events.Count -eq 1 -and $describe.Seconds -lt 15 -and
        $status.Exit -eq 0 -and $status.NotJson -eq 0 -and $status.Events.Count -eq 1 -and $status.Seconds -lt 15 -and
        $models.Exit -eq 0 -and $models.NotJson -eq 0 -and $models.Events.Count -eq 1 -and $models.Seconds -lt 60
    $state = if ($status.Events.Count) { $status.Events[0]['state'] } else { '?' }
    $count = if ($models.Events.Count -and $models.Events[0]['models']) { $models.Events[0]['models'].Count } else { 0 }
    Add-Result '1 setup' $(if ($ok) { 'PASS' } else { 'FAIL' }) ('describe {0:n1}s, status {1:n1}s ({2}), models {3:n1}s ({4} models, default {5})' -f $describe.Seconds, $status.Seconds, $state, $models.Seconds, $count, $(if ($models.Events.Count) { $models.Events[0]['default'] }))
    if ($state -ne 'ready') { throw "The CLI is not ready ($state): sign in first. $(if ($status.Events.Count) { $status.Events[0]['detail'] })" }
    if (-not $Model) { $Model = $models.Events[0]['default'] }
    Write-Host "Model: $Model"

    # 2 and 10. An app tool through the bridge, by its bare name, Hebrew unchanged on the way.
    $session = [guid]::NewGuid().ToString()
    $turn = Invoke-Cli 'turn' (New-Turn 'Call fast_tool with note set to exactly "שלום עולם", then tell me what it answered.' $session $false $tools) $toolEnv
    $started = Get-Last $turn 'tool_call_started' | Where-Object { $_['name'] -eq 'fast_tool' } | Select-Object -First 1
    $finished = if ($started) { Get-Last $turn 'tool_call_finished' | Where-Object { $_['id'] -eq $started['id'] } | Select-Object -First 1 }
    $first = if ($turn.Events.Count) { $turn.Events[0]['type'] } else { '' }
    $last = if ($turn.Events.Count) { $turn.Events[-1] } else { @{} }
    $call = Get-Calls | Where-Object { $_['name'] -eq 'fast_tool' } | Select-Object -Last 1
    $ok = $turn.Exit -eq 0 -and $first -eq 'session_started' -and $started -and $started['source'] -eq 'app' -and $finished -and $finished['ok'] -and $call -and $last['outcome'] -eq 'completed'
    Add-Result '2 app tool' $(if ($ok) { 'PASS' } else { 'FAIL' }) $(if ($ok) { "fast_tool called, reply: $($turn.Text.Trim())" } else { Show-Failure $turn })
    $note = if ($call) { $call['arguments']['note'] } else { '' }
    $hebrewOk = $note -eq 'שלום עולם' -and $started -and $started['input']['note'] -eq 'שלום עולם'
    Add-Result '10a Hebrew to a tool' $(if ($hebrewOk) { 'PASS' } else { 'FAIL' }) "the bridge got '$note'"

    # 7. session_exists and resume_failed, before the model is called.
    $again = Invoke-Cli 'turn' (New-Turn 'Hello' $session $false $tools) $toolEnv
    $unknown = Invoke-Cli 'turn' (New-Turn 'Hello' ([guid]::NewGuid().ToString()) $true $tools) $toolEnv
    $kindA = (Get-Last $again 'error' | Select-Object -First 1)
    $kindB = (Get-Last $unknown 'error' | Select-Object -First 1)
    $ok = $kindA -and $kindA['kind'] -eq 'session_exists' -and $kindB -and $kindB['kind'] -eq 'resume_failed' -and $again.Exit -ne 0 -and $unknown.Exit -ne 0
    Add-Result '7 session ids' $(if ($ok) { 'PASS' } else { 'FAIL' }) ('{0} in {1:n1}s, {2} in {3:n1}s' -f $kindA['kind'], $again.Seconds, $kindB['kind'], $unknown.Seconds)

    # 10. A Hebrew request and reply.
    $hebrew = Invoke-Cli 'turn' (New-Turn 'ענה במשפט אחד קצר בעברית: באיזה צבע השמיים ביום בהיר?' $session $true $tools) $toolEnv
    $ok = $hebrew.Exit -eq 0 -and $hebrew.Text -match '[֐-׿]'
    Add-Result '10b Hebrew reply' $(if ($ok) { 'PASS' } else { 'FAIL' }) $(if ($ok) { $hebrew.Text.Trim() } else { Show-Failure $hebrew })

    # 3. Two calls of one step side by side.
    $before = @(Get-Calls).Count
    $parallel = Invoke-Cli 'turn' (New-Turn 'In ONE step, make two tool calls at the same time: slow_tool with seconds 6, and fast_tool with note "parallel". Then say done.' ([guid]::NewGuid().ToString()) $false $tools) $toolEnv
    $calls = @(Get-Calls | Select-Object -Skip $before)
    $slow = $calls | Where-Object { $_['name'] -eq 'slow_tool' } | Select-Object -First 1
    $fast = $calls | Where-Object { $_['name'] -eq 'fast_tool' } | Select-Object -First 1
    $steps = @(Get-Last $parallel 'tool_call_started')
    $order = @(Get-Last $parallel 'tool_call_finished' | ForEach-Object { $id = $_['id']; ($steps | Where-Object { $_['id'] -eq $id }).name })
    if ($slow -and $fast) {
        $overlap = [DateTime]$fast['started'] -lt [DateTime]$slow['ended'] -and [DateTime]$slow['started'] -lt [DateTime]$fast['ended']
        $sameStep = $parallel.Lines.IndexOf(($parallel.Lines | Where-Object { $_ -match '"tool_call_finished"' } | Select-Object -First 1)) -gt
            $parallel.Lines.IndexOf(($parallel.Lines | Where-Object { $_ -match '"tool_call_started"' } | Select-Object -Last 1))
        if ($overlap -and $order[0] -eq 'fast_tool') { Add-Result '3 side by side' 'PASS' "finished in the order $($order -join ', ')" }
        elseif (-not $sameStep) { Add-Result '3 side by side' 'SKIP' 'the model made the two calls in separate steps' }
        else { Add-Result '3 side by side' 'FAIL' "finished in the order $($order -join ', '), overlap $overlap" }
    } else { Add-Result '3 side by side' 'FAIL' (Show-Failure $parallel) }

    # 4. An image of a tool result reaches the model.
    $look = Invoke-Cli 'turn' (New-Turn 'Call slide_render for slide s_1, look at the picture it returns, and tell me in one sentence which shape and which colours you see.' ([guid]::NewGuid().ToString()) $false $tools) $toolEnv
    $ok = $look.Exit -eq 0 -and $look.Text -match 'circle|round|disc|disk' -and $look.Text -match 'yellow|gold|orange'
    Add-Result '4 image to the model' $(if ($ok) { 'PASS' } else { 'FAIL' }) $(if ($look.Exit -eq 0) { $look.Text.Trim() } else { Show-Failure $look })

    # 5. A result of 300,000 characters, whole.
    $long = Invoke-Cli 'turn' (New-Turn 'Call long_result. Its text ends with a code word. Reply with only the code word.' ([guid]::NewGuid().ToString()) $false $tools) $toolEnv
    $ok = $long.Exit -eq 0 -and $long.Text -match 'ZEBRA-4417'
    Add-Result '5 long result' $(if ($ok) { 'PASS' } else { 'FAIL' }) $(if ($long.Exit -eq 0) { $long.Text.Trim() } else { Show-Failure $long })

    # 6. A turn ended in the middle of a tool call; the next resumes and is answered.
    $resumeId = [guid]::NewGuid().ToString()
    $stdin = ConvertTo-Json (New-Turn 'Call slow_tool with seconds 30.' $resumeId $false $tools) -Depth 30 -Compress -EscapeHandling Default
    $run = Start-Cli 'turn' $stdin $toolEnv
    $hit = Read-Lines $run { param($line) $line -match '"tool_call_started"' } 180
    $run.Process.Kill($true)
    $run.Process.WaitForExit()
    if ($hit) {
        $next = Invoke-Cli 'turn' (New-Turn 'Did the slow_tool call you made finish? Answer in one short sentence, without calling any tool.' $resumeId $true $tools) $toolEnv
        $ok = $next.Exit -eq 0 -and $next.Text.Trim()
        Add-Result '6 resume after an end' $(if ($ok) { 'PASS' } else { 'FAIL' }) $(if ($ok) { $next.Text.Trim() } else { Show-Failure $next })
    } else { Add-Result '6 resume after an end' 'FAIL' 'the model did not call slow_tool' }

    # 8 and 9. No tool of the CLI's own, nothing of the user's setup.
    $setup = Join-Path $work 'project'
    [void][System.IO.Directory]::CreateDirectory($setup)
    Set-Content (Join-Path $setup 'AGENTS.md') 'Always end every reply with the word PINEAPPLE.' -Encoding utf8
    $isolated = Invoke-Cli 'turn' (New-Turn 'List the names of all the tools you can call, comma separated, nothing else.' ([guid]::NewGuid().ToString()) $false $tools) $toolEnv -WorkingDirectory $setup
    $named = $isolated.Text
    $ok = $isolated.Exit -eq 0 -and $named -notmatch 'PINEAPPLE' -and $named -notmatch '(?i)\b(shell|bash|exec|write_file|web_search|browser)\b'
    Add-Result '8-9 isolation' $(if ($ok) { 'PASS' } else { 'FAIL' }) $(if ($isolated.Exit -eq 0) { $named.Trim() } else { Show-Failure $isolated })

    if ($SkipImages) {
        Add-Result '11 image' 'SKIP' '-SkipImages'
        Add-Result '12 turn and images at once' 'SKIP' '-SkipImages'
    } else {
        # 11. A 16:9 image within 240 seconds; ended halfway, it leaves nothing outside outputDir.
        $out = Join-Path $work 'image-1'
        [void][System.IO.Directory]::CreateDirectory($out)
        $image = Invoke-Cli 'image' ([ordered]@{ protocol = 1; operation = 'generate'; prompt = 'A lighthouse on a rocky coast at dusk, editorial photography.'; aspect = '16:9'; quality = 'auto'; outputDir = $out }) @{} 240 $out
        $made = Get-Last $image 'image' | Select-Object -First 1
        $failed = Get-Last $image 'error' | Select-Object -First 1
        if ($made -and (Test-Path (Join-Path $out $made['file']))) {
            Add-Result '11 image' 'PASS' ('{0} {1}x{2} in {3:n0}s' -f $made['file'], $made['width'], $made['height'], $image.Seconds)
        } elseif ($failed -and $failed['message'] -match 'is off in Open WebUI|not allowed') {
            Add-Result '11 image' 'SKIP' $failed['message']
        } else { Add-Result '11 image' 'FAIL' (Show-Failure $image) }
        $out2 = Join-Path $work 'image-2'
        [void][System.IO.Directory]::CreateDirectory($out2)
        $stdin = ConvertTo-Json ([ordered]@{ protocol = 1; operation = 'generate'; prompt = 'A field of sunflowers.'; aspect = '1:1'; outputDir = $out2 }) -Compress
        $run = Start-Cli 'image' $stdin @{} $out2
        Start-Sleep -Seconds 3
        $processId = $run.Process.Id
        $run.Process.Kill($true)
        $run.Process.WaitForExit()
        $left = Get-Process -Id $processId -ErrorAction SilentlyContinue
        $stray = @(Get-ChildItem $work -Recurse -File | Where-Object { $_.DirectoryName -notin $out, $out2, $setup -and $_.Name -ne 'calls.jsonl' })
        $ok = -not $left -and -not $stray.Count
        Add-Result '11b image ended' $(if ($ok) { 'PASS' } else { 'FAIL' }) "process left: $([bool]$left), files outside outputDir: $($stray.Count)"

        # 12. A turn and three image runs at once.
        if ($made) {
            $runs = foreach ($n in 1..3) {
                $dir = Join-Path $work "image-p$n"
                [void][System.IO.Directory]::CreateDirectory($dir)
                Start-Cli 'image' (ConvertTo-Json ([ordered]@{ protocol = 1; operation = 'generate'; prompt = "A paper boat number $n on calm water."; aspect = '4:3'; outputDir = $dir }) -Compress) @{} $dir
            }
            $together = Invoke-Cli 'turn' (New-Turn 'Call fast_tool with note "together", then say done.' ([guid]::NewGuid().ToString()) $false $tools) $toolEnv
            $imageOk = 0
            foreach ($r in $runs) {
                [void](Read-Lines $r $null 240)
                $r.Process.WaitForExit()
                if ($r.Lines | Where-Object { $_ -match '"type":"image"' }) { $imageOk++ }
            }
            $ok = $together.Exit -eq 0 -and $imageOk -eq 3
            Add-Result '12 turn and images at once' $(if ($ok) { 'PASS' } else { 'FAIL' }) "turn exit $($together.Exit), images $imageOk/3"
        } else { Add-Result '12 turn and images at once' 'SKIP' 'no image provider' }
    }
} finally {
    Stop-Process -Id $bridge.Id -Force -ErrorAction SilentlyContinue
}

$failedCount = @($results | Where-Object Outcome -eq 'FAIL').Count
Write-Host ''
Write-Host ("{0} passed, {1} failed, {2} skipped. Work folder: {3}" -f @($results | Where-Object Outcome -eq 'PASS').Count, $failedCount, @($results | Where-Object Outcome -eq 'SKIP').Count, $work)
exit $(if ($failedCount) { 1 } else { 0 })
