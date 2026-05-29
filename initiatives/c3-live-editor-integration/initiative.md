# Initiative: C3 Live Editor Integration

> **Status: not started (deferred).** This is additive work on top of the shipped file-based MCP server. It was carved out of the retired c3-mcp-server initiative (see [docs/mcp-architecture.md](../../docs/mcp-architecture.md) for the architecture rationale and the C3 Editor SDK research that scopes what is even possible here). Reach for this only once file-based usage reveals a concrete need for a *live* editor connection.

## Goal

Extend construct3-chef beyond on-disk JSON mutation to interact with a **running C3 editor** — saving, previewing, reading error dialogs, and (further out) live instance/property manipulation and bidirectional sync.

## Why this is deferred, and what bounds it

The C3 Editor SDK **does not expose** event-sheet read/write, layout-structure manipulation, variable/data manipulation, or project filesystem access (full findings in [docs/mcp-architecture.md § C3 Editor SDK capabilities](../../docs/mcp-architecture.md#c3-editor-sdk-capabilities-research)). So the file-based server remains the primary surface for all structural edits. A live bridge can only add what the SDK *does* expose — instance/property CRUD, object-type creation, editor rendering — plus whatever can be driven through the editor's DOM (menus, dialogs, toolbar) via browser automation. Everything below is scoped to that ceiling.

A single MCP server process should host both file tools and editor tools: one `.mcp.json` entry, one lifecycle, a unified namespace. File and editor tools often compose (apply recipe → save in editor → preview → check errors), and MCP has no cross-server communication, so coordination must live in one process.

## Track A — C3 Editor Browser Automation (Playwright)

Use `playwright` as a **Node.js library inside the MCP server process** — not a separate MCP. The standalone `@playwright/mcp` package is for *exploration only* (manually discovering DOM selectors); once selectors are known they are baked into stable wrapper tools.

**Proposed tools:**

| Tool | Description | Browser action |
| ---- | ----------- | -------------- |
| `editor-save` | Save the open project | Menu → Project → Save (or Ctrl+S) |
| `editor-preview` | Start/stop project preview | Click Preview button |
| `editor-read-errors` | Read open error/warning dialogs | Snapshot dialog DOM, extract text |
| `editor-dismiss-dialog` | Click OK/Cancel on a dialog | Find dialog button, click |
| `editor-open-project` | Open a cloud project by name | Navigate to editor, open from cloud |
| `editor-snapshot` | Read current editor state | Accessibility-tree snapshot of key UI areas |

**Considerations / known traps:**

- **Authentication** — the editor requires login; use a persistent browser profile (`--user-data-dir`) so the session survives across tool calls.
- **DOM stability** — C3's menu/dialog DOM may shift across editor versions; document selectors and keep them easy to update.
- **Canvas limits** — the layout-editor viewport is canvas-rendered and *not* DOM-automatable. Menus, dialogs, toolbar, and project bar are regular DOM and are automatable.
- **Native file dialogs** — "Open local project" triggers an OS file picker (not automatable). Use cloud save or drag-and-drop workarounds.
- **Session lifecycle** — one long-lived browser, launched lazily on first editor tool call, reused for the session, closed on server exit.

**Plan:**

1. Explore C3 editor DOM with raw `@playwright/mcp` tools.
2. Document reliable selectors for save, preview, dialogs, error panels.
3. Add `playwright` as a server dependency.
4. Implement a browser session manager (lazy launch, persistent profile, reuse).
5. Implement the editor tools.
6. Test the full loop: apply recipe → save in editor → preview → check errors.

## Track B — C3 Addon Bridge (WebSocket relay)

A WebSocket relay in the MCP server plus a C3 editor addon (single-global plugin) that connects to it. Limited to SDK-exposed operations.

**Proposed live-editor tools:**

| Tool | Description | SDK API |
| ---- | ----------- | ------- |
| `list-instances` | List instances in current layout | `IProject` → layout → instances |
| `create-instance` | Create object instance in layout | `objectType.CreateWorldInstance()` |
| `set-instance-property` | Set instance property | `instance.SetPropertyValue()` |
| `set-instance-position` | Set instance position/size | `instance.SetXY()`, `SetSize()` |
| `get-instance-property` | Read instance property | `instance.GetPropertyValue()` |
| `create-object-type` | Create new object type | `project.CreateObjectType()` |
| `refresh-layout` | Refresh layout view | `layoutView.Refresh()` |

**Architecture:** MCP server runs a WebSocket server on a local port; the single-global addon connects from the editor; tool calls forward to the addon, which executes SDK methods; responses relay back. Request correlation via UUID, with timeout and reconnection handling. Addon shape is the standard `.c3addon` layout (`addon.json`, `aces.json`, editor `plugin/type/instance.js`, `c3runtime/` with a `domSide.js` WebSocket client) — see [docs/mcp-architecture.md § C3 addon structure](../../docs/mcp-architecture.md#c3-addon-structure-reference).

**Plan:**

1. Create the addon skeleton (single-global plugin).
2. Implement the WebSocket client in the addon's `domSide.js`.
3. Add a WebSocket server to the MCP server.
4. Implement the relay pattern (correlation, timeouts, reconnection).
5. Add the live editor tools (instance CRUD, properties).
6. Package as `.c3addon` and test in the editor.

## Track C — Advanced / bidirectional integration (speculative)

Furthest-out ideas, dependent on A and/or B landing first:

- **Bidirectional sync** — editor changes push notifications to the MCP server.
- **Live preview** — server triggers C3 preview builds.
- **Collaborative editing** — multiple Claude Code sessions share C3 state.
- **Internal API exploration** — investigate undocumented editor internals beyond the SDK.

## Design decisions (inherited)

- **Browser automation lives inside the MCP server**, not as a separate MCP — one process, one config entry, unified namespace; `@playwright/mcp` is exploration-only.
- **Persistent browser profile** (`--user-data-dir`) to keep the editor login across tool calls; browser launched lazily, reused for the session.
- **Addon Bridge stays deferred** until file-based usage proves its necessity.
