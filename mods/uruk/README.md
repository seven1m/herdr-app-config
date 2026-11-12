# Uruk

A native Herdr chat panel backed by oMLX, with one shell tool and a small
system prompt. It runs entirely in Herdr's embedded JavaScript runtime:
no Node, Go executable, or separate agent server.

Uruk opens as a tab in the main work area, alongside terminal tabs. Click
**Uruk +** at the right of the tab bar in My Main to start a new conversation,
using the current local project folder. The separate `uruk-launcher` mod adds
this button without modifying Herdr's shipped tabs or + menu. Or run:

```sh
herdr-app do tab.new --name Uruk --mod uruk
```

Choose a project folder before coding. A conversation stays attached to that
folder; changing folders starts a new chat. Enter or Send submits a message.
New chat clears history and usage. Reload rereads configuration and refreshes
the context limit. Stop prevents further steps after the current model request
or shell command finishes; it does not interrupt I/O already in progress.
Closing the panel also prevents subsequent tool calls.

Each tab saves its conversation, tool results, project folder, draft, usage,
and expanded tool rows in Herdr's per-copy `localStorage`. History survives
mod reloads and app restarts. New chat clears that tab's saved conversation.
A reload during a turn keeps the transcript and last complete model/tool
checkpoint; it stops the turn and never automatically retries shell commands.
The API key stays in `uruk.json`, outside the saved conversation.

## Configuration

Edit `~/.config/herdr-app/uruk.json` and click Reload. See
`config.example.json` for supported fields. Missing fields use defaults;
unknown fields and invalid types are rejected. The path uses Herdr's
`appHome()`, including a custom `HERDR_APP_HOME` when set.
Keep this file private: it contains the oMLX API key and is ignored by Git.
If the file is absent, the defaults connect to the local Qwen model.

The model's context limit is fetched from `/v1/models` at startup and on Reload,
not on every message. Reload immediately updates the displayed denominator and
percentage, including statistics from the preceding response. Context usage is estimated from the latest request's
input plus generated tokens. Input displays growth since the preceding
response; it includes startup instructions on the first turn. Output counts
generated tokens, including all model calls in a tool-using turn.

## Execution

The mod uses `fetch` for oMLX and Herdr's `exec` to run `/bin/sh -c` in the
selected local folder. Shell commands run as your user, with no approval
prompts or sandbox. Each command gets a fresh shell. Shell time is bounded by
`shell_timeout_seconds` (maximum 600); model-visible tool output is bounded by
`max_tool_output_bytes`. Herdr also caps captured subprocess output at 8 MiB.

Responses appear after generation finishes. There is no automatic compaction,
automatic skills loading, or context-limit enforcement. Multiple panels have
independent saved conversations. Remote project execution is not supported.

## Check

```sh
herdr-app check ~/.config/herdr-app/mods/uruk
```

`agent.js` keeps config parsing and the agent loop independent of the UI.
`tests.mjs` exercises these through injected model and shell adapters and can
be run with a development Node runtime (`node -e "import('./tests.mjs').then(async m => console.log(await m.runTests()))"`). Node is not
used by the installed mod.
