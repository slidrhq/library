# Open WebUI agent for Slidr

A custom agent CLI ([docs/custom-agent-cli.md](https://github.com/slidrhq/app/blob/main/docs/custom-agent-cli.md) of the app's repository, protocol version 1) on the API of an [Open WebUI](https://openwebui.com): Slidr's chat runs its turns through a model of the Open WebUI, and Settings › Images makes pictures with its image engine. One sign-in serves both.

It is one PowerShell 7.5 script, `openwebui-agent.ps1`, with the page it signs in with, `login.html`.

## Registering it

The protocol starts a native executable, so the registration names `pwsh.exe` and gives the script as its first arguments, as a Node.js CLI is registered as `node.exe`. In `settings.json` of the app (Settings › Agent › Add a CLI…):

```json
{
  "agents": {
    "custom": [
      {
        "id": "open-webui",
        "command": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        "args": ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\Users\\you\\Documents\\slidr\\library\\custom-agent\\openwebui-agent.ps1"],
        "env": { "POWERSHELL_UPDATECHECK": "Off", "POWERSHELL_TELEMETRY_OPTOUT": "1" }
      }
    ]
  }
}
```

`command` is `pwsh.exe` of PowerShell 7.5 or later: `(Get-Command pwsh).Source`. For PowerShell from the Microsoft Store that is `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`, an alias that starts PowerShell itself as the one process, so ending it ends the CLI, and that keeps its path across updates. `-NoProfile` keeps the user's own PowerShell profile out of every run.

## Signing in

`slidr login` (Settings › Sign in) opens a page in the browser, served by the CLI itself on `127.0.0.1` under a path no other page can guess, and closes when the account is signed in or after 9½ minutes. It asks the Open WebUI what it allows and offers that:

- **E-mail and password**, or **LDAP**: the CLI signs in, takes the account's API key (makes one when the account has none; it does not replace one it has, which other tools may use), and ends the sign-in. A second step (an authenticator code) is asked for on the page.
- **Single sign-on**: a button for each provider opens Open WebUI's own sign-in; the page then asks for the account's API key, which Open WebUI shows in Settings › Account › API keys.
- **An API key** pasted, always.
- An Open WebUI that asks for no sign-in: one button.

The password goes to Open WebUI and nowhere else, and is not kept. The key is kept in `%LOCALAPPDATA%\Slidr Open WebUI agent\config.json`, encrypted for the Windows user (DPAPI), with the address. `SLIDR_OPENWEBUI_HOME` names another folder.

Open WebUI must let the account use API keys: Admin Panel › Settings › General › Enable API Keys, and, for an account that is not an admin, the API keys permission of its group.

For scripts, `SLIDR_OPENWEBUI_LOGIN=stdin` reads lines from standard input instead of opening the page: the address and an API key, or the address, an empty line, an e-mail and a password. `SLIDR_OPENWEBUI_BROWSER=0` prints the page's address without opening the browser. `SLIDR_OPENWEBUI_TRACE=1` writes every request to Open WebUI and its time to standard error.

## What it does

| Subcommand | Open WebUI |
|---|---|
| `describe` | Nothing: the CLI's capabilities, and whether images are offered, from what the last `status` or `models` learnt (`server.json`). |
| `status` | `/api/v1/users/user/info` with the key; the server's settings. |
| `models` | `/api/models`: the models the account may use, less those of an OpenAI connection that are no chat model (speech, realtime, images, video, embeddings, search) or answer through the Responses API only (`-pro`, `codex`). The default is the server's first default model (Admin Panel › Settings › Models); without one, the newest plain `gpt-N.N`, else the first by name, since Open WebUI lists its models in no fixed order. OpenAI's reasoning models get the effort levels `low`, `medium`, `high`. |
| `turn` | `/api/chat/completions`, streamed; the app's tools over MCP. |
| `image` | `/api/v1/images/generations` and `/api/v1/images/edit`; the file it makes is fetched and then removed from the account's files. |

**A turn.** The request is Chat Completions; the reply is read as Chat Completions chunks or, for a connection Open WebUI runs on OpenAI's Responses API (its stream is passed on as it comes), as Responses events. The effort goes as `reasoning_effort`, and as `reasoning.effort` when the connection refuses that. `localhost` is reached on 127.0.0.1 when that answers: Windows tries ::1 first, and Open WebUI's desktop app listens on 127.0.0.1 only, which costs some 2 seconds a request. The app's system prompt replaces any other; the turn's context goes before the user's text in one message, with the pictures. The app's tools are listed from the tool endpoint at the start of every turn and given to the model unchanged; the calls of one step run side by side, each reported as it returns. A result's pictures follow the results in one user message, since the API's tool messages carry text only. Only the latest 12 of them are sent again in later steps, so that a long session keeps within the model's context: older ones stay in the store, and the model is told to render again to see them. The CLI has no tools of its own (no shell, files, web), so the app gives the agent its `attachment_read`.

**Conversations** are kept in `sessions\<id>.json` of the store, written after every model message and tool result to a file of its own and renamed over the old one, so that the app can end the process at any moment. A tool call whose result never came is answered as interrupted when the conversation goes on.

**Images.** `maxParallel` is 2. Edits are `regenerate` (Open WebUI's edit draws the picture again after the source; no mask). The size asked for follows the engine when an admin's key can read the image settings (`gpt-image-1`, `dall-e-3`, ComfyUI and Automatic1111 take different sizes); otherwise the CLI asks for the shape's size and, when the engine refuses it, for the engine's own.

**What Open WebUI adds.** A model of Open WebUI's workspace may carry a system prompt, knowledge or tools of its own, and global filters act on every request: for the app's prompt to be the only one, pick a base model, or a workspace model without them.

## Checking it

```powershell
pwsh -NoProfile -File .\test\conformance.ps1                      # every check of section 10, with the default model
pwsh -NoProfile -File .\test\conformance.ps1 -Model gpt-4.1 -SkipImages
```

The checks run the CLI as the app does, against `test\fake-bridge.ps1`, a stand-in for the app's tool bridge (MCP over Streamable HTTP, protocol 2026-07-28, with `slide_render`, `slow_tool`, `fast_tool` and `long_result`), and the Open WebUI the CLI is signed in to. Several ask the model to do something and read what it did, so they depend on the model: tool use, vision, and a context of 128,000 tokens.
