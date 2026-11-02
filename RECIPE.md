# My Main

Herdr's default layout with a personal dashboard added: a toggleable right column shows today's calendar, unread Gmail, Linear issues and GitHub PRs, and the status bar shows what's playing and how long the AWS SSO session has left.

![My Main](preview.png)

## What you see

- **Sidebar (left, 268px):** Herdr's shipped layout: `workspace-chrome` brand, `spaces`, `agents`, and `workspace-chrome` footer.
- **Work area:** `tabs` (42px), the active tab's panes, then a 28px status row.
- **Files panel (368px, hidden by default):** Herdr's shipped `files` and `changes` mods in a stack.
- **Dashboard column, `linear-panel` (420px, hidden by default),** top to bottom:
  - `mac-calendar` (120px): today's events.
  - `gmail` (240px): up to 8 unread inbox messages.
  - `linear` and `my-prs`, sharing the remaining height equally.
- **Status row:** `workspace-status`, `now-playing` (340px), `aws-sso` (180px).

## How it behaves

Agent statuses are drawn by Herdr's shipped `agents`, `spaces` and `pane` mods; this layout doesn't change them.

- `cmd-alt-b` toggles the dashboard column and `cmd-b` toggles the sidebar. The rest of `keys.json` is macOS-style tab, pane and space bindings.
- **Calendar:** folds to its header. The settings icon picks calendars; by default all show except holidays and birthdays.
- **Mail:** a row opens the thread in Gmail. Its buttons mark read, archive or delete. Folds to its header. Refreshes every 2 minutes.
- **Linear:** lists your open issues with search, plus unread inbox notifications. A row opens the issue. `Space` opens the issue's Herdr space, or asks whether to start a new one with a terminal, `claude` or a command from `HERDR_LINEAR_AGENTS`. `+` opens the new-issue dialog. Refreshes every minute.
- **My PRs:** PRs waiting on your review and your own open PRs, with CI and review state. Refreshes every 2 minutes.
- **Now Playing:** title and artist with previous, play/pause and next. Polls every 3 seconds.
- **AWS SSO:** time left, with a green dot, yellow under an hour, red when expired. Clicking runs the login command in a new tab.

## Built from

- **Layout:** `layouts/my-main.json`, cloned from Herdr's `main` 0.1.11.
- **Shipped mods:** `workspace-chrome`, `spaces`, `agents`, `tabs`, `pane`, `files`, `changes`, `workspace-status`.
- **Custom mods:** `mac-calendar`, `gmail`, `linear`, `my-prs`, `now-playing`, `aws-sso`.
- **Programs and network:**
  - `mac-calendar` runs `sqlite3` on the macOS Calendar database.
  - `gmail` runs `/usr/bin/python3` (`fetch.py`), which connects to `imap.gmail.com`.
  - `linear` calls `api.linear.app` and runs `security` to read its API key from Keychain.
  - `my-prs` runs `gh`.
  - `now-playing` runs `~/bin/media-control`.
  - `aws-sso` reads `expiresAt` from `~/.aws/sso/cache/*.json` and runs the login command.

`mods/linear` and `mods/mac-calendar` are adapted from MIT-licensed mods; see the `LICENSE` file in each.

## Watch out

- **Personal settings are environment variables,** read from your shell (a login shell if the app was launched from the Dock):
  - `HERDR_GMAIL_ACCOUNT`: your Gmail address. Required for the mail panel.
  - `HERDR_LINEAR_WORKSPACE`: your Linear workspace URL key, for the inbox links. Or `workspace` in `linear.json`.
  - `HERDR_LINEAR_TEAM`: the team key that comes first in search and is the new-issue default. Or `team` in `linear.json`.
  - `HERDR_LINEAR_AGENTS`: comma-separated extra commands for the `Space` menu. Or `agents` (an array) in `linear.json`.
  - `HERDR_AWS_LOGIN`: the login command for the AWS item. Defaults to `pco aws-login`, Planning Center's login command; set `aws sso login` for plain AWS SSO.
- **Gmail:** needs an app password in macOS Keychain (service `herdr-gmail`, account = your address) or `$GOOGLE_APP_PASSWORD`.
- **Linear:** needs an API key in macOS Keychain (service `herdr-linear`; add it with `security add-generic-password -s herdr-linear -a "$USER" -w`), `~/.config/herdr-app/linear.json` with `{ "apiKey": "lin_api_…" }`, or `$LINEAR_API_KEY`. The file's optional `repos` key maps team keys to folders. Never commit this file. The new-issue dialog expects an `Investment Category` label group.
- **My PRs:** needs `gh auth login`.
- **macOS only:** `mac-calendar`, `now-playing` and the Gmail mod's link opening.
- **`keys.json`:** merge it into your own, and ask before replacing keys already in use.

## Done when

- `herdr-app check` passes for each custom mod.
- `layout.switch {name: "my-main"}` shows the sidebar, tabs and status row.
- `cmd-alt-b` shows and hides the dashboard column.
- Each panel shows data or a clear setup error rather than a blank block.
