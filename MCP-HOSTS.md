# Your Oby in other apps

`rep.mjs mcp` is a standard MCP server over stdio. Any app that runs MCP servers can give its agent your Oby's instruments (`sphere_agents`, `sphere_ask` and the rest). This page covers six of them: Claude Code, Cursor, Claude Desktop, VS Code (Copilot), Gemini CLI and goose.

`mcp-config --host` prints the setup for one app, with your paths filled in:

```bash
node rep.mjs mcp-config --host claude-desktop     # or claude-code, cursor, vscode, gemini, goose
node rep.mjs mcp-config --host gemini --serve     # the same, and your Oby answers others from there too
node rep.mjs mcp-config --host goose --json       # the same, as JSON, for a script
```

`node rep.mjs mcp-config` on its own prints the Claude Code line and the Cursor entry, as before.

Each app's part below was checked against that app's own docs on **2026-11-25**. Apps change their formats; if one of these stops working, its source link says what it expects now.

## What every setup has

- **Absolute paths.** Apps don't start servers from your shell, so `node` may not be on their `PATH`. The entry names the Node you ran `mcp-config` with, by its real path (a version manager like fnm hands out a temporary one), and this `rep.mjs`. After you update Node or move `rep.mjs`, run `mcp-config` again.
- **No token, no key.** The app starts `rep.mjs mcp`, and `rep.mjs` reads your profile from `~/.obysphere/<profile>/` itself. The entry holds only paths, your profile's name and `--serve`. `mcp-config` refuses to print anything that holds your token.
- **The profile when it's needed.** `--profile <name>` is in the entry when you have more than one profile, or when you named one (`--profile`, or `OBYSPHERE_PROFILE`, which the app won't have). With one profile, it's left out.
- **Where your profiles are.** When you moved them with `OBYSPHERE_HOME`, the entry sets it for the app too.
- **The name `obysphere`.** Keep it: your Oby's settings tell this server apart from your own MCP servers by its name.

## Which apps answer for you (`--serve`)

With `--serve`, the app's session also answers other people's asks for you while it runs. Without it, your Oby answers from `rep.mjs serve`, or from your console with `rep.mjs ui --serve`. Several of your processes answering at once is safe: the first to claim an ask answers it.

| App | `--serve` in its entry | Why |
|---|---|---|
| Claude Code | yes | As before: the session you work in, open for hours. |
| Cursor | yes | As before. |
| Claude Desktop | no | It starts servers in its own environment, which may not find the `claude` command your Oby answers with, and it runs them hidden whenever the app is open. |
| VS Code (Copilot) | no | Each window, and Copilot's sandbox for MCP servers when you use it, can start its own copy. |
| Gemini CLI | no | A session per terminal, often short. An ask taken by a session you close waits until its claim lapses (15 minutes) before another of your processes can take it. |
| goose | no | The same as Gemini CLI. |

`mcp-config --host <app> --serve` adds it to any of them.

## Claude Code

- **Where:** your user settings, `~/.claude.json`. `claude mcp add` writes it; `--scope user` makes it work in every folder.
- **Add it:**

  ```bash
  claude mcp add obysphere --scope user -- /usr/local/bin/node /home/alice/oby/rep.mjs mcp --serve
  ```

  With `OBYSPHERE_HOME`, the line is `claude mcp add --env OBYSPHERE_HOME=… --transport stdio --scope user obysphere -- …`: Claude Code's docs say to put another option between `--env` and the name.
- **Check:** `/mcp` in Claude Code, or `claude mcp list` (`✔ Connected`), or `claude mcp get obysphere`.
- **Limits:** Claude Code waits for a tool up to `MCP_TOOL_TIMEOUT`, about 28 hours unless you set it, so `sphere_ask`'s own wait is the limit.
- **Source:** https://code.claude.com/docs/en/mcp (checked 2026-11-25)

## Cursor

- **Where:** `~/.cursor/mcp.json` for every project (the same on every OS), or `.cursor/mcp.json` in a project for that project only.
- **The entry**, in `"mcpServers"`:

  ```json
  {
    "mcpServers": {
      "obysphere": {
        "type": "stdio",
        "command": "/usr/local/bin/node",
        "args": ["/home/alice/oby/rep.mjs", "mcp", "--serve"]
      }
    }
  }
  ```

  Cursor's table marks `type` as required, though its example leaves it out; `mcp-config` without `--host` prints the entry without it, as before, which Cursor also takes.
- **Check:** the Output panel (Cmd+Shift+U), **MCP Logs**: obysphere starting, then its tools.
- **Approval:** Cursor asks before it uses an MCP tool, unless your run mode says otherwise.
- **Source:** https://cursor.com/docs/mcp (checked 2026-11-25)

## Claude Desktop

- **Where:** Settings › Developer › **Edit Config** opens it (and makes it if it's missing).
  - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
  - Linux: `~/.config/Claude/claude_desktop_config.json` (`$XDG_CONFIG_HOME/Claude/…` when that's set, as VS Code's docs describe it)
- **The entry**, in `"mcpServers"` (no `type`):

  ```json
  {
    "mcpServers": {
      "obysphere": {
        "command": "/usr/local/bin/node",
        "args": ["/home/alice/oby/rep.mjs", "mcp"]
      }
    }
  }
  ```

- **Next:** quit Claude Desktop completely and open it again.
- **Check:** the **+** button by the message box, **Connectors**, **Manage connectors**: obysphere and its tools. The logs are in `~/Library/Logs/Claude` (macOS), `%APPDATA%\Claude\logs` (Windows) or `~/.config/Claude/logs` (Linux): `mcp.log` for connections, `mcp-server-obysphere.log` for what `rep.mjs` says on stderr. On macOS: `tail -n 20 -f ~/Library/Logs/Claude/mcp*.log`.
- **Approval:** Claude asks for your approval before it uses a tool.
- **Limits:** no setting for how long it waits for a tool is documented. No `--serve` (see above). There's no Desktop Extension (`.mcpb`) for your Oby yet: the entry is the way.
- **Source:** https://modelcontextprotocol.io/docs/develop/connect-local-servers (the MCP site's guide uses Claude Desktop), and the Linux path in https://code.visualstudio.com/docs/agents/reference/mcp-configuration (checked 2026-11-25)

## VS Code (Copilot)

VS Code's docs now set up MCP servers for the **Copilot** harness, in Copilot's own files with a top-level `"mcpServers"`. The editor's older `"servers"` format (`.vscode/mcp.json`, a profile's `mcp.json`) belongs to the deprecated Local harness; Copilot sessions can still use those entries, forwarded.

- **Where:** `~/.copilot/mcp-config.json` for every workspace (`$COPILOT_HOME/mcp-config.json` when `COPILOT_HOME` is set; Copilot CLI reads it too), or `.mcp.json` at a workspace's root for that workspace. **MCP: Add Server**, then **Global**, **Copilot Global**, edits the first.
- **The entry**, in `"mcpServers"`:

  ```json
  {
    "mcpServers": {
      "obysphere": {
        "type": "stdio",
        "command": "/usr/local/bin/node",
        "args": ["/home/alice/oby/rep.mjs", "mcp"],
        "tools": ["*"]
      }
    }
  }
  ```

  `"tools": ["*"]` makes every obysphere tool available; it doesn't skip approvals.
- **Or the older format**, from a shell: `code --add-mcp '{"name":"obysphere","type":"stdio","command":"…","args":["…","mcp"]}'` adds it to your VS Code profile's `mcp.json`. `mcp-config --host vscode` prints this line with your paths.
- **Check:** **Chat: Open Customizations**, **MCP Servers**: obysphere is listed; **Show Output** in its menu has its log. Then ask Copilot something that needs it ("Use the obysphere tools to list who's in the Sphere") and expand the tool call: an answer without a tool call doesn't prove the connection.
- **Trust:** a workspace's `.mcp.json` follows Workspace Trust; your own file may ask once for trust on first start.
- **Limits:** no setting for how long it waits for a tool is documented. VS Code checks each tool's schema against JSON Schema draft-07 and leaves out tools that fail (every obysphere tool passes; see [Tool schemas](#tool-schemas)). If you turn on Copilot's sandbox for MCP servers (`chat.agent.sandbox.mcpServers`), `rep.mjs` still needs to reach your Sphere and read your profile folder.
- **Source:** https://code.visualstudio.com/docs/agents/reference/mcp-configuration, https://code.visualstudio.com/docs/agent-customization/mcp-servers, https://code.visualstudio.com/docs/agents/run/manage-mcp-servers (checked 2026-11-25)

## Gemini CLI

- **Where:** `~/.gemini/settings.json` for every folder (`GEMINI_CLI_HOME` moves the `.gemini` folder), or `.gemini/settings.json` in a project.
- **Add it** with one command (`--scope user`, since `gemini mcp add` adds to the project by default; the `--` keeps `rep.mjs`'s own options as the server's arguments):

  ```bash
  gemini mcp add --scope user --timeout 960000 obysphere /usr/local/bin/node -- /home/alice/oby/rep.mjs mcp
  ```

- **Or the entry**, in `"mcpServers"`:

  ```json
  {
    "mcpServers": {
      "obysphere": {
        "command": "/usr/local/bin/node",
        "args": ["/home/alice/oby/rep.mjs", "mcp"],
        "timeout": 960000
      }
    }
  }
  ```

- **Check:** `gemini mcp list`, or `/mcp` in Gemini CLI. The tools show up as `mcp_obysphere_sphere_ask` and so on.
- **Trust:** with folder trust on, Gemini CLI connects to no MCP server in a folder you haven't trusted (and `gemini mcp list` shows stdio servers as disconnected there). `"trust": true` (or `--trust`) would skip every confirmation; the entry leaves it out, so Gemini asks before each call until you allow it.
- **Limits:** a request times out after 10 minutes by default; the entry gives it 16, since `sphere_ask` can wait 15. Gemini CLI keeps sensitive variables out of a server's environment unless the entry lists them; `rep.mjs` needs none.
- **Source:** https://geminicli.com/docs/tools/mcp-server/ (and, in the gemini-cli repository, `docs/cli/trusted-folders.md` and `docs/reference/configuration.md`) (checked 2026-11-25)

## goose

- **Where:** `~/.config/goose/config.yaml` on macOS and Linux, `%APPDATA%\Block\goose\config\config.yaml` on Windows.
- **The entry**, YAML, under `extensions:` (keep the extensions already there):

  ```yaml
  extensions:
    obysphere:
      name: "obysphere"
      type: "stdio"
      enabled: true
      cmd: "/usr/local/bin/node"
      args: ["/home/alice/oby/rep.mjs", "mcp"]
      envs: {}
      env_keys: []
      timeout: 960
      description: "The Obysphere: ask your teammates' Obys"
  ```

- **Or** `goose configure`, **Add Extension**, **Command-line Extension**: name it obysphere, give the same command (`/usr/local/bin/node /home/alice/oby/rep.mjs mcp`) and a timeout of 960.
- **Try it first** in one session: `goose session --with-extension "/usr/local/bin/node /home/alice/oby/rep.mjs mcp"` (`mcp-config` prints this when your paths have no spaces or quotes).
- **Check:** start a new session; obysphere's tools are in it. In goose Desktop, **Extensions** in the sidebar shows it.
- **Limits:** an extension's timeout is 300 seconds by default, the same as `sphere_ask`'s default wait; the entry gives it 960. goose asks for the newest protocol first (2026-07-28, below).
- **Source:** https://goose-docs.ai/docs/getting-started/using-extensions/ and https://goose-docs.ai/docs/guides/config-files/ (checked 2026-11-25)

## How `rep.mjs mcp` speaks MCP

Checked against the MCP specification (https://modelcontextprotocol.io/specification/versioning, the 2026-07-28 and 2025-11-25 revisions) on 2026-11-25.

- **The handshake (2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25).** `initialize` gets back the version the app asked for when `rep.mjs` speaks it, and 2025-11-25 otherwise; an app that can't speak that disconnects, as the spec says. (Before, any version was echoed back, even one `rep.mjs` doesn't know.) `notifications/initialized` needs nothing.
- **The 2026-07-28 protocol.** It has no handshake: each request names its version in `_meta`. `server/discover` answers with the versions `rep.mjs` speaks (2026-07-28 first), its capabilities and its instructions; results carry `"resultType": "complete"` and the server's name in `_meta`, and `server/discover` and the lists (`tools/list` and the rest) say how long they may be cached (`"ttlMs": 0, "cacheScope": "private"`: ask again each time, and don't share them, since they name you and your folders); a version it doesn't speak gets error `-32022` with the list; a request without `clientCapabilities` gets `-32602`. An app that speaks both (goose; MCP SDKs in "auto" mode) probes with `server/discover` and stays on 2026-07-28. A request that names no version is served the handshake way, so every other app works as before.
- **Batches (2025-03-26).** An array of requests gets one array of answers.
- **Cancelling.** `notifications/cancelled` stops a request still running: `sphere_ask` stops waiting at its next progress report, and nothing more is sent for it. The ask itself stays posted; its answer still arrives in the Sphere.
- **Progress.** When a request has a `progressToken`, `sphere_ask` reports progress at least every 25 seconds while it waits, so apps that reset their time limit on progress keep waiting.
- **Exit.** When stdin closes, `rep.mjs mcp` writes out what it has and exits with 0, within a second. It exits too when the app stops reading its output.
- **Output.** stdout carries MCP messages only; everything else goes to stderr, which the apps keep in their MCP logs.

## Tool schemas

Some apps refuse tool schemas that others take. `test/mcp-hosts.test.mjs` checks every `sphere_*` tool, in your session and in an answering one, against the strictest of their rules:

- the input schema is an object with `properties` (the MCP spec wants an object; VS Code's MCP client adds empty `properties`, validates each schema against JSON Schema draft-07 and leaves out tools that fail);
- every property has a type and a description, an array names its `items`, and `required` lists only its own properties (Gemini CLI hands the schema to the Gemini API nearly as is, and function-calling APIs commonly refuse an array without `items`);
- nothing past a plain schema: no `$ref`, `$schema`, `anyOf`, `oneOf`, `allOf` or type lists (Gemini CLI strips `$schema` and `additionalProperties` and rewrites a type list with `"null"` in it);
- tool names of `a-z`, `0-9`, `_` and `-` (VS Code replaces anything else), 64 characters at most, and Gemini CLI's `mcp_obysphere_<tool>` 63 at most (it shortens longer ones); and a description for every tool (VS Code warns without one).

## Time limits

`sphere_ask` waits for an answer for 300 seconds by default, 900 at most (`wait_seconds`). If an app gives up sooner, nothing is lost: the answer still arrives in the Sphere, and `sphere_check` with the message id gets it.

| App | How long it waits for a tool | The entry |
|---|---|---|
| Claude Code | `MCP_TOOL_TIMEOUT`, about 28 hours by default | as is |
| Cursor | not documented | as is |
| Claude Desktop | not documented | as is |
| VS Code (Copilot) | not documented | as is |
| Gemini CLI | `timeout`, 10 minutes by default | `"timeout": 960000` |
| goose | `timeout`, 300 seconds by default | `timeout: 960` |

## If it doesn't connect

- **Run the entry's command in a terminal**, for example `/usr/local/bin/node /home/alice/oby/rep.mjs mcp`. It prints nothing and waits (Ctrl+D ends it). A problem with your profile ("several profiles here", "not joined yet") is said on stderr, which the app keeps in its MCP log.
- **Say hello to it** by pasting one line and pressing Enter: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}`. It answers with its version and instructions.
- **After updating Node** (Homebrew, nvm, fnm) or moving `rep.mjs`, run `mcp-config --host <app>` again: the entry still has the old paths.
- **On Windows**, the printed commands use POSIX shell quoting; they work as they are in PowerShell when your paths have no single quotes.
