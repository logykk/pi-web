# The MCP endpoint at `/mcp` (fork only)

pi-web's own MCP server, for agents that work in pi sessions beside a person in the browser. Not to be confused with pi-web as an MCP *client* (`lib/mcp-*.ts`, `app/api/mcp/`, Settings › MCP): that code is unrelated, which is why this module is `lib/mcp-endpoint/`, never `lib/mcp-server*`. User doc: [docs/mcp-endpoint.md](../mcp-endpoint.md).

## Shape and ownership
- A call goes `app/mcp/route.ts` → `jsonrpc.ts` `dispatch()` → a tool's `run` in `tools.ts` → one `Desk` method in `desk.ts`. Each hop owns one layer: HTTP (`http.ts`), protocol, presentation, runtime. `transcript.ts`, `rest.ts` and `session-ledger.ts` are pure and sit beside that path.
- **`ports.ts` is the only file that imports pi-web internals** (rpc-manager, session-reader, worktree, session-liveness, subagent-runtime, project-trust, tool-presets, file-access). `desk.ts` is written against `PiWebPorts` / `LiveSession` and tested with fakes (`desk.test.mjs`); `ports.integration.test.mjs` pins the upstream behavior the interface promises on a real wrapper with pi-ai's faux provider. After a rebase, a reshaped upstream API breaks `tsc` in `ports.ts` or that test, nothing else.
- **`ports.listSessions()` copies the join in `app/api/sessions/route.ts`** (saved rows, live-only rows, merge, running and awaiting-input ids) on purpose: extracting it would edit an upstream route. When a rebase changes that route's join, mirror the change here.
- **No upstream file changes** besides the one pointer line in AGENTS.md. Not `proxy.ts`, not `instrumentation-node.ts`, not `package.json`: there is no MCP SDK dependency (a lockfile diff on every rebase), the protocol slice is hand-written.
- Shared state lives on `globalThis` under `Symbol.for("pi-web.mcp-endpoint.*")` (the ledger, holds, worktree jobs, the shutdown controller), as all pi-web state: route bundles and dev hot reloads each evaluate the modules again.

## Guard (`http.ts`)
- `proxy.ts`'s matcher (`/`, `/login`, `/api/:path*`) does not cover `/mcp`, so the route guards itself, as `app/api/web-auth/route.ts` does. Order: no usable `PI_WEB_MCP_TOKEN` (unset, or under 32 characters after trimming) → 404 for every method; `isApiRequestAllowed()` (Host allow-list, cross-site Origin / Fetch Metadata) → 403; bearer mismatch → 401 with `WWW-Authenticate: Bearer realm="pi-web", error="invalid_token"`. Off is 404, not 401: a 401 sends some clients into OAuth discovery.
- The bearer is compared as sha256 digests with `timingSafeEqual`, read from the env on every request. **Never feed `lib/auth-throttle.ts`**: its backoff is global and shared with the login form, so a token prober would lock the person out of the web UI. `http.test.mjs` pins that 50 wrong tokens leave `getAuthRetryAfterMs()` at 0.
- Do not move the guard into `proxy.ts`: matching `/mcp` there makes Next tee and buffer the body for the proxy, and Basic auth is read only for `/api`.
- Links in replies use `PI_WEB_MCP_LINK_BASE`, else the request's `Host` and first `x-forwarded-proto`. Never `request.url`: under `next start` it can hold the bind address.

## Protocol slice (`jsonrpc.ts`)
- Streamable HTTP in JSON response mode only: every POST gets one `application/json` body (an array for a 2025-03-26 batch) or 202 for notifications and responses only. No `Mcp-Session-Id`, no SSE, GET and DELETE answer 405 with `Allow: POST`. Nothing is ever a stream, so compression, proxy buffering and shutdown need nothing special.
- `MCP-Protocol-Version`: absent means 2025-03-26; a version outside `PROTOCOL_VERSIONS` is a 400 with the request id echoed, except for a body of `initialize` requests only, which negotiates in params. Claude Code's first probe is `server/discover` under a newer revision; the 400 is its signal to fall back to `initialize`. Without the header the probe gets -32601.
- Request methods are a table (`REQUEST_HANDLERS`, looked up with `Object.hasOwn`); `initialize` inside a batch is -32600. `notifications/cancelled` is ignored: a client that gives up drops the HTTP request, which aborts the call's signal.
- A tool's input schema is a JSON Schema subset (`ArgSchema`) that `tools/list` publishes as written and `validateArgs()` enforces, and `ArgsOf<S>` derives `run`'s argument type from it. Bad arguments are an `isError` result the model reads, not a protocol error. A tool that throws a `DeskError` gets its message as an `isError` result; any other throw is logged and answered `pi-web failed: …`.
- `tools.test.mjs` fails when a schema uses a keyword `validateArgs()` does not enforce, or when any `pi_*` name in the instructions, descriptions or reply text is no tool.

## Bounds and shutdown
- No call runs past 50 s (`WAIT_MAX_MS`): Claude Code allows about 60 s to a response's first byte, as do the generic MCP SDK client and nginx's default; Cloudflare's 524 comes at 100 s. `pi_send` waits up to 15 s for pi to take a message (`SEND_ACCEPT_MS`), `pi_new_session` 30 s for the build plus those 15 s, `pi_new_worktree` 45 s, `pi_stop` 5 s for the agent's own send on its way plus 20 s for the run to unwind. Past a bound the reply says what is still under way; nothing is cancelled.
- `shutdownSignal()` registers its own once-per-process SIGTERM/SIGINT listener (no `instrumentation-node.ts` edit; that file already listens, so the extra listener changes no exit behavior). Every call's signal is `AbortSignal.any([request.signal, shutdownSignal()])`, so a pending `pi_wait` answers at once when `next start` closes the server (`app/mcp/route-shutdown.integration.test.mjs`).

## Sending (`desk.ts` `deliver()`)
- **Every prompt carries `streamingBehavior`** (`followUp`, or `steer` on request): `LiveSession.prompt()` cannot express a plain prompt. With it, `send({type:"prompt"})` atomically starts a run on an idle session or queues into anyone's run, so the agent never gets "Agent is already processing". Never use the `steer` / `follow_up` commands: they skip admission, the MCP wait and the cwd check, and can strand a message in an idle queue.
- `send()` resolves at acceptance, not at the end of the run, and waits for extensions to bind first (a `session_start` dialog can hold it). The prompt is never tied to the call's signal: once handed to pi-web it is pi's, and a cancelled call can still deliver.
- "started" or "queued" in the reply is a guess from `isRunning()` before the send: `wrapper.send()` drops the SDK's preflight disposition.
- A send with no cursor returns one at the leaf before it, with `dialogs: "0"`, so the next wait shows the message landing and any dialog already open.

## The cursor and the delta (`transcript.ts`)
- The agent's whole read state is `{entryId, dialogs, at}`, encoded `<entryId|->~<digest>~<at base36>`. The server keeps nothing per agent: a lost reply is repeated with the same cursor, and entry ids survive restarts and wrapper replacement.
- `branchSince()` walks from the leaf up to the cursor's entry through `getEntry()`: `since` (an ancestor), `moved` (another branch, after "Edit from here" or a branch switch; entries from the deepest common ancestor) or `unknown` (not in this session; the newest entries). Capped to `MAX_DELTA_ENTRIES`; `visible` counts only entries the chat renders, so a background `session_info` title write wakes no waiter.
- Slices convert with `buildSessionContext(slice, slice.at(-1).id)`: the branch walk stops where a parent is missing, so it converts exactly the slice.

## When a wait is over (`rest.ts`)
- **Never `prompt_done`**: pi-web emits it only for prompts without `streamingBehavior`, never for runs the person or a subagent report started, and for a deferred prompt before its run begins.
- pi's SDK clears its run flag before it awaits extensions' `agent_settled` handlers, and a prompt arriving then starts its run right after the emit. So rest is: not busy (`isRunning()`, an unsettled subagent run, or the agent's own send still on its way), with something new, continuously for `SETTLE_MS` (600 ms). A new `agent_start` while settling drops back to watching.
- An open blocking dialog whose ids digest differs from the cursor's ends the wait; one the agent was already shown does not, so an agent that leaves a dialog to the person is not woken by it again.
- On an idle session with nothing new, a wait waits for the person until its deadline. A timeout still carries the progress and a new cursor, so the agent can steer mid-run.

## Watching a session (`SessionWatch` in `desk.ts`)
- Reads and waits **never start a wrapper**, and never read with `force`, which can evict an idle wrapper. With no live wrapper a wait ticks every second and attaches when the person's page starts one.
- `onEvent()` replays open dialogs and running tool starts synchronously inside the call. The replay is state, not news: it seeds the dialog and tool maps without waking. A `session_ended` in the replay (a wrapper an extension shut down) detaches without waking too; waking on it re-attached to the ended wrapper in a loop that never yielded.
- `session_shutdown` and `session_ended` detach; the next observation re-resolves through `getRpcSession()`, which finds whatever replaced the wrapper (fork, trust change, idle reap, a tool switch across Chat only). Never call `wrapper.onDestroy()`: the registry owns that single callback.
- `message_update`, `tool_execution_update` and `bash_output` do not wake a waiter; every other event does.

## The sent-message ledger (`session-ledger.ts`)
- The only server memory: per pi session (there is no agent identity), the endpoint's sends with a monotonic outcome (`sending` → `accepted` | `parked` | `refused`, set once) plus `landedEntryId` and `missingSince`, each set once, so concurrent waits may all reconcile it. At most 200 per session, none older than 24 h, lost on restart.
- **Labels**: pi records no author. A user entry a send landed as is `[agent]`; an unmatched one newer than the ledger is `[person]`, an older one `[user]`. Landing is a text match (same trimmed text, entry time no earlier than 2 s before the send) over all entries since the oldest unlanded send, each entry once. pi-web must not add an author field to the transcript or the extension API (AGENTS.md's extension-compatibility principle).
- **Delivery news**: a refusal after `pi_send` already replied, or an accepted send that left pi's queue without landing (Stop, or Recall in pi-web), is reported to every cursor older than the event. Missing needs pi at rest, the text out of `queued()`, an age over 2 s, and no leading `/`: an extension command may run without writing a user entry. A send found missing is never matched again; a later entry with its text is the person's.

## Keeping sessions loaded (`ports.hold()`)
- Send, wait, answer, stop and create register one session-liveness provider per session id (`pi-web-mcp-endpoint`, active for 30 min after the last touch); expired holds are swept on the next touch. A provider, not `renewIdleTimer()`: it spans gaps longer than the 10-minute idle timeout, follows the session id across wrapper replacement, still yields to Stop's forced shutdown, and shows by name in the Debug panel. Its `isActive()` never throws (a throwing provider pins the session).

## Sessions, worktrees, Stop, dialogs
- `pi_new_session` makes the cwd canonical (`~` expanded, absolute, an existing directory, its realpath), as the directory picker selects it, so the agent's sessions group with the person's. Any directory is allowed: the token is as strong as the web password. It then does what `/api/agent/new` does (a `__new__<uuid>` start key, `allowFileRoot()`, `invalidateSessionListCache()`) and sends the required first message, so every created session is saved and listed. `tools` maps through `getToolNamesForPreset()`; `configured` sends no `toolNames`. Trust stays a human action: the reply only says when project extensions are off.
- `ports.addWorktree()` joins a checkout already under way for the same folder and branch: a repeat during a long checkout must not read git's half-made worktree as "exists". A repeat after it lands in `WorktreeBranchInUseError`, answered as "exists".
- `pi_stop` sends `abort` only when a live wrapper is running or holds a dialog: an abort on an idle session would stop nothing. It first gives the agent's own send on its way up to 5 s to land, since an abort before it would hit nothing and the prompt would then run. The withdrawn texts go to the agent, labeled from the ledger, and the agent's own are marked missing.
- `pi_answer` checks the dialog is still open (through the replay), maps the answer to its kind, and sends `extension_ui_response`. The first answer from any client wins; a `custom` panel takes keystrokes and stays the person's.

## Known limits
- The person's page can send a plain prompt in the moment before it receives the agent's `agent_start`, and pi refuses it with "Agent is already processing". `handleSend` in `hooks/useAgentSession.ts` (a fork-only block, marked `Fork:`) resends that text once as a follow-up; `hooks/send-race-follow-up.test.mjs` covers it. The match is on pi's message text, so a pi upgrade that rewords it brings the refusal back: that test fails then.
- `queued()` reads the SDK queue only, not prompts parked behind a manual compaction; a parked send's outcome is `parked`, never missing.
- Internal behavior this depends on that no upstream test pins for it: the open dialogs in the `onEvent()` replay, the `abort` reply shape, `inner.getSteeringMessages()` / `getFollowUpMessages()`, and `buildSessionContext()`'s slice walk, each covered by `ports.integration.test.mjs`; also the running tool starts in the replay, which only feed the "working: bash `…` for N s" line and are not pinned.
- Tests driving the wait loop use `t.mock.timers`: let pending microtasks run (`setImmediate`) before each `tick()`, or a timer scheduled after the first tick never fires inside the advanced span.
