# Remote deployment (this fork)

This fork adds a Streamable HTTP transport on top of upstream
[marcomoauro/substack-mcp](https://github.com/marcomoauro/substack-mcp), so the server can run as a
persistent remote service (e.g. on [Zeabur](https://zeabur.com)) and be reached from claude.ai
web/mobile — not just from a local stdio MCP client like Claude Desktop. It follows the same pattern
as [jackyckma/cursoragentmcp](https://github.com/jackyckma/cursoragentmcp).

Local stdio use is unaffected: run `node src/index.js` with no `TRANSPORT` set (or `TRANSPORT=stdio`)
and it behaves exactly like upstream.

## Why this needs more care than a typical remote MCP server

`SUBSTACK_SESSION_TOKEN` is not a scoped API key. It is your actual Substack login session — whoever
holds it can do anything your browser session can do: publish, delete, export your full subscriber
list with emails, or email your entire list. Running this remotely means that token sits in an
environment variable on a public host instead of on your own machine. Two things make that
acceptable:

1. **`MCP_SERVER_TOKEN`** gates the `/mcp` endpoint with a bearer token. Without it, anyone who finds
   the URL can call every registered tool. This is not optional for a public deployment.
2. **`SUBSTACK_MCP_ALLOWED_TOOLS`** narrows which of the 27 tools this deployment registers at all —
   see the recommendation below. Even if `MCP_SERVER_TOKEN` were ever compromised, a narrow allowlist
   bounds the damage to what's actually registered.

Session tokens also don't last indefinitely — expect to refresh `SUBSTACK_SESSION_TOKEN` in your
deployment's environment variables occasionally (see the main README's credential-collection steps).

## New environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TRANSPORT` | `stdio` (Node entrypoint) / `http` (this Docker image) | `http` for remote deployment, `stdio` for local MCP clients. |
| `PORT` | `3000` | HTTP port. Zeabur sets this automatically. |
| `MCP_SERVER_TOKEN` | *(unset — insecure)* | Bearer token required on the `/mcp` endpoint. **Required for any public deployment.** |
| `SUBSTACK_MCP_ALLOWED_TOOLS` | *(unset — all 27 tools)* | Comma-separated tool names to register. Unset keeps upstream's full behavior. |

The three original `SUBSTACK_PUBLICATION_URL` / `SUBSTACK_SESSION_TOKEN` / `SUBSTACK_USER_ID`
variables are unchanged — see the main [README](../README.md) for how to collect them.

## Recommended tool allowlist

For an agent whose job is drafting and publishing your own posts, the reader-side tools (which read
`substack.com` generally, not your publication) and the subscriber/administrative tools add risk
without adding anything to that job. Recommended value for `SUBSTACK_MCP_ALLOWED_TOOLS`:

```
create_draft_post,set_post_body,upload_image,update_draft,publish_draft,list_posts,get_draft,list_publication_tags,get_post_tags,add_tag_to_post,get_publication
```

That's 11 of the 27 tools — everything needed to draft, format, illustrate, tag and publish a post,
plus enough read access to check what's already there. Excluded, and why:

| Tool | Why excluded |
|---|---|
| `delete_draft` | Destructive; not needed to publish. |
| `export_subscribers` | Bulk-exports subscriber emails and every engagement metric. |
| `list_subscribers` | Enumerates subscriber PII (name, email, country…). |
| `comment_on_post` | Posts publicly under your name; server has no way to delete it. |
| `get_post_comments` | Not needed for publishing; low risk but out of scope. |
| `get_user_profile` | Reveals every publication the session has a role on; out of scope. |
| `list_subscriptions`, `list_reader_posts`, `get_reader_post`, `get_reader_feed`, `get_profile_feed`, `get_comment_thread` | The seven reader-side tools — read `substack.com` generally, not your publication. Unrelated to publishing your own posts. |
| `restack_item` | Public, irreversible from this server, and reader-side. |
| `get_publication_stats`, `get_post_stats`, `get_analytics` | Read-only and lower risk, but not needed for the publishing workflow. Safe to add back later if you want analytics access from the same deployment. |

Adjust the list to taste — it's a plain comma-separated string, and adding a tool back just means
adding its name.

## Deploying on Zeabur

1. In Zeabur, create a new service from this GitHub repo (your fork). Zeabur detects the
   `Dockerfile` automatically.
2. Set environment variables on the service:
   - `SUBSTACK_PUBLICATION_URL`, `SUBSTACK_SESSION_TOKEN`, `SUBSTACK_USER_ID` — from the main
     README's credential-collection steps.
   - `MCP_SERVER_TOKEN` — a random secret you generate yourself, e.g. `openssl rand -hex 32`.
   - `SUBSTACK_MCP_ALLOWED_TOOLS` — the recommended value above, or your own narrower/wider list.
   - `PORT` is injected automatically by Zeabur; `TRANSPORT` already defaults to `http` in this
     image, so neither needs to be set.
3. Deploy. The MCP endpoint is `https://<your-service>.zeabur.app/mcp`; `GET /health` confirms the
   service is up.

## Connecting from claude.ai

1. **Customize → Connectors → Add custom connector.**
2. **Remote MCP server URL**: `https://<your-service>.zeabur.app/mcp`.
3. **Authentication**: None (this server doesn't use OAuth).
4. **Request headers** (beta — may not be visible on all accounts yet): add header
   `Authorization: Bearer <your MCP_SERVER_TOKEN>` (note the space after `Bearer`), marked
   **Required**.
5. In a conversation, click **+ → Add connectors** and toggle it on — connectors are enabled
   per-conversation, not globally.

## Security notes

- Never commit `.env`, `SUBSTACK_SESSION_TOKEN`, or `MCP_SERVER_TOKEN` to this repo.
- Rotate `SUBSTACK_SESSION_TOKEN` when it expires (sign in again, repeat the README's steps) and
  `MCP_SERVER_TOKEN` periodically.
- This server logs one JSON line per tool call and request on stderr; `SUBSTACK_MCP_LOG_LEVEL` still
  applies remotely. Session tokens, cookies and auth headers are redacted by key name before they
  reach a log line — see `src/logger.js`.
