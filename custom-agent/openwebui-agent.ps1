#Requires -Version 7.5
<#
.SYNOPSIS
Open WebUI as a Slidr agent and image provider, through the custom agent CLI protocol, version 1
(docs/custom-agent-cli.md of the app's repository).

.DESCRIPTION
Slidr starts it as

    pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File openwebui-agent.ps1 slidr <subcommand>

    describe   what it is and can do; no network
    status     whether the stored API key works now
    models     the models the key can use
    login      a sign-in page in the browser: a password, LDAP, single sign-on or an API key
    turn       one turn of the chat: a TurnRequest on standard input, agent events out
    image      one image: an ImageRequest on standard input, one result line out

Standard output carries JSON Lines only. Text for people goes to standard error.
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
Set-StrictMode -Version 3.0

$script:CliVersion = '0.1.0'
$script:McpVersion = '2026-07-28'
$script:DefaultUrl = 'http://localhost:8082'
# A turn ends with an error rather than run on for ever.
$script:MaxSteps = 150
# Images of tool results the model is given again: the latest ones. Older renders are left out of
# the request (not out of the store), so a long session keeps within the model's context.
$script:KeptToolImages = 12
$script:Aspects = '16:9', '4:3', '1:1', '3:4', '9:16'
# OpenAI's models that are not for chat, or not for Chat Completions (`-pro`, `codex`, deep research).
$script:NotChatModels = '(?i)transcribe|realtime|audio|tts|whisper|embed|moderation|dall-e|image|sora|instruct|davinci|babbage|search|deep-research|computer-use|translate|diarize|live|codex|(^|[-.])pro($|-)'
# What the image engines take for each aspect. `free` is for engines that draw any size
# (ComfyUI, Automatic1111): the long side 1408-1536, both sides multiples of 32.
$script:ImageSizes = @{
    'gpt-image' = @{ '16:9' = '1536x1024'; '4:3' = '1536x1024'; '1:1' = '1024x1024'; '3:4' = '1024x1536'; '9:16' = '1024x1536' }
    'dall-e-3'  = @{ '16:9' = '1792x1024'; '4:3' = '1792x1024'; '1:1' = '1024x1024'; '3:4' = '1024x1792'; '9:16' = '1024x1792' }
    'free'      = @{ '16:9' = '1536x864'; '4:3' = '1408x1056'; '1:1' = '1024x1024'; '3:4' = '1056x1408'; '9:16' = '864x1536' }
}
$script:Interrupted = 'This tool call was interrupted: the turn was stopped before it returned. What it did to the deck is unknown; look before calling it again.'
$script:Utf8 = [System.Text.UTF8Encoding]::new($false)
$script:StoreDir = if ($env:SLIDR_OPENWEBUI_HOME) { $env:SLIDR_OPENWEBUI_HOME } elseif ($IsWindows) { Join-Path $env:LOCALAPPDATA 'Slidr Open WebUI agent' } else { Join-Path $HOME '.slidr-openwebui-agent' }
$script:Stdout = [Console]::OpenStandardOutput()
# By port: whether 127.0.0.1 answers for `localhost` (New-Request).
$script:Loopback = @{}
$script:ExitCode = 0

# A failure the protocol has a name for: its kind is one of the subcommand's error kinds. (An
# exception marked in its Data rather than a class, which PowerShell would compile every run.)
function New-Failure([string] $Kind, [string] $Message) {
    $exception = [System.Exception]::new($Message)
    $exception.Data['SlidrKind'] = $Kind
    return $exception
}

# The kind and message of a failure New-Failure made, wherever it is in the chain; `$null` for
# any other error.
function Find-Failure($ErrorRecord) {
    $exception = if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) { $ErrorRecord.Exception } else { $ErrorRecord }
    while ($exception) {
        if ($exception.Data.Contains('SlidrKind')) { return @{ Kind = [string]$exception.Data['SlidrKind']; Message = $exception.Message } }
        $exception = $exception.InnerException
    }
    return $null
}

# The message of what went wrong underneath, for a network failure.
function Get-Cause($ErrorRecord) {
    $exception = if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) { $ErrorRecord.Exception } else { $ErrorRecord }
    $message = $exception.Message
    while ($exception) {
        if ($exception -is [System.TimeoutException]) { return 'it did not answer in time' }
        $message = $exception.Message
        $exception = $exception.InnerException
    }
    return $message
}

#region Output and JSON

function ConvertTo-JsonText($Value) { ConvertTo-Json -InputObject $Value -Depth 100 -Compress -EscapeHandling Default }

function ConvertFrom-JsonText([string] $Text) { ConvertFrom-Json -InputObject $Text -AsHashtable -DateKind String -NoEnumerate }

# One line of the protocol on standard output, whatever the console's code page.
function Write-Line($Value) {
    $bytes = $script:Utf8.GetBytes((ConvertTo-JsonText $Value) + "`n")
    $script:Stdout.Write($bytes, 0, $bytes.Length)
    $script:Stdout.Flush()
}

function Write-Note([string] $Text) { [Console]::Error.WriteLine($Text) }

$script:Clock = [System.Diagnostics.Stopwatch]::StartNew()
# Seconds since the start a subcommand must answer within (status: 15, less the start of
# PowerShell itself); none for the others.
$script:Limit = [double]::PositiveInfinity

# The seconds left of the subcommand's limit, at least 1.
function Get-Budget { [Math]::Max(1.0, $script:Limit - $script:Clock.Elapsed.TotalSeconds) }

# With SLIDR_OPENWEBUI_TRACE=1, what the CLI does and when, on standard error.
function Write-Trace([string] $Text) {
    if ($env:SLIDR_OPENWEBUI_TRACE -eq '1') { [Console]::Error.WriteLine(('[{0,6} ms] {1}' -f $script:Clock.ElapsedMilliseconds, $Text)) }
}

function Read-Request {
    $reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $script:Utf8)
    $text = $reader.ReadToEnd()
    if (-not $text.Trim()) { throw (New-Failure 'invalid_input' 'Standard input is empty: a JSON request was expected.') }
    try { $request = ConvertFrom-JsonText $text }
    catch { throw (New-Failure 'invalid_input' "Standard input is not JSON: $($_.Exception.Message)") }
    if ($request -isnot [System.Collections.IDictionary]) { throw (New-Failure 'invalid_input' 'The request is not a JSON object.') }
    if ($request['protocol'] -ne 1) { throw (New-Failure 'invalid_input' "Protocol $($request['protocol']) is not spoken here: this CLI speaks version 1.") }
    return $request
}

#endregion

#region The store: %LOCALAPPDATA%\Slidr Open WebUI agent

function Get-StorePath([string] $Name) { Join-Path $script:StoreDir $Name }

# Written to a file of its own and renamed over the old one, so a process ended at any instant
# leaves either the old file or the new one.
function Save-JsonFile([string] $Path, $Value) {
    [void][System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($Path))
    $temp = '{0}.{1}.tmp' -f $Path, [guid]::NewGuid().ToString('N')
    $bytes = $script:Utf8.GetBytes((ConvertTo-JsonText $Value))
    $stream = [System.IO.FileStream]::new($temp, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    for ($attempt = 1; ; $attempt++) {
        try {
            [System.IO.File]::Move($temp, $Path, $true)
            return
        } catch {
            # Another process may be reading the old file this moment.
            if ($attempt -ge 6) {
                [System.IO.File]::Delete($temp)
                throw
            }
            Start-Sleep -Milliseconds (40 * $attempt)
        }
    }
}

function Read-JsonFile([string] $Path) {
    if (-not [System.IO.File]::Exists($Path)) { return $null }
    $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
    $stream = [System.IO.FileStream]::new($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share)
    try { $text = [System.IO.StreamReader]::new($stream, $script:Utf8).ReadToEnd() }
    finally { $stream.Dispose() }
    if (-not $text.Trim()) { return $null }
    return ConvertFrom-JsonText $text
}

# The API key is kept encrypted for this Windows account (DPAPI).
function Protect-Secret([string] $Plain) {
    if (-not $IsWindows) { return 'plain:' + $Plain }
    $secure = ConvertTo-SecureString -String $Plain -AsPlainText -Force
    return 'dpapi:' + (ConvertFrom-SecureString -SecureString $secure)
}

function Unprotect-Secret([string] $Stored) {
    if ($Stored.StartsWith('plain:')) { return $Stored.Substring(6) }
    if (-not $Stored.StartsWith('dpapi:')) { throw 'The stored key has no known form.' }
    $secure = ConvertTo-SecureString -String $Stored.Substring(6)
    return [System.Net.NetworkCredential]::new('', $secure).Password
}

function Get-Connection {
    $config = Read-JsonFile (Get-StorePath 'config.json')
    if (-not $config -or -not $config['apiKey'] -or -not $config['url']) {
        throw (New-Failure 'not_logged_in' "Not signed in to Open WebUI: run 'slidr login' (Settings > Sign in).")
    }
    try { $key = Unprotect-Secret ([string]$config['apiKey']) }
    catch { throw (New-Failure 'not_logged_in' 'The stored Open WebUI API key cannot be read by this account: sign in again.') }
    return @{ Url = ([string]$config['url']).TrimEnd('/'); Key = $key }
}

#endregion

#region HTTP

function New-HttpClient([string] $Url, [double] $TimeoutSeconds) {
    $handler = [System.Net.Http.SocketsHttpHandler]::new()
    if (([uri] $Url).IsLoopback) { $handler.UseProxy = $false }
    $client = [System.Net.Http.HttpClient]::new($handler, $true)
    $client.Timeout = [timespan]::FromSeconds($TimeoutSeconds)
    return $client
}

# A request to an address of Open WebUI. `localhost` is tried on ::1 first, and when the server
# listens on 127.0.0.1 only (as Open WebUI's desktop app does) each refused attempt costs Windows
# some 2 seconds: 127.0.0.1 is used when it answers, under the name the address gives.
function New-Request([string] $Method, [string] $Url) {
    $uri = [uri]$Url
    $target = $uri
    if ($uri.Host -eq 'localhost') {
        if (-not $script:Loopback.ContainsKey($uri.Port)) {
            $answers = $false
            $probe = [System.Net.Sockets.TcpClient]::new([System.Net.Sockets.AddressFamily]::InterNetwork)
            try { $answers = $probe.ConnectAsync('127.0.0.1', $uri.Port).Wait(500) -and $probe.Connected } catch { }
            finally { $probe.Dispose() }
            $script:Loopback[$uri.Port] = $answers
        }
        if ($script:Loopback[$uri.Port]) {
            $builder = [System.UriBuilder]::new($uri)
            $builder.Host = '127.0.0.1'
            $target = $builder.Uri
        }
    }
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $target)
    if (-not [object]::ReferenceEquals($target, $uri)) { $request.Headers.Host = $uri.Authority }
    return $request
}

function New-JsonContent([string] $Json) {
    $content = [System.Net.Http.ByteArrayContent]::new($script:Utf8.GetBytes($Json))
    $content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::new('application/json')
    return $content
}

function Get-MediaType($Response) {
    $type = $Response.Content.Headers.ContentType
    if ($type) { return [string]$type.MediaType }
    return ''
}

# One request to Open WebUI, read whole. A request that does not get through is a `network`
# failure; any status is returned to the caller.
function Invoke-WebUI {
    param(
        [hashtable] $Conn,
        [string] $Method,
        [string] $Path,
        [string] $Json,
        [double] $TimeoutSeconds = 30,
        [string] $Token
    )
    $url = if ($Path -match '^https?://') { $Path } else { $Conn.Url + $Path }
    $client = New-HttpClient $url $TimeoutSeconds
    try {
        $request = New-Request $Method $url
        $bearer = if ($Token) { $Token } else { $Conn.Key }
        # The key goes to Open WebUI's own address only.
        if ($bearer -and $url.StartsWith($Conn.Url + '/')) {
            $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $bearer)
        }
        if ($Json) { $request.Content = New-JsonContent $Json }
        $clock = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            $response = $client.SendAsync($request).GetAwaiter().GetResult()
            $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        } catch {
            Write-Trace "$Method $Path failed after $($clock.ElapsedMilliseconds) ms"
            throw (New-Failure 'network' ('Open WebUI at {0} could not be reached: {1}' -f $Conn.Url, (Get-Cause $_)))
        }
        Write-Trace "$Method $Path $([int]$response.StatusCode) in $($clock.ElapsedMilliseconds) ms"
        $mediaType = Get-MediaType $response
        return @{
            Status    = [int]$response.StatusCode
            Ok        = $response.IsSuccessStatusCode
            MediaType = $mediaType
            Bytes     = $bytes
            Text      = if ($mediaType.StartsWith('image/')) { '' } else { $script:Utf8.GetString($bytes) }
        }
    } finally { $client.Dispose() }
}

# What Open WebUI said went wrong, from its JSON error body or the text itself.
function Get-ErrorText([string] $Text) {
    $body = $null
    try { $body = ConvertFrom-JsonText $Text } catch { }
    if ($body -is [System.Collections.IDictionary]) {
        foreach ($key in 'detail', 'error', 'message') {
            $value = $body[$key]
            if ($value -is [string] -and $value) { return $value }
            if ($value -is [System.Collections.IDictionary] -and $value['message']) { return [string]$value['message'] }
            if ($value -is [array] -and $value.Count) {
                $parts = foreach ($item in $value) { if ($item -is [System.Collections.IDictionary]) { [string]$item['msg'] } else { [string]$item } }
                return $parts -join '; '
            }
        }
    }
    $plain = ($Text -replace '\s+', ' ').Trim()
    if ($plain.Length -gt 500) { $plain = $plain.Substring(0, 500) + '...' }
    if (-not $plain) { $plain = 'no details' }
    return $plain
}

function Get-Json([hashtable] $Response) {
    try { return ConvertFrom-JsonText $Response.Text }
    catch { return $null }
}

#endregion

#region Open WebUI: the account, the server, the models

# What describe and the image runs need to know about the server, kept from the last status,
# models or login, since describe may not use the network.
function Update-ServerCache([hashtable] $Conn) {
    $cache = Read-JsonFile (Get-StorePath 'server.json')
    if (-not $cache) { $cache = [ordered]@{} }
    $cache['checkedAt'] = [DateTime]::UtcNow.ToString('o')
    if ((Get-Budget) -lt 2) {
        Write-Trace 'no time left to read the server settings'
        return $cache
    }
    try {
        # `/api/config` says more to a sign-in's session than to an API key, which it does not
        # read: what a session told is kept, and a key's request falls back to what anyone reads.
        $config = Invoke-WebUI $Conn GET '/api/config' -TimeoutSeconds ([Math]::Min(4.0, (Get-Budget)))
        if (-not $config.Ok) { $config = Invoke-WebUI @{ Url = $Conn.Url; Key = '' } GET '/api/config' -TimeoutSeconds ([Math]::Min(4.0, (Get-Budget))) }
        $body = if ($config.Ok) { Get-Json $config } else { $null }
        if ($body -is [System.Collections.IDictionary] -and $body.Contains('default_models')) {
            $cache['version'] = $body['version']
            $cache['defaultModels'] = $body['default_models']
            $features = $body['features']
            if ($features -is [System.Collections.IDictionary] -and $features.Contains('enable_image_generation')) {
                $cache['imageGeneration'] = [bool]$features['enable_image_generation']
            }
        } elseif ($body -is [System.Collections.IDictionary]) {
            $cache['version'] = $body['version']
        }
        # An admin's key also reads the image settings.
        $images = Invoke-WebUI $Conn GET '/api/v1/images/config' -TimeoutSeconds ([Math]::Min(4.0, (Get-Budget)))
        $body = if ($images.Ok) { Get-Json $images } else { $null }
        if ($body -is [System.Collections.IDictionary]) {
            $cache['imageGeneration'] = [bool]$body['ENABLE_IMAGE_GENERATION']
            $cache['imageEdit'] = [bool]$body['ENABLE_IMAGE_EDIT']
            $cache['imageEngine'] = $body['IMAGE_GENERATION_ENGINE']
            $cache['imageModel'] = $body['IMAGE_GENERATION_MODEL']
            $cache['imageEditEngine'] = $body['IMAGE_EDIT_ENGINE']
            $cache['imageEditModel'] = $body['IMAGE_EDIT_MODEL']
        }
        Save-JsonFile (Get-StorePath 'server.json') $cache
    } catch {
        Write-Note "The server's settings were not read: $($_.Exception.Message)"
    }
    return $cache
}

function Assert-Accepted([hashtable] $Response, [string] $What) {
    if ($Response.Status -eq 401 -or ($Response.Status -eq 403 -and (Get-ErrorText $Response.Text) -match 'api key|not authenticated|token|credential')) {
        throw (New-Failure 'not_logged_in' "Open WebUI refused the API key while reading $What ($($Response.Status)): $(Get-ErrorText $Response.Text). Sign in again.")
    }
}

# The models of `/api/models`, for the picker, and the one used when none is chosen.
function Get-ModelList([hashtable] $Conn) {
    $response = Invoke-WebUI $Conn GET '/api/models' -TimeoutSeconds 50
    Assert-Accepted $response 'the models'
    if (-not $response.Ok) { throw (New-Failure 'turn_failed' "Open WebUI did not list its models ($($response.Status)): $(Get-ErrorText $response.Text)") }
    $body = Get-Json $response
    $models = [System.Collections.Generic.List[object]]::new()
    foreach ($model in @($body['data'] | Where-Object { $_ })) {
        $id = [string]$model['id']
        if (-not $id -or $id.StartsWith('-') -or $model['arena']) { continue }
        $info = $model['info']
        if ($info -is [System.Collections.IDictionary] -and $info['meta'] -is [System.Collections.IDictionary] -and $info['meta']['hidden']) { continue }
        # A connection to OpenAI lists all its models: those that are no chat model, or answer
        # through the Responses API only, cannot run a turn.
        if ($model['owned_by'] -eq 'openai' -and $id -match $script:NotChatModels) { continue }
        $option = [ordered]@{ id = $id; label = if ($model['name']) { [string]$model['name'] } else { $id } }
        # OpenAI's reasoning models take `reasoning_effort`, which Open WebUI passes on.
        if ($id -match '(^|[/:.])(o[1-9]|gpt-5)' -and $id -notmatch 'chat-latest') { $option['effortLevels'] = @('low', 'medium', 'high') }
        $models.Add($option)
    }
    if (-not $models.Count) { throw (New-Failure 'turn_failed' 'Open WebUI offers this account no models: an admin connects a provider or gives the account access to one.') }
    $cache = Update-ServerCache $Conn
    $default = $null
    foreach ($wanted in ([string]$cache['defaultModels']).Split(',', [System.StringSplitOptions]::RemoveEmptyEntries)) {
        if ($models | Where-Object { $_['id'] -eq $wanted.Trim() }) {
            $default = $wanted.Trim()
            break
        }
    }
    if (-not $default) {
        # Without a default of the server's: the newest of OpenAI's plain `gpt-N.N`, else the first
        # by name, since Open WebUI lists its models in no fixed order.
        $plain = $models | Where-Object { $_['id'] -match '^gpt-\d+(\.\d+)?$' } |
            Sort-Object { [version]$(if ($_['id'] -match '\.') { $_['id'].Substring(4) } else { $_['id'].Substring(4) + '.0' }) } -Descending |
            Select-Object -First 1
        $default = if ($plain) { $plain['id'] } else { ($models | Sort-Object { $_['id'] } | Select-Object -First 1)['id'] }
    }
    $cache['defaultModel'] = $default
    try { Save-JsonFile (Get-StorePath 'server.json') $cache } catch { }
    return @{ Models = $models; Default = $default }
}

function Get-DefaultModel([hashtable] $Conn) {
    $cache = Read-JsonFile (Get-StorePath 'server.json')
    if ($cache -and $cache['defaultModel']) { return [string]$cache['defaultModel'] }
    return (Get-ModelList $Conn).Default
}

#endregion

#region describe, status, models, login

function Invoke-Describe {
    $cache = Read-JsonFile (Get-StorePath 'server.json')
    $images = [ordered]@{ edit = 'regenerate'; mask = $false; quality = $false; maxParallel = 2 }
    if ($cache -and $cache['imageGeneration'] -eq $false) { $images = $null }
    elseif ($cache -and $cache['imageEdit'] -eq $false) { $images['edit'] = 'none' }
    Write-Line ([ordered]@{
            protocol = @(1)
            name     = 'Open WebUI'
            version  = $script:CliVersion
            glyph    = 'OW'
            agent    = [ordered]@{
                capabilities = [ordered]@{ streaming = $true; imageInput = $true; thinking = $true }
                builtinTools = @()
            }
            images   = $images
        })
}

function Invoke-Status {
    $status = [ordered]@{ state = 'ready'; account = $null; detail = $null }
    $script:Limit = 11
    try {
        $conn = Get-Connection
        # An endpoint that takes an API key (`/api/v1/auths/` takes a sign-in's session only).
        $response = Invoke-WebUI $conn GET '/api/v1/users/user/info' -TimeoutSeconds ([Math]::Min(6.0, (Get-Budget)))
        Assert-Accepted $response 'the account'
        if (-not $response.Ok) { throw (New-Failure 'unavailable' "Open WebUI at $($conn.Url) answered $($response.Status): $(Get-ErrorText $response.Text)") }
        $cache = Update-ServerCache $conn
        $config = Read-JsonFile (Get-StorePath 'config.json')
        $parts = @('API key')
        if ($config -and $config['role']) { $parts += [string]$config['role'] }
        if ($cache['version']) { $parts += "Open WebUI $($cache['version'])" }
        $status['account'] = $parts -join ', '
    } catch {
        $failure = Find-Failure $_
        $status['state'] = if ($failure -and $failure.Kind -eq 'not_logged_in') { 'not_logged_in' } else { 'unavailable' }
        $status['detail'] = if ($failure -and $failure.Kind -eq 'network') {
            "$($failure.Message.TrimEnd('.')). Start Open WebUI, or sign in again to name another address."
        } else { $_.Exception.Message }
    }
    Write-Line $status
}

function Invoke-Models {
    try {
        $list = Get-ModelList (Get-Connection)
        Write-Line ([ordered]@{ models = $list.Models; default = $list.Default })
    } catch {
        $failure = Find-Failure $_
        $kind = if ($failure) { $failure.Kind } else { 'turn_failed' }
        Write-Line ([ordered]@{ type = 'error'; kind = $kind; message = $_.Exception.Message })
        $script:ExitCode = 1
    }
}

# The address of an Open WebUI without a trailing slash; `$null` when it is not http or https.
function ConvertTo-SiteUrl([string] $Url) {
    $parsed = $null
    if (-not $Url -or -not [uri]::TryCreate($Url.Trim(), [System.UriKind]::Absolute, [ref]$parsed) -or $parsed.Scheme -notin 'http', 'https') { return $null }
    return $parsed.GetLeftPart([System.UriPartial]::Path).TrimEnd('/')
}

# How the Open WebUI at an address lets people sign in, from its public settings.
function Get-SiteOptions([string] $Url) {
    $site = ConvertTo-SiteUrl $Url
    if (-not $site) { return @{ ok = $false; code = 'not_webui'; message = "'$Url' is not an http or https address." } }
    $response = Invoke-WebUI @{ Url = $site; Key = '' } GET '/api/config' -TimeoutSeconds 8
    $body = if ($response.Ok) { Get-Json $response } else { $null }
    if ($body -isnot [System.Collections.IDictionary] -or $body['features'] -isnot [System.Collections.IDictionary]) {
        return @{ ok = $false; code = 'not_webui'; message = "$site answered $($response.Status), not as Open WebUI." }
    }
    $features = $body['features']
    $providers = [System.Collections.Generic.List[object]]::new()
    $oauth = $body['oauth']
    if ($oauth -is [System.Collections.IDictionary] -and $oauth['providers'] -is [System.Collections.IDictionary]) {
        foreach ($id in @($oauth['providers'].Keys)) { $providers.Add([ordered]@{ id = [string]$id; name = [string]$oauth['providers'][$id] }) }
    }
    return [ordered]@{
        ok        = $true
        url       = $site
        name      = if ($body['name']) { [string]$body['name'] } else { 'Open WebUI' }
        version   = [string]$body['version']
        auth      = $features['auth'] -ne $false
        password  = [bool]$features['enable_login_form']
        ldap      = [bool]$features['enable_ldap']
        providers = $providers
    }
}

# Checks a key against Open WebUI and keeps it, with the address, for this account. A sign-in's
# session token, when there is one, reads the server's settings the key cannot.
function Save-Key([string] $Url, [string] $Key, [string] $Token, [string] $Role) {
    $site = ConvertTo-SiteUrl $Url
    if (-not $site -or -not $Key) { return @{ ok = $false; code = 'bad_key'; message = 'An address and a key are needed.' } }
    $conn = @{ Url = $site; Key = $Key }
    $check = Invoke-WebUI $conn GET '/api/v1/users/user/info'
    if (-not $check.Ok) { return @{ ok = $false; code = 'bad_key'; message = "Open WebUI answered $($check.Status): $(Get-ErrorText $check.Text)" } }
    $path = Get-StorePath 'config.json'
    $config = [ordered]@{ url = $site; apiKey = (Protect-Secret $Key); savedAt = [DateTime]::UtcNow.ToString('o') }
    if ($Role) { $config['role'] = $Role }
    Save-JsonFile $path $config
    if (-not $IsWindows) { & chmod 600 -- $path }
    # What was known of another server is not this one's.
    [System.IO.File]::Delete((Get-StorePath 'server.json'))
    $null = Update-ServerCache @{ Url = $site; Key = $(if ($Token) { $Token } else { $Key }) }
    return @{ ok = $true; url = $site }
}

# The account's API key from the token of a sign-in: the key it has, or a new one when it has
# none (a new key would replace the one other tools may use).
function Get-AccountKey([hashtable] $Conn, [string] $Token) {
    $refused = @{ ok = $false; code = 'no_keys'; message = 'Open WebUI does not let this account use API keys.' }
    $existing = Invoke-WebUI $Conn GET '/api/v1/auths/api_key' -Token $Token
    if ($existing.Status -in 401, 403) { return $refused }
    $body = if ($existing.Ok) { Get-Json $existing } else { $null }
    $key = if ($body -is [System.Collections.IDictionary]) { [string]$body['api_key'] } else { '' }
    if (-not $key) {
        $created = Invoke-WebUI $Conn POST '/api/v1/auths/api_key' -Token $Token
        if ($created.Status -in 401, 403) { return $refused }
        $body = if ($created.Ok) { Get-Json $created } else { $null }
        $key = if ($body -is [System.Collections.IDictionary]) { [string]$body['api_key'] } else { '' }
        if (-not $key) { return @{ ok = $false; code = 'failed'; message = "Open WebUI did not make an API key ($($created.Status)): $(Get-ErrorText $created.Text)" } }
    }
    return @{ ok = $true; key = $key }
}

# One way of signing in, as the sign-in page sends it: a password, LDAP, an Open WebUI that asks
# for no sign-in, or the code of a second step. The password goes to Open WebUI and nowhere else.
function Invoke-SignIn([System.Collections.IDictionary] $Form) {
    $site = ConvertTo-SiteUrl ([string]$Form['url'])
    if (-not $site) { return @{ ok = $false; code = 'not_webui'; message = 'The address is not an http or https address.' } }
    $conn = @{ Url = $site; Key = '' }
    $method = [string]$Form['method']
    if ($method -eq 'password') { $path = '/api/v1/auths/signin'; $body = [ordered]@{ email = [string]$Form['email']; password = [string]$Form['password'] } }
    elseif ($method -eq 'ldap') { $path = '/api/v1/auths/ldap'; $body = [ordered]@{ user = [string]$Form['user']; password = [string]$Form['password'] } }
    elseif ($method -eq 'open') { $path = '/api/v1/auths/signin'; $body = [ordered]@{ email = ''; password = '' } }
    elseif ($method -eq 'mfa') { $path = '/api/v1/auths/mfa/verify'; $body = [ordered]@{ challenge_token = [string]$Form['challenge']; code = [string]$Form['code']; recovery = [bool]$Form['recovery'] } }
    else { return @{ ok = $false; code = 'failed'; message = "Unknown way of signing in '$method'." } }
    $response = Invoke-WebUI $conn POST $path (ConvertTo-JsonText $body)
    if (-not $response.Ok) {
        $code = if ($method -eq 'mfa') { 'mfa_refused' } else { 'refused' }
        return @{ ok = $false; code = $code; message = (Get-ErrorText $response.Text) }
    }
    $user = Get-Json $response
    if ($user -isnot [System.Collections.IDictionary]) { return @{ ok = $false; code = 'refused'; message = 'Open WebUI answered the sign-in without a session.' } }
    $next = [string]$user['next_step']
    if ($next -in 'pending', 'enroll') { return @{ ok = $false; code = $next } }
    if ($next -in 'verify', 'recover') { return @{ ok = $false; mfa = $true; recovery = ($next -eq 'recover'); challenge = [string]$user['challenge_token'] } }
    $token = [string]$user['token']
    if (-not $token) { return @{ ok = $false; code = 'refused'; message = 'Open WebUI answered the sign-in without a session.' } }
    try {
        $key = Get-AccountKey $conn $token
        if (-not $key.ok) { return $key }
        return Save-Key $site $key.key $token ([string]$user['role'])
    } finally {
        # The key is what is kept; the session ends here.
        try { $null = Invoke-WebUI $conn POST '/api/v1/auths/signout' -Token $token -TimeoutSeconds 5 } catch { }
    }
}

function Read-HttpRequest([System.Net.Sockets.NetworkStream] $Stream) {
    $data = [System.IO.MemoryStream]::new()
    $buffer = [byte[]]::new(16384)
    $end = -1
    while ($end -lt 0) {
        $read = $Stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0 -or $data.Length + $read -gt 1MB) { return $null }
        $data.Write($buffer, 0, $read)
        $end = [System.Text.Encoding]::ASCII.GetString($data.GetBuffer(), 0, [int]$data.Length).IndexOf("`r`n`r`n")
    }
    $head = [System.Text.Encoding]::ASCII.GetString($data.GetBuffer(), 0, $end) -split "`r`n"
    $first = $head[0].Split(' ')
    if ($first.Count -lt 3) { return $null }
    $headers = @{}
    foreach ($line in ($head | Select-Object -Skip 1)) {
        $colon = $line.IndexOf(':')
        if ($colon -gt 0) { $headers[$line.Substring(0, $colon).Trim()] = $line.Substring($colon + 1).Trim() }
    }
    $length = 0
    if ($headers['Content-Length'] -and -not [int]::TryParse($headers['Content-Length'], [ref]$length)) { return $null }
    if ($length -lt 0 -or $length -gt 1MB) { return $null }
    while ($data.Length - ($end + 4) -lt $length) {
        $read = $Stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { return $null }
        $data.Write($buffer, 0, $read)
    }
    return @{
        Method  = $first[0]
        Target  = $first[1]
        Headers = $headers
        Body    = $script:Utf8.GetString($data.GetBuffer(), $end + 4, $length)
    }
}

function Send-HttpResponse([System.Net.Sockets.NetworkStream] $Stream, [int] $Status, [string] $Type, [string] $Body, [string] $Policy) {
    $reason = switch ($Status) { 200 { 'OK' } 403 { 'Forbidden' } 404 { 'Not Found' } default { 'Bad Request' } }
    $bytes = $script:Utf8.GetBytes($Body)
    $head = "HTTP/1.1 $Status $reason`r`nContent-Type: $Type`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-store`r`n" +
        "X-Content-Type-Options: nosniff`r`nReferrer-Policy: no-referrer`r`nX-Frame-Options: DENY`r`nConnection: close`r`n"
    if ($Policy) { $head += "Content-Security-Policy: $Policy`r`n" }
    $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head + "`r`n")
    $Stream.Write($headBytes, 0, $headBytes.Length)
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush()
}

# One request to the sign-in page's server. Returns the outcome once the account is signed in.
function Invoke-LoginRequest([System.Net.Sockets.NetworkStream] $Stream, [hashtable] $Server) {
    $request = Read-HttpRequest $Stream
    if (-not $request) { return $null }
    # Only by its own name, so that no other site reaches it through a name of its own (DNS rebinding).
    if ($request.Headers['Host'] -ne $Server.Host) { Send-HttpResponse $Stream 403 'text/plain' 'Forbidden'; return $null }
    $prefix = "/$($Server.Secret)/"
    $path = $request.Target.Split('?')[0]
    if (-not $path.StartsWith($prefix)) { Send-HttpResponse $Stream 404 'text/plain' 'Not Found'; return $null }
    $route = $path.Substring($prefix.Length)
    if ($route -eq '' -and $request.Method -eq 'GET') {
        $nonce = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(18))
        $state = (ConvertTo-JsonText ([ordered]@{ url = $Server.Suggested })).Replace('<', '<')
        $policy = "default-src 'none'; script-src 'nonce-$nonce'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        Send-HttpResponse $Stream 200 'text/html; charset=utf-8' $Server.Page.Replace('{{STATE}}', $state).Replace('{{NONCE}}', $nonce) $policy
        return $null
    }
    if ($request.Method -ne 'POST' -or $route -notin 'options', 'signin', 'key') { Send-HttpResponse $Stream 404 'text/plain' 'Not Found'; return $null }
    # Only the page itself calls these (a page of another site sends its own Origin).
    if ($request.Headers['Origin'] -ne $Server.Origin -or -not ([string]$request.Headers['Content-Type']).StartsWith('application/json')) {
        Send-HttpResponse $Stream 403 'text/plain' 'Forbidden'
        return $null
    }
    $form = $null
    try { $form = ConvertFrom-JsonText $request.Body } catch { }
    if ($form -isnot [System.Collections.IDictionary]) { Send-HttpResponse $Stream 400 'text/plain' 'Bad Request'; return $null }
    try {
        $result = switch ($route) {
            'options' { Get-SiteOptions ([string]$form['url']) }
            'signin' { Invoke-SignIn $form }
            'key' { Save-Key ([string]$form['url']) ([string]$form['key']) }
        }
    } catch {
        $failure = Find-Failure $_
        $code = if ($failure -and $failure.Kind -eq 'network') { 'unreachable' } else { 'failed' }
        $result = @{ ok = $false; code = $code; message = $_.Exception.Message }
    }
    Send-HttpResponse $Stream 200 'application/json; charset=utf-8' (ConvertTo-JsonText $result)
    if ($route -ne 'options' -and $result['ok']) { return $result }
    return $null
}

# Signing in in the browser: a page of this process on 127.0.0.1, under a path no other page can
# guess, offers what the Open WebUI allows (a password, LDAP, single sign-on, or a key pasted).
function Invoke-BrowserLogin([string] $Suggested) {
    $page = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'login.html'), $script:Utf8)
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try {
        $hostName = "127.0.0.1:$($listener.LocalEndpoint.Port)"
        $server = @{ Host = $hostName; Origin = "http://$hostName"; Secret = [guid]::NewGuid().ToString('N'); Page = $page; Suggested = $Suggested }
        $address = "$($server.Origin)/$($server.Secret)/"
        Write-Note "Sign in to Open WebUI in the browser: $address"
        if ($env:SLIDR_OPENWEBUI_BROWSER -ne '0') {
            try { Start-Process $address } catch { Write-Note 'The browser did not open: open the address above in it.' }
        }
        # The app waits 10 minutes for a sign-in.
        $deadline = [DateTime]::UtcNow.AddMinutes(9.5)
        $outcome = $null
        while (-not $outcome -and [DateTime]::UtcNow -lt $deadline) {
            if (-not $listener.Pending()) {
                Start-Sleep -Milliseconds 100
                continue
            }
            $client = $listener.AcceptTcpClient()
            try {
                $client.ReceiveTimeout = 5000
                $client.SendTimeout = 5000
                $outcome = Invoke-LoginRequest $client.GetStream() $server
            } catch {
                Write-Note "A request of the sign-in page failed: $($_.Exception.Message)"
            } finally { $client.Dispose() }
        }
        if (-not $outcome) { return @{ ok = $false; message = 'No sign-in within 10 minutes.' } }
        return $outcome
    } finally { $listener.Stop() }
}

# For scripts: lines on standard input, the address and an API key, or the address, an empty
# line, an e-mail and a password.
function Invoke-ScriptedLogin([string] $Suggested) {
    $lines = @([Console]::In.ReadToEnd() -split '\r?\n') + @('', '', '', '')
    $url = if ($lines[0].Trim()) { $lines[0].Trim() } else { $Suggested }
    if ($lines[1].Trim()) { return Save-Key $url $lines[1].Trim() }
    return Invoke-SignIn ([ordered]@{ url = $url; method = 'password'; email = $lines[2].Trim(); password = $lines[3] })
}

function Invoke-Login {
    $saved = Read-JsonFile (Get-StorePath 'config.json')
    $suggested = if ($saved -and $saved['url']) { [string]$saved['url'] } else { $script:DefaultUrl }
    try {
        $result = if ($env:SLIDR_OPENWEBUI_LOGIN -eq 'stdin') { Invoke-ScriptedLogin $suggested } else { Invoke-BrowserLogin $suggested }
    } catch {
        $result = @{ ok = $false; message = $_.Exception.Message }
    }
    if ($result['ok']) {
        Write-Note "Signed in to Open WebUI at $($result['url']). The API key is kept, encrypted for this account, in $script:StoreDir."
        return
    }
    $why = @($result['code'], $result['message'] | Where-Object { $_ }) -join ': '
    Write-Note "Not signed in: $why"
    $script:ExitCode = 1
}

#endregion

#region The app's tools: the Deck API over MCP (Streamable HTTP, protocol 2026-07-28)

function Get-McpMeta {
    ConvertTo-JsonText ([ordered]@{
            'io.modelcontextprotocol/protocolVersion'    = $script:McpVersion
            'io.modelcontextprotocol/clientCapabilities' = [ordered]@{}
        })
}

# Starts one request to the tool endpoint: each stands alone, its version and method in its
# headers and its `_meta`. Returns the task of the HTTP exchange.
function Start-McpRequest([hashtable] $Tools, [string] $Method, [string] $Name, [string] $ParamsJson, [System.Threading.CancellationToken] $Cancel = [System.Threading.CancellationToken]::None) {
    $Tools.NextId++
    $json = '{{"jsonrpc":"2.0","id":{0},"method":{1},"params":{2}}}' -f $Tools.NextId, (ConvertTo-JsonText $Method), $ParamsJson
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $Tools.Url)
    $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Tools.Token)
    [void]$request.Headers.TryAddWithoutValidation('Accept', 'application/json, text/event-stream')
    [void]$request.Headers.TryAddWithoutValidation('MCP-Protocol-Version', $script:McpVersion)
    [void]$request.Headers.TryAddWithoutValidation('Mcp-Method', $Method)
    if ($Name) { [void]$request.Headers.TryAddWithoutValidation('Mcp-Name', $Name) }
    $request.Content = New-JsonContent $json
    return $Tools.Client.SendAsync($request, $Cancel)
}

# The JSON-RPC answer of a response, sent as JSON or as server-sent events.
function Read-McpMessage([string] $MediaType, [string] $Text) {
    $candidates = if ($MediaType -eq 'text/event-stream') {
        foreach ($block in ($Text -split '\r?\n\r?\n')) {
            $lines = foreach ($line in ($block -split '\r?\n')) { if ($line.StartsWith('data:')) { $line.Substring(5).TrimStart() } }
            if ($lines) { $lines -join "`n" }
        }
    } else { $Text }
    $found = $null
    foreach ($candidate in @($candidates)) {
        if (-not $candidate -or -not $candidate.Trim()) { continue }
        try { $message = ConvertFrom-JsonText $candidate } catch { continue }
        if ($message -is [System.Collections.IDictionary] -and ($message.Contains('result') -or $message.Contains('error'))) { $found = $message }
    }
    return $found
}

# The tools of this turn's session, as the model's function definitions. Any failure is
# `tools_unavailable`: the agent does not work on the deck without its tools.
function Connect-Tools($Spec) {
    $url = if ($Spec -is [System.Collections.IDictionary]) { [string]$Spec['url'] } else { '' }
    if (-not $url) { throw (New-Failure 'tools_unavailable' 'The request names no tool endpoint (tools.url).') }
    if (-not $env:SLIDR_MCP_TOKEN) { throw (New-Failure 'tools_unavailable' 'SLIDR_MCP_TOKEN is not set: the tool endpoint cannot be reached without it.') }
    $tools = @{
        Url       = $url
        Token     = $env:SLIDR_MCP_TOKEN
        # A call may take minutes: the bridge waits for the deck up to each tool's own limit.
        Client    = New-HttpClient $url 3600
        NextId    = 0
        Functions = [System.Collections.Generic.List[object]]::new()
    }
    $meta = Get-McpMeta
    $cursor = $null
    do {
        $params = if ($cursor) { '{{"cursor":{0},"_meta":{1}}}' -f (ConvertTo-JsonText $cursor), $meta } else { '{{"_meta":{0}}}' -f $meta }
        $cancel = [System.Threading.CancellationTokenSource]::new([timespan]::FromSeconds(30))
        try {
            $response = (Start-McpRequest $tools 'tools/list' '' $params $cancel.Token).GetAwaiter().GetResult()
            $text = $script:Utf8.GetString($response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
        } catch {
            throw (New-Failure 'tools_unavailable' "The app's tools at $url could not be reached: $(Get-Cause $_)")
        } finally { $cancel.Dispose() }
        $message = Read-McpMessage (Get-MediaType $response) $text
        if (-not $response.IsSuccessStatusCode -or -not $message -or $message['error'] -or $message['result'] -isnot [System.Collections.IDictionary]) {
            $why = if ($message -and $message['error']) { [string]$message['error']['message'] } else { "it answered $([int]$response.StatusCode)" }
            throw (New-Failure 'tools_unavailable' "The app's tools could not be listed: $why")
        }
        foreach ($tool in @($message['result']['tools'] | Where-Object { $_ })) {
            $schema = $tool['inputSchema']
            if ($schema -isnot [System.Collections.IDictionary]) { $schema = [ordered]@{ type = 'object' } }
            if (-not $schema.Contains('properties')) { $schema['properties'] = [ordered]@{} }
            $tools.Functions.Add([ordered]@{
                    type     = 'function'
                    function = [ordered]@{ name = [string]$tool['name']; description = [string]$tool['description']; parameters = $schema }
                })
        }
        $cursor = $message['result']['nextCursor']
    } while ($cursor)
    return $tools
}

# What a finished `tools/call` came to: its text, its images, and whether it failed.
function Read-ToolOutcome([System.Threading.Tasks.Task] $Task) {
    $images = [System.Collections.Generic.List[object]]::new()
    if ($Task.IsFaulted -or $Task.IsCanceled) {
        $cause = if ($Task.Exception) { Get-Cause $Task.Exception } else { 'it was cancelled' }
        return @{ Ok = $false; Text = "The app's tool endpoint could not be reached: $cause"; Images = $images }
    }
    $response = $Task.Result
    try {
        $text = $script:Utf8.GetString($response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
    } catch {
        return @{ Ok = $false; Text = "The app's answer could not be read: $(Get-Cause $_)"; Images = $images }
    }
    $message = Read-McpMessage (Get-MediaType $response) $text
    if (-not $message) {
        return @{ Ok = $false; Text = "The app's tool endpoint answered $([int]$response.StatusCode) without a result."; Images = $images }
    }
    if ($message['error']) {
        $fault = $message['error']
        $why = if ($fault -is [System.Collections.IDictionary]) { [string]$fault['message'] } else { [string]$fault }
        return @{ Ok = $false; Text = $why; Images = $images }
    }
    $result = $message['result']
    $texts = [System.Collections.Generic.List[string]]::new()
    foreach ($block in @($result['content'] | Where-Object { $_ })) {
        switch ([string]$block['type']) {
            'text' { $texts.Add([string]$block['text']) }
            'image' { $images.Add([ordered]@{ mediaType = [string]$block['mimeType']; data = [string]$block['data'] }) }
            'resource' {
                $resource = $block['resource']
                if ($resource -is [System.Collections.IDictionary] -and $resource['text']) { $texts.Add([string]$resource['text']) }
            }
        }
    }
    return @{ Ok = -not [bool]$result['isError']; Text = $texts -join "`n"; Images = $images }
}

#endregion

#region A turn: `slidr turn`

function New-UserMessage([System.Collections.IDictionary] $Request) {
    $text = @($Request['context'], $Request['text'] | Where-Object { $_ }) -join "`n`n"
    $images = @($Request['images'] | Where-Object { $_ })
    if (-not $images.Count) { return [ordered]@{ role = 'user'; content = $text } }
    $parts = [System.Collections.Generic.List[object]]::new()
    if ($text) { $parts.Add([ordered]@{ type = 'text'; text = $text }) }
    foreach ($image in $images) {
        $type = [string]$image['mediaType']
        if ($type -notin 'image/png', 'image/jpeg', 'image/gif', 'image/webp') {
            throw (New-Failure 'invalid_input' "A picture of type '$type' cannot be sent: PNG, JPEG, GIF and WebP can.")
        }
        $parts.Add([ordered]@{ type = 'image_url'; image_url = [ordered]@{ url = "data:$type;base64,$($image['data'])" } })
    }
    return [ordered]@{ role = 'user'; content = $parts }
}

# The request's messages from the stored conversation. Each assistant message with tool calls is
# followed by one result for every call, in the calls' order: a call whose result never came (the
# process was ended) is answered as interrupted, since the model's API refuses a call without a
# result. The images of the results follow in one user message, as tool messages carry text only.
function Build-Messages([string] $SystemPrompt, [System.Collections.Generic.List[object]] $History) {
    $keep = [System.Collections.Generic.HashSet[int]]::new()
    for ($i = $History.Count - 1; $i -ge 0 -and $keep.Count -lt $script:KeptToolImages; $i--) {
        $message = $History[$i]
        if ($message['role'] -eq 'tool' -and $message['images']) { [void]$keep.Add($i) }
    }
    $messages = [System.Collections.Generic.List[object]]::new()
    if ($SystemPrompt) { $messages.Add([ordered]@{ role = 'system'; content = $SystemPrompt }) }
    $i = 0
    while ($i -lt $History.Count) {
        $message = $History[$i]
        $i++
        if ($message['role'] -eq 'tool') { continue }
        if ($message['role'] -ne 'assistant' -or -not $message['tool_calls']) {
            $messages.Add($message)
            continue
        }
        $messages.Add([ordered]@{ role = 'assistant'; content = $message['content']; tool_calls = $message['tool_calls'] })
        $results = [System.Collections.Generic.Dictionary[string, object]]::new()
        while ($i -lt $History.Count -and $History[$i]['role'] -eq 'tool') {
            $results[[string]$History[$i]['tool_call_id']] = @{ Message = $History[$i]; Index = $i }
            $i++
        }
        $pictures = [System.Collections.Generic.List[object]]::new()
        foreach ($call in $message['tool_calls']) {
            $found = $null
            $content = $script:Interrupted
            if ($results.TryGetValue([string]$call['id'], [ref]$found)) {
                $content = $found.Message['content']
                $images = @($found.Message['images'] | Where-Object { $_ })
                if ($images.Count -and $keep.Contains($found.Index)) {
                    $pictures.Add([ordered]@{ type = 'text'; text = "From $($call['id']) ($($call['function']['name'])):" })
                    foreach ($image in $images) {
                        $pictures.Add([ordered]@{ type = 'image_url'; image_url = [ordered]@{ url = "data:$($image['mediaType']);base64,$($image['data'])" } })
                    }
                } elseif ($images.Count) {
                    $content = "$content`n($($images.Count) image(s) of this result are left out to save room. Call the tool again to see them.)"
                }
            }
            $messages.Add([ordered]@{ role = 'tool'; tool_call_id = $call['id']; content = $content })
        }
        if ($pictures.Count) {
            $pictures.Insert(0, [ordered]@{ type = 'text'; text = 'The images the tool calls above returned:' })
            $messages.Add([ordered]@{ role = 'user'; content = $pictures })
        }
    }
    return , $messages
}

function Save-Session([hashtable] $Turn) {
    Save-JsonFile $Turn.Path ([ordered]@{ id = $Turn.Id; model = $Turn.Model; updatedAt = [DateTime]::UtcNow.ToString('o'); messages = $Turn.History })
}

# The model took the first request: from here the conversation exists. A created one is stored
# and announced; a resumed one stores this turn's message.
function Confirm-Accepted([hashtable] $Turn) {
    if ($Turn.Accepted) { return }
    $Turn.Accepted = $true
    Save-Session $Turn
    if (-not $Turn.Resume) { Write-Line ([ordered]@{ type = 'session_started'; sessionId = $Turn.Id; model = $Turn.Model }) }
}

function Get-ModelFailure([int] $Status, [string] $Message) {
    $text = if ($Status) { "Open WebUI answered $Status`: $Message" } else { "The model reported an error: $Message" }
    $kind = 'turn_failed'
    if ($Status -eq 401 -or ($Status -eq 403 -and $Message -match 'api key|not authenticated|token|credential')) { $kind = 'not_logged_in' }
    elseif ($Status -eq 429 -or $Message -match 'quota|rate.?limit|insufficient_quota|credit balance|usage limit') { $kind = 'quota' }
    elseif ($Status -eq 404 -or ($Message -match 'model' -and $Message -match 'not found|does not exist|unknown')) { $kind = 'invalid_input' }
    elseif ($Status -in 408, 502, 503, 504 -or $Message -match 'connection error|cannot connect|could not connect|timed out|unreachable') { $kind = 'network' }
    return New-Failure $kind $text
}

function Add-CallPiece([hashtable] $Reply, [System.Collections.IDictionary] $Piece) {
    $id = [string]$Piece['id']
    $key = if ($null -ne $Piece['index']) { "i$($Piece['index'])" } elseif ($id) { "id$id" } else { $Reply.LastKey }
    if (-not $key) { $key = 'i0' }
    # Some providers number every call of a step 0 and tell them apart by id.
    if ($id -and $Reply.Calls.Contains($key) -and $Reply.Calls[$key].Id -and $Reply.Calls[$key].Id -ne $id) { $key = "$key/$id" }
    if (-not $Reply.Calls.Contains($key)) { $Reply.Calls[$key] = @{ Id = ''; Name = ''; Arguments = [System.Text.StringBuilder]::new() } }
    $Reply.LastKey = $key
    $call = $Reply.Calls[$key]
    if ($id) { $call.Id = $id }
    $function = $Piece['function']
    if ($function -is [System.Collections.IDictionary]) {
        if ($function['name'] -and -not $call.Name) { $call.Name = [string]$function['name'] }
        $arguments = $function['arguments']
        if ($arguments -is [string]) { [void]$call.Arguments.Append($arguments) }
        elseif ($null -ne $arguments) { [void]$call.Arguments.Append((ConvertTo-JsonText $arguments)) }
    }
}

# One event of a connection that Open WebUI runs on OpenAI's Responses API: it passes that
# stream on as it comes. `$true` at its end.
function Add-ResponsesEvent([hashtable] $Reply, [System.Collections.IDictionary] $Data) {
    $type = [string]$Data['type']
    $index = "o$($Data['output_index'])"
    if ($type -eq 'response.output_text.delta') {
        $text = [string]$Data['delta']
        if ($text.Length) {
            [void]$Reply.Content.Append($text)
            Write-Line ([ordered]@{ type = 'text_delta'; text = $text })
        }
    } elseif ($type -in 'response.reasoning_summary_text.delta', 'response.reasoning_text.delta') {
        Write-Line ([ordered]@{ type = 'thinking_delta'; text = [string]$Data['delta'] })
    } elseif ($type -in 'response.output_item.added', 'response.output_item.done') {
        $item = $Data['item']
        if ($item -is [System.Collections.IDictionary] -and $item['type'] -eq 'function_call') {
            if ($type -eq 'response.output_item.done' -and $Reply.Calls.Contains("i$index")) {
                # The whole arguments, in place of the pieces.
                [void]$Reply.Calls["i$index"].Arguments.Clear()
            }
            Add-CallPiece $Reply @{ index = $index; id = [string]$item['call_id']; function = @{ name = [string]$item['name']; arguments = [string]$item['arguments'] } }
        }
    } elseif ($type -eq 'response.function_call_arguments.delta') {
        Add-CallPiece $Reply @{ index = $index; function = @{ arguments = [string]$Data['delta'] } }
    } elseif ($type -in 'response.completed', 'response.incomplete') {
        return $true
    } elseif ($type -in 'response.failed', 'error') {
        $source = if ($Data['response'] -is [System.Collections.IDictionary]) { $Data['response'] } else { $Data }
        throw (Get-ModelFailure 0 (Get-ErrorText (ConvertTo-JsonText $source)))
    }
    return $false
}

# One chunk of the stream; `$true` at its end.
function Add-Chunk([hashtable] $Reply, [string] $Payload) {
    if ($Payload.Trim() -eq '[DONE]') { return $true }
    try { $chunk = ConvertFrom-JsonText $Payload } catch { return $false }
    if ($chunk -isnot [System.Collections.IDictionary]) { return $false }
    if (([string]$chunk['type']).StartsWith('response.') -or $chunk['type'] -eq 'error') { return Add-ResponsesEvent $Reply $chunk }
    if ($chunk['error']) { throw (Get-ModelFailure 0 (Get-ErrorText $Payload)) }
    $choices = $chunk['choices']
    if (-not $choices) { return $false }
    $choice = @($choices)[0]
    $delta = if ($choice['delta']) { $choice['delta'] } else { $choice['message'] }
    if ($delta -is [System.Collections.IDictionary]) {
        foreach ($key in 'reasoning_content', 'reasoning') {
            $thought = $delta[$key]
            if ($thought -is [string] -and $thought) {
                Write-Line ([ordered]@{ type = 'thinking_delta'; text = $thought })
                break
            }
        }
        $text = $delta['content']
        if ($text -is [string] -and $text.Length) {
            [void]$Reply.Content.Append($text)
            Write-Line ([ordered]@{ type = 'text_delta'; text = $text })
        }
        foreach ($piece in @($delta['tool_calls'] | Where-Object { $_ })) { Add-CallPiece $Reply $piece }
    }
    if ($choice['finish_reason']) { $Reply.Finish = [string]$choice['finish_reason'] }
    return $false
}

# One request to the model, its reply streamed out as it comes: text, reasoning and tool calls.
function Invoke-ModelStep([hashtable] $Turn, [string] $Json) {
    $request = New-Request POST ($Turn.Conn.Url + '/api/chat/completions')
    $request.Headers.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $Turn.Conn.Key)
    [void]$request.Headers.TryAddWithoutValidation('Accept', 'text/event-stream')
    $request.Content = New-JsonContent $Json
    try {
        $response = $Turn.Client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    } catch {
        throw (New-Failure 'network' ('Open WebUI at {0} could not be reached: {1}' -f $Turn.Conn.Url, (Get-Cause $_)))
    }
    try {
        if (-not $response.IsSuccessStatusCode) {
            $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            throw (Get-ModelFailure ([int]$response.StatusCode) (Get-ErrorText $text))
        }
        Confirm-Accepted $Turn
        $reply = @{ Content = [System.Text.StringBuilder]::new(); Calls = [ordered]@{}; LastKey = $null; Finish = $null }
        try {
            $reader = [System.IO.StreamReader]::new($response.Content.ReadAsStream(), $script:Utf8)
            if ((Get-MediaType $response) -eq 'application/json') {
                # Not streamed after all: the whole completion at once.
                $body = ConvertFrom-JsonText $reader.ReadToEnd()
                if ($body -is [System.Collections.IDictionary] -and $body['choices']) {
                    $choice = @($body['choices'])[0]
                    $message = $choice['message']
                    $choice['delta'] = $message
                    if ($message -is [System.Collections.IDictionary]) {
                        $index = 0
                        foreach ($call in @($message['tool_calls'] | Where-Object { $_ })) { $call['index'] = $index++ }
                    }
                    [void](Add-Chunk $reply (ConvertTo-JsonText ([ordered]@{ choices = @($choice) })))
                } elseif ($body -is [System.Collections.IDictionary]) {
                    throw (Get-ModelFailure 0 (Get-ErrorText (ConvertTo-JsonText $body)))
                }
                return $reply
            }
            $data = [System.Text.StringBuilder]::new()
            while ($null -ne ($line = $reader.ReadLine())) {
                if ($line.Length -eq 0) {
                    if ($data.Length) {
                        if (Add-Chunk $reply $data.ToString()) { return $reply }
                        [void]$data.Clear()
                    }
                    continue
                }
                if ($line.StartsWith('data:')) {
                    $payload = $line.Substring(5)
                    if ($payload.StartsWith(' ')) { $payload = $payload.Substring(1) }
                    if ($data.Length) { [void]$data.Append("`n") }
                    [void]$data.Append($payload)
                }
            }
            if ($data.Length) { [void](Add-Chunk $reply $data.ToString()) }
            return $reply
        } catch [System.IO.IOException], [System.Net.Http.HttpRequestException] {
            throw (New-Failure 'network' "The connection to Open WebUI broke during the reply: $(Get-Cause $_)")
        }
    } finally { $response.Dispose() }
}

# The step's tool calls with ids unique in the conversation and their arguments read.
function Complete-Calls([hashtable] $Turn, [hashtable] $Reply) {
    $calls = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $Reply.Calls.Values) {
        $id = $entry.Id
        if (-not $id -or $Turn.CallIds.Contains($id)) { $id = 'call_' + [guid]::NewGuid().ToString('N').Substring(0, 24) }
        [void]$Turn.CallIds.Add($id)
        $text = $entry.Arguments.ToString()
        if (-not $text.Trim()) { $text = '{}' }
        $arguments = $null
        $problem = $null
        try { $arguments = ConvertFrom-JsonText $text }
        catch { $problem = "The arguments of $($entry.Name) were not JSON: $($_.Exception.Message) Call it again with a JSON object." }
        if (-not $problem -and $arguments -isnot [System.Collections.IDictionary]) { $problem = "The arguments of $($entry.Name) were not a JSON object. Call it again with one." }
        if (-not $entry.Name) { $problem = 'The tool call named no tool.' }
        if (-not $problem -and $entry.Name -notmatch '^[A-Za-z0-9_.-]+$') { $problem = "There is no tool named '$($entry.Name)'." }
        if ($problem) {
            # Stored as an empty object, so the conversation stays valid for the model's API.
            $text = '{}'
            $arguments = [ordered]@{}
        }
        $calls.Add(@{ Id = $id; Name = $entry.Name; ArgumentsText = $text; Input = $arguments; Problem = $problem; Task = $null })
    }
    return , $calls
}

function Get-Summary([hashtable] $Outcome) {
    $text = ($Outcome.Text -replace '\s+', ' ').Trim()
    if (-not $text -and $Outcome.Images.Count) { $text = "$($Outcome.Images.Count) image(s)" }
    if ($text.Length -gt 300) {
        $cut = if ([char]::IsHighSurrogate($text[298])) { 298 } else { 299 }
        $text = $text.Substring(0, $cut) + [char]0x2026
    }
    return $text
}

function Complete-ToolCall([hashtable] $Turn, [hashtable] $Call, [hashtable] $Outcome) {
    $content = $Outcome.Text
    if (-not $content) { $content = if ($Outcome.Images.Count) { '(The result is the image(s) in the next message.)' } else { '(The tool returned nothing.)' } }
    if (-not $Outcome.Ok) { $content = "The tool failed: $content" }
    $message = [ordered]@{ role = 'tool'; tool_call_id = $Call.Id; name = $Call.Name; content = $content }
    if ($Outcome.Images.Count) { $message['images'] = $Outcome.Images }
    $Turn.History.Add($message)
    Save-Session $Turn
    [void]$Turn.OpenCalls.Remove($Call.Id)
    Write-Line ([ordered]@{ type = 'tool_call_finished'; id = $Call.Id; ok = $Outcome.Ok; summary = (Get-Summary $Outcome) })
}

# Runs the step's calls side by side and reports each as it returns.
function Invoke-ToolCalls([hashtable] $Turn, [System.Collections.Generic.List[object]] $Calls) {
    foreach ($call in $Calls) {
        [void]$Turn.OpenCalls.Add($call.Id)
        Write-Line ([ordered]@{ type = 'tool_call_started'; id = $call.Id; name = $call.Name; source = 'app'; input = $call.Input })
    }
    $none = [System.Collections.Generic.List[object]]::new()
    $running = [System.Collections.Generic.List[object]]::new()
    $meta = Get-McpMeta
    foreach ($call in $Calls) {
        if ($call.Problem) {
            Complete-ToolCall $Turn $call @{ Ok = $false; Text = $call.Problem; Images = $none }
            continue
        }
        if (-not $Turn.Tools) {
            Complete-ToolCall $Turn $call @{ Ok = $false; Text = 'This turn has no app tools.'; Images = $none }
            continue
        }
        $params = '{{"name":{0},"arguments":{1},"_meta":{2}}}' -f (ConvertTo-JsonText $call.Name), $call.ArgumentsText, $meta
        $call.Task = Start-McpRequest $Turn.Tools 'tools/call' $call.Name $params
        $running.Add($call)
    }
    while ($running.Count) {
        $tasks = [System.Threading.Tasks.Task[]]@($running | ForEach-Object { $_.Task })
        $index = [System.Threading.Tasks.Task]::WaitAny($tasks)
        $call = $running[$index]
        $running.RemoveAt($index)
        Complete-ToolCall $Turn $call (Read-ToolOutcome $call.Task)
    }
}

function Invoke-Turn {
    $turn = @{ OpenCalls = [System.Collections.Generic.HashSet[string]]::new(); EffortAs = $null }
    try {
        $request = Read-Request
        $session = $request['session']
        $sessionId = [guid]::Empty
        if ($session -isnot [System.Collections.IDictionary] -or -not [guid]::TryParse([string]$session['id'], [ref]$sessionId)) {
            throw (New-Failure 'invalid_input' 'session.id is not a UUID.')
        }
        $turn.Id = $sessionId.ToString('D')
        $turn.Resume = [bool]$session['resume']
        $turn.Path = Get-StorePath (Join-Path 'sessions' "$($turn.Id).json")
        $turn.Conn = Get-Connection
        $stored = Read-JsonFile $turn.Path
        if (-not $turn.Resume -and $stored) {
            throw (New-Failure 'session_exists' "A conversation $($turn.Id) is already stored.")
        }
        if ($turn.Resume -and -not $stored) {
            throw (New-Failure 'resume_failed' "There is no conversation $($turn.Id) on this computer to continue.")
        }
        $turn.History = [System.Collections.Generic.List[object]]::new()
        $turn.CallIds = [System.Collections.Generic.HashSet[string]]::new()
        if ($stored) {
            foreach ($message in @($stored['messages'] | Where-Object { $_ })) {
                $turn.History.Add($message)
                foreach ($call in @($message['tool_calls'] | Where-Object { $_ })) { [void]$turn.CallIds.Add([string]$call['id']) }
            }
        }
        $turn.Tools = if ($request['tools']) { Connect-Tools $request['tools'] } else { $null }
        $turn.Model = if ($request['model']) { [string]$request['model'] } else { Get-DefaultModel $turn.Conn }
        $turn.Accepted = $false
        # Headers within 10 minutes: a local model may first have to load. The stream itself
        # has no limit; the app ends the process when it must.
        $turn.Client = New-HttpClient $turn.Conn.Url 600
        $turn.History.Add((New-UserMessage $request))

        for ($step = 1; ; $step++) {
            if ($step -gt $script:MaxSteps) {
                throw (New-Failure 'turn_failed' "The turn was stopped after $script:MaxSteps requests to the model.")
            }
            $body = [ordered]@{
                model    = $turn.Model
                messages = (Build-Messages ([string]$request['systemPrompt']) $turn.History)
                stream   = $true
            }
            if ($turn.Tools -and $turn.Tools.Functions.Count) { $body['tools'] = $turn.Tools.Functions }
            if ($request['effort'] -and $turn.EffortAs -eq 'reasoning') { $body['reasoning'] = [ordered]@{ effort = [string]$request['effort'] } }
            elseif ($request['effort']) { $body['reasoning_effort'] = [string]$request['effort'] }
            try {
                $reply = Invoke-ModelStep $turn (ConvertTo-JsonText $body)
            } catch {
                # Open WebUI passes `reasoning_effort` on as it is, and a connection on OpenAI's
                # Responses API takes the effort as `reasoning.effort`.
                $failure = Find-Failure $_
                if (-not ($failure -and $body.Contains('reasoning_effort') -and $failure.Message -match 'reasoning_effort')) { throw }
                $body.Remove('reasoning_effort')
                $body['reasoning'] = [ordered]@{ effort = [string]$request['effort'] }
                $turn.EffortAs = 'reasoning'
                $reply = Invoke-ModelStep $turn (ConvertTo-JsonText $body)
            }
            $calls = Complete-Calls $turn $reply
            if (-not $calls.Count -and -not $reply.Content.Length) { break }
            $assistant = [ordered]@{ role = 'assistant'; content = if ($reply.Content.Length) { $reply.Content.ToString() } else { $null } }
            if ($calls.Count) {
                $assistant['tool_calls'] = @(foreach ($call in $calls) {
                        [ordered]@{ id = $call.Id; type = 'function'; function = [ordered]@{ name = $call.Name; arguments = $call.ArgumentsText } }
                    })
            }
            $turn.History.Add($assistant)
            Save-Session $turn
            if (-not $calls.Count) { break }
            Invoke-ToolCalls $turn $calls
        }
        Write-Line ([ordered]@{ type = 'turn_completed'; outcome = 'completed' })
    } catch {
        $failure = Find-Failure $_
        $kind = if ($failure) { $failure.Kind } else { 'turn_failed' }
        Write-Note "turn: $($_.Exception.Message)"
        foreach ($id in @($turn.OpenCalls)) {
            Write-Line ([ordered]@{ type = 'tool_call_finished'; id = $id; ok = $false; summary = 'The turn ended before the call returned.' })
        }
        Write-Line ([ordered]@{ type = 'error'; kind = $kind; message = $_.Exception.Message })
        Write-Line ([ordered]@{ type = 'turn_completed'; outcome = 'failed' })
        $script:ExitCode = 1
    }
}

#endregion

#region An image: `slidr image`

# The type and size of a PNG, JPEG, WebP or GIF from its first bytes.
function Get-ImageInfo([byte[]] $Bytes) {
    $b = $Bytes
    $n = $b.Length
    if ($n -ge 24 -and $b[0] -eq 0x89 -and $b[1] -eq 0x50 -and $b[2] -eq 0x4E -and $b[3] -eq 0x47) {
        $width = ([int]$b[16] -shl 24) -bor ([int]$b[17] -shl 16) -bor ([int]$b[18] -shl 8) -bor $b[19]
        $height = ([int]$b[20] -shl 24) -bor ([int]$b[21] -shl 16) -bor ([int]$b[22] -shl 8) -bor $b[23]
        return @{ Type = 'image/png'; Ext = 'png'; Width = $width; Height = $height }
    }
    if ($n -ge 4 -and $b[0] -eq 0xFF -and $b[1] -eq 0xD8) {
        $i = 2
        while ($i + 8 -lt $n) {
            if ($b[$i] -ne 0xFF) { $i++; continue }
            $marker = $b[$i + 1]
            if ($marker -eq 0xFF) { $i++; continue }
            if ($marker -eq 0x01 -or ($marker -ge 0xD0 -and $marker -le 0xD8)) { $i += 2; continue }
            if ($marker -ge 0xC0 -and $marker -le 0xCF -and $marker -notin 0xC4, 0xC8, 0xCC) {
                return @{ Type = 'image/jpeg'; Ext = 'jpg'; Height = [int]$b[$i + 5] * 256 + $b[$i + 6]; Width = [int]$b[$i + 7] * 256 + $b[$i + 8] }
            }
            $i += 2 + [int]$b[$i + 2] * 256 + $b[$i + 3]
        }
        return @{ Type = 'image/jpeg'; Ext = 'jpg'; Width = 0; Height = 0 }
    }
    if ($n -ge 30 -and [System.Text.Encoding]::ASCII.GetString($b, 0, 4) -eq 'RIFF' -and [System.Text.Encoding]::ASCII.GetString($b, 8, 4) -eq 'WEBP') {
        $info = @{ Type = 'image/webp'; Ext = 'webp'; Width = 0; Height = 0 }
        switch ([System.Text.Encoding]::ASCII.GetString($b, 12, 4)) {
            'VP8 ' {
                $info.Width = ([int]$b[26] -bor ([int]$b[27] -shl 8)) -band 0x3FFF
                $info.Height = ([int]$b[28] -bor ([int]$b[29] -shl 8)) -band 0x3FFF
            }
            'VP8L' {
                $info.Width = 1 + ((([int]$b[22] -band 0x3F) -shl 8) -bor $b[21])
                $info.Height = 1 + ((([int]$b[24] -band 0x0F) -shl 10) -bor ([int]$b[23] -shl 2) -bor (([int]$b[22] -band 0xC0) -shr 6))
            }
            'VP8X' {
                $info.Width = 1 + ([int]$b[24] -bor ([int]$b[25] -shl 8) -bor ([int]$b[26] -shl 16))
                $info.Height = 1 + ([int]$b[27] -bor ([int]$b[28] -shl 8) -bor ([int]$b[29] -shl 16))
            }
        }
        return $info
    }
    if ($n -ge 10 -and [System.Text.Encoding]::ASCII.GetString($b, 0, 4) -eq 'GIF8') {
        return @{ Type = 'image/gif'; Ext = 'gif'; Width = [int]$b[6] -bor ([int]$b[7] -shl 8); Height = [int]$b[8] -bor ([int]$b[9] -shl 8) }
    }
    return $null
}

# The size to ask the image engine for, when it is known which sizes it takes. `$null`: the
# engine's own (Gemini draws its own shape).
function Get-ImageSize([string] $Aspect, $Cache, [switch] $Edit) {
    $engine = ''
    $model = ''
    if ($Cache) {
        $engine = [string]$(if ($Edit) { $Cache['imageEditEngine'] } else { $Cache['imageEngine'] })
        $model = [string]$(if ($Edit) { $Cache['imageEditModel'] } else { $Cache['imageModel'] })
    }
    if ($engine -eq 'gemini') { return $null }
    if ($model -match 'dall-e-2') { return '1024x1024' }
    $table = if ($model -match 'dall-e-3') { 'dall-e-3' } elseif ($model -match 'gpt-image' -or $engine -eq 'openai') { 'gpt-image' } else { 'free' }
    return $script:ImageSizes[$table][$Aspect]
}

# The listed aspect nearest to a width and height.
function Get-NearestAspect([int] $Width, [int] $Height) {
    if ($Width -le 0 -or $Height -le 0) { return '1:1' }
    $ratio = $Width / $Height
    $best = '1:1'
    $distance = [double]::MaxValue
    foreach ($aspect in $script:Aspects) {
        $sides = $aspect.Split(':')
        $d = [Math]::Abs([Math]::Log($ratio / ([double]$sides[0] / [double]$sides[1])))
        if ($d -lt $distance) { $best = $aspect; $distance = $d }
    }
    return $best
}

function Get-ImageFailure([int] $Status, [string] $Message, [switch] $Edit) {
    $what = if ($Edit) { 'Image editing' } else { 'Image generation' }
    if ($Status -eq 401) { return New-Failure 'not_logged_in' "Open WebUI refused the API key ($Status): $Message. Sign in again." }
    if ($Status -eq 403) {
        $kind = if ($Edit) { 'unsupported' } else { 'generation_failed' }
        return New-Failure $kind "$what is off in Open WebUI, or not allowed for this account: an admin turns it on in Admin Panel > Settings > Images and gives the account the image generation permission. ($Message)"
    }
    if ($Status -eq 429 -or $Message -match 'quota|rate.?limit|billing|credit') { return New-Failure 'quota' "Open WebUI's image engine reached a usage limit: $Message" }
    return New-Failure 'generation_failed' "Open WebUI made no image ($Status): $Message"
}

function Get-Remaining([datetime] $Deadline) { [Math]::Max(5.0, ($Deadline - [DateTime]::UtcNow).TotalSeconds) }

function Invoke-Image {
    try {
        $request = Read-Request
        $operation = [string]$request['operation']
        if ($operation -notin 'generate', 'edit') { throw (New-Failure 'invalid_input' "Unknown operation '$operation': 'generate' or 'edit'.") }
        $aspect = [string]$request['aspect']
        if ($aspect -notin $script:Aspects) { throw (New-Failure 'invalid_input' "Unknown aspect '$aspect': one of $($script:Aspects -join ', ').") }
        $outputDir = [string]$request['outputDir']
        if (-not $outputDir -or -not [System.IO.Path]::IsPathFullyQualified($outputDir) -or -not [System.IO.Directory]::Exists($outputDir)) {
            throw (New-Failure 'invalid_input' 'outputDir is not an existing absolute folder.')
        }
        if ($request['mask']) { throw (New-Failure 'unsupported' 'A mask is not taken: an edit here draws the whole image again.') }
        $conn = Get-Connection
        $cache = Read-JsonFile (Get-StorePath 'server.json')
        # Within the app's 240 seconds, with room to write the image.
        $deadline = [DateTime]::UtcNow.AddSeconds(225)
        $edit = $operation -eq 'edit'
        if ($edit) {
            if ($cache -and $cache['imageEdit'] -eq $false) { throw (New-Failure 'unsupported' 'Image editing is off in Open WebUI (Admin Panel > Settings > Images).') }
            $source = [string]$request['source']
            if (-not $source -or -not [System.IO.File]::Exists($source)) { throw (New-Failure 'invalid_input' 'source is not an existing file.') }
            $instruction = [string]$request['instruction']
            if (-not $instruction.Trim()) { throw (New-Failure 'invalid_input' 'An edit needs an instruction.') }
            $bytes = [System.IO.File]::ReadAllBytes($source)
            $info = Get-ImageInfo $bytes
            if (-not $info) { throw (New-Failure 'invalid_input' 'source is not a PNG, JPEG, WebP or GIF image.') }
            $path = '/api/v1/images/edit'
            $body = [ordered]@{ image = "data:$($info.Type);base64,$([Convert]::ToBase64String($bytes))"; prompt = $instruction; n = 1 }
            $size = Get-ImageSize (Get-NearestAspect $info.Width $info.Height) $cache -Edit
        } else {
            $prompt = [string]$request['prompt']
            if (-not $prompt.Trim()) { throw (New-Failure 'invalid_input' 'A generation needs a prompt.') }
            $path = '/api/v1/images/generations'
            $body = [ordered]@{ prompt = $prompt; n = 1 }
            $size = Get-ImageSize $aspect $cache
        }
        if ($size) { $body['size'] = $size }
        $response = Invoke-WebUI $conn POST $path (ConvertTo-JsonText $body) -TimeoutSeconds (Get-Remaining $deadline)
        if ($response.Status -eq 400 -and $body.Contains('size')) {
            # Its engine may not take that size; Open WebUI does not say which it takes.
            Write-Note "Open WebUI refused the request with size $size ($(Get-ErrorText $response.Text)); asking for its own size."
            $body.Remove('size')
            $response = Invoke-WebUI $conn POST $path (ConvertTo-JsonText $body) -TimeoutSeconds (Get-Remaining $deadline)
        }
        if (-not $response.Ok) { throw (Get-ImageFailure $response.Status (Get-ErrorText $response.Text) -Edit:$edit) }
        $made = Get-Json $response
        $file = if ($made -is [System.Collections.IDictionary]) { $made } elseif ($made -is [System.Collections.IList] -and $made.Count) { $made[0] } else { $null }
        if ($file -isnot [System.Collections.IDictionary] -or -not $file['url']) {
            throw (New-Failure 'generation_failed' 'Open WebUI answered without an image.')
        }
        $download = Invoke-WebUI $conn GET ([string]$file['url']) -TimeoutSeconds (Get-Remaining $deadline)
        if (-not $download.Ok) { throw (New-Failure 'generation_failed' "The image Open WebUI made could not be fetched ($($download.Status)).") }
        $info = Get-ImageInfo $download.Bytes
        if (-not $info -or $info.Type -eq 'image/gif') { throw (New-Failure 'generation_failed' 'Open WebUI made a file that is not a PNG, JPEG or WebP image.') }
        $name = "image.$($info.Ext)"
        [System.IO.File]::WriteAllBytes((Join-Path $outputDir $name), $download.Bytes)
        # Open WebUI keeps every image it makes among the account's files; this one is in
        # the workspace now.
        if ($file['id']) {
            try { $null = Invoke-WebUI $conn DELETE "/api/v1/files/$([uri]::EscapeDataString([string]$file['id']))" -TimeoutSeconds 5 }
            catch { Write-Note "The image was not removed from Open WebUI's files: $($_.Exception.Message)" }
        }
        Write-Line ([ordered]@{ type = 'image'; file = $name; width = $info.Width; height = $info.Height })
    } catch {
        $failure = Find-Failure $_
        $kind = if ($failure -and $failure.Kind -in 'not_logged_in', 'quota', 'generation_failed', 'invalid_input', 'unsupported') { $failure.Kind } else { 'generation_failed' }
        Write-Note "image: $($_.Exception.Message)"
        Write-Line ([ordered]@{ type = 'error'; kind = $kind; message = $_.Exception.Message })
        $script:ExitCode = 1
    }
}

#endregion

function Invoke-Main([string[]] $Arguments) {
    if ($Arguments.Count -ne 2 -or $Arguments[0] -ne 'slidr') {
        Write-Note 'usage: openwebui-agent.ps1 slidr <describe|status|models|login|turn|image>'
        $script:ExitCode = 2
        return
    }
    switch ($Arguments[1]) {
        'describe' { Invoke-Describe }
        'status' { Invoke-Status }
        'models' { Invoke-Models }
        'login' { Invoke-Login }
        'turn' { Invoke-Turn }
        'image' { Invoke-Image }
        default {
            Write-Note "Unknown subcommand '$($Arguments[1])'."
            $script:ExitCode = 2
        }
    }
}

try {
    # Only Write-Line reaches standard output; anything else a command leaves is dropped.
    $null = Invoke-Main @($args)
} catch {
    Write-Note $_.Exception.Message
    $script:ExitCode = 1
}
Write-Trace 'exit'
exit $script:ExitCode
