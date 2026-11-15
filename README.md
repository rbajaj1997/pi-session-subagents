# pi-session-subagents

Reusable subagents for the current Pi session. Create workers, give them tasks, steer their work, and inspect their conversations using Pi's native message and tool rendering.

## What "session subagents" means

Each worker has its own conversation. It can start idle, complete a task, and accept a follow-up in the same context. Completed workers stay available until you stop them or the parent session ends.

```text
Create worker
  optionally start a task
  return result
  retain conversation
  accept follow-up tasks
  stop when removed or the parent session ends
```

This is conversational reuse, not a background job service. Workers do not survive reloads, session switches, or process exit. Their conversations are saved to disk, so you can review a worker's work later (see [Reviewing past work](#reviewing-past-work)).

## Requirements

- Pi 1.5.2 is the SDK and TUI compatibility target. Older versions are not supported; other versions have not been validated.
- Node.js 22.19.0 or newer.
- Model credentials and configuration available to Pi.

## Install

From npm:

```sh
pi install npm:pi-session-subagents
```

From GitHub:

```sh
pi install git:github.com/rbajaj1997/pi-session-subagents
```

From a local checkout, run this from the repository root:

```sh
pi install .
```

Restart Pi or use `/reload` after changing enabled extensions. Keep only one copy of this extension enabled, since duplicate copies register the same tools and commands.

## Quick start

Create two idle workers without assigning readiness-acknowledgment tasks:

```text
/subagents Create two idle workers named scout and reviewer using Haiku. Keep them ready without assigning tasks.
```

Then ask Pi to use an existing worker:

```text
Have scout inspect the authentication code and summarize its structure.
```

After it finishes, continue its conversation:

```text
Ask scout to examine the token-refresh path in more detail.
```

The follow-up uses scout's existing context. For unrelated work that needs a fresh context, create another worker.

Workers can be limited and given deadlines:

```text
Spawn a read-only worker with only read, grep, find, and ls, low thinking, and a 5 minute timeout to map the database layer.
```

`/subagents <request>` turns the worker tools on and sends the request. To turn them on without a request, use `/subagents on`. To stop and remove all workers and turn the tools off, use `/subagents off`. It stops workers right away, even while the parent waits in `await_subagents`, and turns the tools off once the parent's current run ends. The tools also turn off on reload or session switch.

## Commands and tools

| Command | Purpose |
| --- | --- |
| `/subagents on` | Turn the worker tools on. |
| `/subagents off` | Stop and remove workers, then turn the tools off. |
| `/subagents <request>` | Turn the worker tools on and send the request. |
| `/subagents:inspect [name]` | Open a live, read-only conversation inspector. Interactive TUI only. |

| Tool | Purpose |
| --- | --- |
| `spawn_subagent` | Create a worker. Omit `task`, or leave it blank, to keep it idle without a model call. |
| `list_subagents` | List workers and their statuses. |
| `inspect_subagent` | Read status, capabilities, the session file path, recent conversation lines, or paginated result text. |
| `message_subagent` | Start an idle worker, continue a completed worker, or steer a running one. |
| `await_subagents` | Wait for named workers, or all running ones. |
| `stop_subagent` | Stop a worker, remove it, and wait until its session is closed. |

Only the parent uses these tools. Workers do not load this extension, so they cannot spawn other workers or message siblings.

## Worker options

`spawn_subagent` accepts:

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | `worker`, `worker-2`, ... | Short name used to address the worker. |
| `task` | none | Task to start right away. Without it the worker stays idle. |
| `model` | parent's model | Fuzzy name or `provider/id`. A query that matches no available model, or has no letters or digits, fails the spawn. |
| `thinking` | parent's level | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `tools` | parent's active tools | Subset of the parent's active tools. Naming a tool the parent does not have active fails the spawn. |
| `cwd` | parent's cwd | Working directory, absolute or relative to the parent's. It must exist. |
| `timeoutMs` | no limit | Deadline for the initial task. |

`message_subagent` also accepts `timeoutMs` for the task it starts. It is ignored when the message steers a running worker. A steering message belongs to the current task: if the worker finishes while the message is still being processed, the message starts another turn of that task, and the report waits for it. When a deadline expires, the run is aborted and reported as an error, steering messages it has not read yet are dropped, and the worker stays available for follow-ups.

If you press Escape while `spawn_subagent` is still creating a worker, the worker is discarded before its task starts. Once `spawn_subagent` returns, the worker runs on its own until it finishes or you stop it.

`await_subagents` accepts `names` and `timeoutMs`. With a timeout it stops waiting when the time is up and lists the workers still running. Those workers keep running.

Waiting is rarely needed, because completion reports arrive on their own. While `await_subagents` runs, the parent's turn stays open and messages you send are held until it returns. The tool guidelines tell the model to end its turn while workers run, and to wait only when it needs the results together or you ask it to.

## Results and reports

Success and failure both produce completion reports. A report steers a running parent or wakes an idle one. Workers you stop, and workers disposed during parent shutdown, do not send reports.

In the TUI, Escape clears the parent's queued messages, including reports it has not read yet. Each cleared report is kept and sent once with the parent's next turn, usually your next message. It does not start a turn on its own. Other modes keep queued messages on abort, so their reports arrive with the next run unchanged. An RPC client that calls `clear_queue` drops queued reports for good.

The model-visible report contains the first 12,000 UTF-16 code units of the result, keeping line breaks and surrogate pairs intact at page boundaries. The full result stays in the expandable report card, which renders it as Markdown, and in the worker's session file.

For longer results, call `inspect_subagent` with `includeResult: true`, the report's `runId`, and the continuation `resultOffset`. Starting another assignment clears the latest result, but earlier output stays in the conversation. Run ids are unique within the parent session, across all workers, so a `runId` that is not the worker's latest returns an error rather than a later assignment's output, even when a new worker reuses a removed worker's name.

`inspect_subagent` with `tailLines` returns the last lines of the conversation as plain text, up to 50KB.

## Inspection

The main widget and the inspector need the interactive TUI. In RPC mode, use `list_subagents` and `inspect_subagent`. The main widget shows worker status and activity. In fullscreen mode, Pi's default, click a worker in the widget to open its inspector. In regular mode the terminal handles the mouse, so use `/subagents:inspect [name]`. The inspector renders the worker's full session branch, including messages before compaction, with Pi's native assistant, user, custom-message, tool, and summary components. Tool cards use registered renderers, including edit diffs. Inline tool images are off in the inspector.

- Arrows or `j`/`k` scroll. PageUp/PageDown page. Home/End jump.
- Scrolling up pauses following. End resumes it.
- Mouse-wheel scrolling and native click controls work in fullscreen mode.
- `t` or the configured `app.tools.expand` shortcut expands or collapses tool cards.
- The configured `app.thinking.toggle` shortcut changes thinking visibility inside the inspector only.
- Escape or `q` closes the inspector without stopping the worker.

## Reviewing past work

Each worker that runs a task writes its conversation to a session file under `~/.pi/agent/subagent-sessions/`, outside Pi's normal session list, so `pi -r` is not affected. Pi writes the file once the conversation starts, so a worker that stays idle leaves no file. All of a worker's tasks go into the same file, and the file records the parent session's path.

The completion report card shows `Session: pi --session <path>`, and the model-visible report and `inspect_subagent` include the path. After a worker is removed, or after Pi restarts, open its file with:

```sh
pi --session <path>
```

This opens the worker's conversation as a normal session. A prompt typed there continues it. This extension does not delete these files.

## Configuration and limitations

There is no package-specific configuration file or role library. Workers are configured per spawn (see [Worker options](#worker-options)).

Each worker has its own `ModelRuntime`, separate from the parent's and from other workers'. It discovers configured credentials, providers, and extensions for its working directory, and registers the providers its extensions declare before its model is chosen, so a model from an extension provider works on the first spawn. A worker's provider registrations do not affect other workers and end with it. Credentials come from the shared `auth.json`, which Pi writes under a file lock. Removing a worker waits for its credential writes, such as an OAuth token refresh. Parent-only runtime keys, virtual models, provider registrations, and tool implementations are not copied. A resolved model missing from the worker runtime causes creation to fail.

A worker in the parent's working directory uses the parent's project trust decision. A worker in another directory loads that directory's project settings, extensions, skills, and MCP servers only if `~/.pi/agent/trust.json` has a saved yes for it or a parent directory, for example from `/trust`. Workers never show the trust prompt. When untrusted project resources are skipped, the spawn result lists a warning.

Spawn results and inspection report the worker's enabled tools, callable tools, missing requested tools, and extension diagnostics. When a worker's tools include `codemode` or `tool_search`, the worker also loads Pi's codemode, tool search, and MCP extensions, so each such worker opens its own MCP connections. Worker extensions receive `session_shutdown` when the worker is removed.

The parent's system prompt does not change as workers start and finish, so the prompt cache stays valid. The model learns about workers from the tool guidelines and `list_subagents`.

Idle workers make no model calls but still use memory. Follow-ups include existing conversation context and are billed normally. There is no package-level concurrency cap. A host that exits disposes its workers; do not assume jobs outlive the parent process.

## Permissions

Separate conversation context is not filesystem or process isolation. Workers share the host's operating-system permissions and can work in the same directory. Coordinate parallel writes to avoid conflicts.

Tool allowlists are not a security sandbox. Loaded extensions run with host permissions. Review extensions and project trust settings before delegating work.

## Development

```sh
npm install
npm run check    # Biome lint and format check, then tsc
npm run format   # apply Biome formatting and safe fixes
npm test
```

Formatting and linting follow Pi's own Biome setup: tabs, a 120-character line width, double quotes, semicolons, and the recommended lint rules. Biome is pinned to the version Pi uses. `.vscode/` makes Biome the formatter on save, so editor formatting matches `npm run check`. Install the recommended Biome extension.

The package ships TypeScript source through `pi.extensions`. Pi loads it directly, so no compilation or bundling step is required. Pi-provided imports are peer dependencies, with pinned development copies for local typechecking. There are no additional runtime dependencies.

`npm test` uses Node's built-in test runner with tsx to run the TypeScript tests. The tests use normal imports, and `tsc --noEmit` checks both `src/` and `tests/`. Tests exercise commands, the roster, worker lifecycle and steering, deadlines, report delivery, model selection, result pagination, transcript inspection, the widget, the inspector, and session cleanup. They use a controlled Pi session substitute and temporary directories, without model calls or credentials. Live provider discovery, trust configuration, and interactive TUI behavior still need checks in Pi.

```text
src/
  index.ts                  Wiring: tools, commands, session events
  copy.ts                   Every sentence the model reads; tool names come from here
  tools.ts                  The six tool definitions and the text they return
  roster.ts                 The session's workers: naming, spawning, messaging, waiting, stopping
  worker.ts                 One worker and its run; stats and status are derived from its session
  worker-session.ts         Builds and shuts down a worker's Pi session
  report.ts                 Completion reports: model JSON, card, delivery, resend after Escape
  model-resolver.ts         Model selection
  text.ts                   Plain-text helpers for model-facing strings
  ui/
    widget.ts               Worker list above the editor
    conversation-viewer.ts  Framed read-only inspector using Pi's own components
tests/                      TypeScript behavior tests, run with node --test through tsx
```

CI runs `npm run check`, `npm test`, and `npm pack --dry-run` on Node 22 and 24 for every push to `main` and every pull request.

## Releasing

Releases use [release-please](https://github.com/googleapis/release-please) and [Conventional Commits](https://www.conventionalcommits.org/). Write commit messages such as `feat: add ask_parent tool` or `fix: resend reports after Escape`. `feat` bumps the minor version, `fix` bumps the patch version, and a breaking change also bumps the minor version until 1.0.0.

Each push to `main` updates a release pull request that bumps the version in `package.json` and adds the changes to `CHANGELOG.md`. Merging it tags the release, creates a GitHub release, and publishes the package to npm from GitHub Actions with trusted publishing and provenance. No npm token is stored in the repository.

## License

MIT. See [LICENSE](LICENSE).
