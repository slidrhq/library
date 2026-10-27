#Requires -Version 7.5
<#
.SYNOPSIS
A stand-in for the app's tool bridge (desktop/src-tauri/src/mcp_bridge): MCP over Streamable HTTP
on 127.0.0.1, protocol 2026-07-28, plain JSON answers, a path and a bearer token of its own.

.DESCRIPTION
Serves four tools, each request on a thread of its own so that a slow call does not hold up a
fast one:

    slide_render   a picture of a slide: a dark blue square with a yellow circle, and its id
    slow_tool      answers after `seconds` (default 6)
    fast_tool      answers at once
    long_result    300,000 characters, with a code word at their end

Every call is written to the calls log, one JSON line each, with its start and end times.
#>
param(
    [Parameter(Mandatory)] [int] $Port,
    [Parameter(Mandatory)] [string] $Key,
    [Parameter(Mandatory)] [string] $Token,
    [Parameter(Mandatory)] [string] $CallsLog
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
$bitmap = [System.Drawing.Bitmap]::new(480, 270)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([System.Drawing.Color]::FromArgb(14, 42, 92))
$graphics.FillEllipse([System.Drawing.Brushes]::Gold, 165, 60, 150, 150)
$graphics.Dispose()
$png = [System.IO.MemoryStream]::new()
$bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$picture = [Convert]::ToBase64String($png.ToArray())

$tools = @(
    [ordered]@{ name = 'slide_render'; description = 'Renders a slide and returns its picture.'; inputSchema = [ordered]@{ type = 'object'; properties = [ordered]@{ slideId = [ordered]@{ type = 'string' } }; required = @('slideId') } }
    [ordered]@{ name = 'slow_tool'; description = 'Answers after some seconds.'; inputSchema = [ordered]@{ type = 'object'; properties = [ordered]@{ seconds = [ordered]@{ type = 'number' } } } }
    [ordered]@{ name = 'fast_tool'; description = 'Answers at once.'; inputSchema = [ordered]@{ type = 'object'; properties = [ordered]@{ note = [ordered]@{ type = 'string' } } } }
    [ordered]@{ name = 'long_result'; description = 'Returns a very long text with a code word at its very end.'; inputSchema = [ordered]@{ type = 'object' } }
)
$listJson = ConvertTo-Json -InputObject ([ordered]@{ tools = $tools; ttlMs = 0; cacheScope = 'private' }) -Depth 20 -Compress

$handler = {
    param($Context, $Shared)
    $request = $Context.Request
    $response = $Context.Response
    function Send([int] $Status, [string] $Json) {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Json)
        $response.StatusCode = $Status
        $response.ContentType = 'application/json'
        $response.ContentLength64 = $bytes.Length
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
        $response.Close()
    }
    try {
        if ($request.Url.AbsolutePath -ne "/mcp/$($Shared.Key)" -or $request.Headers['Authorization'] -ne "Bearer $($Shared.Token)") {
            $response.StatusCode = 401
            $response.Close()
            return
        }
        $body = [System.IO.StreamReader]::new($request.InputStream, [System.Text.Encoding]::UTF8).ReadToEnd()
        $message = ConvertFrom-Json $body -AsHashtable
        $id = ConvertTo-Json $message['id'] -Compress
        switch ($message['method']) {
            'tools/list' { Send 200 ('{"jsonrpc":"2.0","id":' + $id + ',"result":' + $Shared.List + '}') }
            'tools/call' {
                $name = $message['params']['name']
                $arguments = $message['params']['arguments']
                $started = [DateTime]::UtcNow
                $content = switch ($name) {
                    'slide_render' {
                        @([ordered]@{ type = 'text'; text = "Rendered slide $($arguments['slideId'])." }, [ordered]@{ type = 'image'; data = $Shared.Picture; mimeType = 'image/png' })
                    }
                    'slow_tool' {
                        $seconds = if ($arguments['seconds']) { [double]$arguments['seconds'] } else { 6 }
                        Start-Sleep -Milliseconds ([int]($seconds * 1000))
                        @([ordered]@{ type = 'text'; text = 'slow done' })
                    }
                    'fast_tool' { @([ordered]@{ type = 'text'; text = "fast done: $($arguments['note'])" }) }
                    'long_result' {
                        $filler = ('lorem ipsum dolor sit amet ' * 11112).Substring(0, 299950)
                        @([ordered]@{ type = 'text'; text = $filler + ' The code word is ZEBRA-4417.' })
                    }
                    default { $null }
                }
                $line = ConvertTo-Json -Compress -Depth 20 -InputObject ([ordered]@{ name = $name; arguments = $arguments; started = $started.ToString('o'); ended = [DateTime]::UtcNow.ToString('o') })
                [System.Threading.Monitor]::Enter($Shared.Lock)
                try { [System.IO.File]::AppendAllText($Shared.CallsLog, $line + "`n") } finally { [System.Threading.Monitor]::Exit($Shared.Lock) }
                $result = if ($null -eq $content) {
                    [ordered]@{ content = @([ordered]@{ type = 'text'; text = "There is no tool named `"$name`" in this session." }); isError = $true }
                } else { [ordered]@{ content = @($content); isError = $false } }
                Send 200 (ConvertTo-Json -Compress -Depth 20 -InputObject ([ordered]@{ jsonrpc = '2.0'; id = $message['id']; result = $result }))
            }
            default { Send 200 ('{"jsonrpc":"2.0","id":' + $id + ',"error":{"code":-32601,"message":"Method not found"}}') }
        }
    } catch {
        try { $response.StatusCode = 500; $response.Close() } catch { }
    }
}

$shared = [hashtable]::Synchronized(@{ Key = $Key; Token = $Token; List = $listJson; Picture = $picture; CallsLog = $CallsLog; Lock = [object]::new() })
$pool = [runspacefactory]::CreateRunspacePool(4, 16)
$pool.Open()
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
[Console]::Out.WriteLine("listening http://127.0.0.1:$Port/mcp/$Key")
while ($listener.IsListening) {
    $context = $listener.GetContext()
    $worker = [powershell]::Create()
    $worker.RunspacePool = $pool
    [void]$worker.AddScript($handler).AddArgument($context).AddArgument($shared)
    [void]$worker.BeginInvoke()
}
