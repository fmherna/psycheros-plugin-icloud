# iCloud plugin

My iCloud integration — mail (read), calendar, and reminders/tasks over open
standards with an app-specific password. No OAuth, no weekly-expiring tokens, no
cloud console billing.

| Surface                                       | Protocol                    | Auth                  |
| --------------------------------------------- | --------------------------- | --------------------- |
| Mail (list unread, read)                      | IMAP `imap.mail.me.com:993` | app-specific password |
| Calendar (list, create, delete)               | CalDAV `caldav.icloud.com`  | app-specific password |
| Reminders/tasks (list, add, complete, delete) | CalDAV `VTODO`              | app-specific password |

The same four tools are registered on both of my hosts: the Psycheros embodiment
(`psycheros.ts`) and my canonical entity-core MCP server (`entity-core.ts`) —
which is how Hermes and any other embodiment inherit them. Credentials live only
in `plugin-secrets/`; the tools travel, the secrets don't.

## Install

From Psycheros: Settings → Plugins → Install, and point it at this repository
(`https://github.com/fmherna/psycheros-plugin-icloud`) or a zip of it. The
manifest carries update metadata, so the Plugins page offers one-click updates
from this repo's `v*` tags. Then continue with **One-time setup** below.

## One-time setup

1. **Create an Apple ID** for me at <https://account.apple.com> (or use an
   existing dedicated one). The operator is the registered owner — 2FA needs
   their phone number, which is fine and intended.
2. **Turn on two-factor authentication** for the account. Required — Apple only
   issues app-specific passwords to accounts with 2FA.
3. **Generate an app-specific password**: account.apple.com → Sign-In and
   Security → App-Specific Passwords → create one, label it `Psycheros`. It
   looks like `abcd-efgh-ijkl-mnop`.
4. **Fill in the secrets file** at `.psycheros/plugin-secrets/icloud.env`:

   ```dotenv
   PSYCHEROS_PLUGIN_ICLOUD_APPLE_ID=your.entity@icloud.com
   PSYCHEROS_PLUGIN_ICLOUD_APP_PASSWORD=abcd-efgh-ijkl-mnop
   ```

5. **Restart the daemon.** Plugins load at startup only. Check Settings →
   Plugins → iCloud for load status; the `icloud_status` tool verifies discovery
   and IMAP reachability.

Rotating the password later: generate a new one, update the file, restart.
Revoking the old one cuts off any copy of the credential instantly.

## Tools

| Tool              | Actions                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `icloud_status`   | (none) — config, CalDAV discovery, IMAP reachability, cache age   |
| `icloud_calendar` | `list` (next N days), `create` (timed or all-day), `delete`       |
| `icloud_tasks`    | `list`, `add` (with due date), `complete`, `uncomplete`, `delete` |
| `icloud_mail`     | `list_unread`, `read`                                             |

There is deliberately no `mail` send action yet — sending with the entity's
voice waits for an approval gate the operator chooses.

## Prompt hook

`icloud-glance` injects a one-line snapshot each turn (unread mail, today's
events, tasks due within ~2 days). It is **cache-only**: a background refresh
runs at start and every 5 minutes, so the hook never blocks a turn on Apple's
servers and never contributes to rate limiting. Mutations (add/complete/delete)
trigger an immediate async refresh.

If two daemons run this plugin at once (Psycheros + a Hermes-owned entity-core),
each refreshes independently — at a 5-minute cadence that is a handful of
requests per hour, well within polite territory.

## Migrating Google Tasks (one-time)

Export via Google Takeout ("Tasks" product), then from this directory:

```bash
deno run -A import-google-tasks.ts ~/Downloads/Takeout/Tasks/Tasks.json --dry-run
deno run -A import-google-tasks.ts ~/Downloads/Takeout/Tasks/Tasks.json
```

Options: `--into "<Reminders list name>"` to target a specific list (default:
the first one), `--include-completed` (default skips completed), `--dry-run`.
The Google side is a plain file read — no OAuth, no API.

## Known limitation: upgraded Reminders lists

Apple has been migrating Reminders to a new engine. When a list gets upgraded
(Apple leaves notice items in the list — e.g. "The creator of this list has
upgraded these reminders."), the classic CalDAV VTODO surface becomes a
**one-way-isolated mirror**, confirmed empirically on an upgraded account: items
entered in the Reminders app or on icloud.com do **not** flow down to CalDAV
reads, and tasks written via CalDAV do **not** flow up into the new engine (they
stay visible only to CalDAV clients). Treat `icloud_tasks` as the entity's
private task store — shared across embodiments via entity-core, but not a
surface shared with humans on upgraded accounts. Calendar events and mail are
unaffected: CalDAV remains Calendar's canonical sync path in both directions.

## Design notes

- **Rate-limit hygiene.** CalDAV discovery is cached 6h per process and
  deduplicated in flight; 429/503 responses are retried with honored
  `Retry-After` or jittered backoff; 401s are never retried (burning login
  attempts can temporarily lock the Apple ID).
- **Write safety.** Task completion is GET → transform → PUT with `If-Match` on
  the fetched ETag, so a concurrent edit in the Reminders app fails loudly (412)
  instead of being clobbered. Created UIDs are UUIDv4 + `@psycheros`; creation
  uses `If-None-Match: *`.
- **v1 scope.** Plain `VEVENT`/`VTODO` only — no recurrence expansion, no
  alarms. Due dates of `YYYY-MM-DD` stay date-only, which shows as "scheduled"
  in Reminders without a time-of-day nag. Recurring events are detected (RRULE)
  but not expanded: when a series has an occurrence inside the requested window,
  Apple returns the whole series object, so list output says "recurring — occurs
  within the next N days" rather than advertising the series' original start
  date.
- **Graceful degradation.** Missing credentials, unreachable mail, or a failed
  refresh surface as readable tool errors / a silent hook skip — never a crashed
  daemon.

## Development

```bash
deno test -A lib/ics_test.ts        # unit tests (iCalendar round-trips)
deno lint                            # from the workspace root
deno check entity-core.ts psycheros.ts import-google-tasks.ts
```

Validate the manifest before restart (workspace root):

```bash
deno task --cwd packages/plugin-api validate \
  "<dataRoot>/.psycheros/plugins/icloud"
```
