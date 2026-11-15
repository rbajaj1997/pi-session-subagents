# Changelog

## [0.1.1](https://github.com/rbajaj1997/pi-session-subagents/compare/v0.1.0...v0.1.1) (2026-11-15)


### Bug Fixes

* require Node.js 24 ([#2](https://github.com/rbajaj1997/pi-session-subagents/issues/2)) ([b2d8749](https://github.com/rbajaj1997/pi-session-subagents/commit/b2d8749eeadafac621834c0fc18b1ce05fca744a))

## [0.1.0] - 2026-11-15

Initial release.

- Create session-scoped workers with their own conversations. A worker can start idle without a model call, run a task, and take follow-up tasks in the same context.
- Start, steer, inspect, wait for, and stop workers through six tools: `spawn_subagent`, `list_subagents`, `inspect_subagent`, `message_subagent`, `await_subagents`, and `stop_subagent`.
- Choose each worker's name, model, thinking level, tools, and working directory. The model and thinking level default to the parent's. Tools must be a subset of the parent's active tools. A model query that matches nothing fails the spawn. A working directory other than the parent's loads project resources only with a saved trust decision.
- Set an optional deadline per task with `timeoutMs`. `await_subagents` can wait for named workers and stop waiting after a timeout.
- Turn the tools on and off with `/subagents on|off`. `/subagents <request>` turns them on and sends the request.
- Deliver success and failure reports to the parent with the first 12,000 characters of the result. Read longer results in pages with `inspect_subagent`. A report cleared by Escape in the TUI is sent once with the parent's next turn, without starting one.
- Save each worker's conversation under `~/.pi/agent/subagent-sessions/`. Reports and `inspect_subagent` show the path for `pi --session <path>`.
- Show a live worker widget and a read-only inspector built from Pi's own message and tool components. In fullscreen mode, clicking a worker in the widget opens its inspector.
- Give each worker its own model runtime, so its extension providers are registered before its model is chosen and do not affect other workers. Workers load configured extensions, plus Pi's codemode, tool search, and MCP extensions when their tools need them. Worker extensions receive `session_shutdown` when the worker is removed.
- Keep the parent's system prompt unchanged as workers start and finish, so the prompt cache stays valid.
