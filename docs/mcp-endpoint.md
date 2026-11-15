# Let an agent work in Pi Web sessions over MCP

Pi Web can serve an MCP endpoint at `/mcp` on its own address. An MCP client such as Claude Code then works in the same pi sessions you use in the browser: both of you send messages, and both of you see the whole conversation. Through the same endpoint the agent can list and read sessions, start sessions, and create git worktrees.

This endpoint exists only in this fork of Pi Web.

## Turn the endpoint on

The endpoint stays off until Pi Web's environment holds a token of at least 32 characters. While it is off, `/mcp` answers 404.

1. Generate a token:

   ```sh
   openssl rand -hex 32
   ```

2. Start Pi Web with the token in `PI_WEB_MCP_TOKEN`:

   ```sh
   PI_WEB_MCP_TOKEN=<token> pi-web
   ```

   For a service, put `PI_WEB_MCP_TOKEN=<token>` in the environment file the service reads, then restart it.

The token is as powerful as the web password: whoever holds it can make pi run commands in any folder on the machine. Keep it out of shell history and shared files.

## Connect Claude Code

Pi Web's default address is `http://127.0.0.1:30141`. Use your own if you changed the port or the hostname.

To add the endpoint to Claude Code's configuration, run:

```sh
claude mcp add --transport http pi-web http://127.0.0.1:30141/mcp \
	--header "Authorization: Bearer $PI_WEB_MCP_TOKEN"
```

To keep the token out of Claude Code's configuration, write an MCP config file that reads it from the environment, for example `~/pi-web-mcp-endpoint.json`:

```json
{
	"mcpServers": {
		"pi-web": {
			"type": "http",
			"url": "http://127.0.0.1:30141/mcp",
			"headers": { "Authorization": "Bearer ${PI_WEB_MCP_TOKEN}" }
		}
	}
}
```

Then start Claude Code with it:

```sh
PI_WEB_MCP_TOKEN=<token> claude --mcp-config ~/pi-web-mcp-endpoint.json
```

Any MCP client that speaks Streamable HTTP with a static `Authorization` header works the same way. The endpoint accepts protocol versions 2025-11-25, 2025-06-18 and 2025-03-26.

To hand the agent a session, copy its address from the browser (`…/?session=<id>`). Every tool that takes a session accepts the id or that address.

## Use the endpoint from another machine

Remote use goes through the reverse proxy or tunnel you already use for the web UI, over HTTPS. The token travels in a header, so plain HTTP over the internet exposes it.

1. Add the public hostname to `PI_WEB_ALLOWED_HOSTS`, as the web UI needs too. Without it, `/mcp` answers 403.
2. Point the client at `https://<public host>/mcp`.
3. If the links the tools hand out show the wrong address, set `PI_WEB_MCP_LINK_BASE` to the address people open, for example `https://pi.example.net`. Without it, links use the request's `Host` header and its `X-Forwarded-Proto`.

No call keeps a response open longer than 50 seconds, so proxies with a 60-second read timeout and Cloudflare's 100-second limit never cut one off.

## How the agent and you share a session

- **Messages queue instead of colliding.** `pi_send` delivers a message the way the composer's Follow-up button does. If pi is busy with anyone's run, the message waits in pi's queue, and you see it under your composer. Neither side gets "Agent is already processing" because the agent sent something.
- **The agent follows the conversation with a cursor.** Every reply about a session ends with `cursor: …`. The agent passes the newest one to `pi_wait`, which reports everything after it: your messages, pi's replies, tool calls, and questions extensions ask. A lost reply costs nothing, because repeating a call with the same cursor gives the same answer.
- **Messages carry labels for the agent.** It reads `[agent]` for what it sent, `[person]` for what you typed, and `[user]` for messages from before Pi Web last restarted, whose sender is unknown. pi's replies read `[pi]`. Pi Web itself shows no labels: in the browser, the agent's messages look like yours.
- **Stop is everyone's.** `pi_stop` stops the run for you too and withdraws every queued message, yours included. The texts go to the agent, not back into your composer.
- **Extension questions reach both of you.** When an extension asks something, you see the dialog in the browser and the agent sees it in its reply, with the `pi_answer` call that answers it. The first answer counts. Panels that take keystrokes are yours alone.
- **Sessions the agent uses stay loaded.** Pi Web normally unloads a session after 10 idle minutes. A session the agent sent to, waited on, answered or stopped stays loaded for 30 minutes after its last such call.
- **New sessions appear in your sidebar** within a few seconds, grouped under their project and worktree. The reply to `pi_new_session` holds a link to give you.

## Tools

| Tool | What it does | Arguments |
| --- | --- | --- |
| `pi_sessions` | Lists sessions, newest first, with state, title, folder and branch. Subagent and side-chat sessions are left out. | `cwd?`, `limit?` (1 to 100, default 20) |
| `pi_read` | Reads a session's latest messages (or older ones), its state and open questions. Never starts a session. | `session`, `messages?` (1 to 100, default 12), `before?` |
| `pi_send` | Sends a message as the composer does. Returns once pi has taken it, queued behind any run. `steer: true` delivers it at pi's next step. | `session`, `message`, `steer?`, `cursor?` |
| `pi_wait` | Waits until pi is at rest, an extension asks something new, or `timeout_s` passes, then reports everything since `cursor`. `timeout_s: 0` reports at once. | `session`, `cursor`, `timeout_s?` (0 to 50, default 45) |
| `pi_answer` | Answers an extension's question: an option's text or number, `true` or `false`, or text. Or `cancel: true`. | `session`, `dialog`, `answer?`, `cancel?` |
| `pi_stop` | Stops pi for everyone and lists the queued messages it withdrew. Does nothing when pi is idle. | `session` |
| `pi_new_session` | Starts a session in an existing folder and sends its first message. | `cwd`, `message`, `model?` (`provider/modelId`), `thinking?`, `tools?` |
| `pi_new_worktree` | Creates the worktree for a branch at `<repo>-worktrees/<branch>`, or returns the one that exists. Safe to repeat. | `project`, `branch` |

`tools` on `pi_new_session` takes the presets of the new-session composer: `configured` (pi's settings, the default), `none` (chat only), `read-only`, `default` or `full`.

## Limits

- The endpoint sends text only: no images in either direction.
- It cannot change an existing session's model, thinking level or tools.
- It never trusts a project. In a folder that needs trust, the session starts without the project's extensions until you trust the folder in Pi Web.
- It does not remove worktrees, and it never fetches: a new branch starts from the main checkout's `HEAD`, or from `origin/<branch>` when that was fetched already.
- New sessions go in any existing folder on the machine, under the folder's real path.
- A wrong token answers 401 and does not count toward the web login's lockout, so a stranger guessing tokens cannot lock you out of the web UI.
- If you send in the browser in the moment before your page learns that the agent started a run, pi refuses the plain send, and the page queues your message as a follow-up instead, as the Follow-up button would.
- Labels live in memory. After Pi Web restarts, earlier messages read `[user]`. A slash command the agent sends that pi expands into other text reads `[person]`.
