# Duo

A chat interface for LLMs, based on Chat UI, the app that powers the [HuggingChat app on hf.co/chat](https://huggingface.co/chat).

0. [Quickstart](#quickstart)
1. [How Duo stores data](#how-duo-stores-data)
2. [Launch](#launch)
3. [Authentication](#authentication)
4. [Docker image](#docker-image)
5. [Extra parameters](#extra-parameters)
6. [Building](#building)

> [!NOTE]
> Duo speaks only to OpenAI-compatible APIs via `OPENAI_BASE_URL` and the `/models` endpoint. Any service that speaks the OpenAI protocol (llama.cpp server, Ollama, OpenRouter, etc.) works by default.

> [!IMPORTANT]
> Duo is **database-free**. Conversation history lives in the browser (IndexedDB), settings live in `localStorage`, and user identity is carried in an encrypted (iron-session) cookie. The server keeps no per-user state, so nothing needs to be provisioned beyond an OpenAI-compatible endpoint.

## Quickstart

The fastest way to get running is with the Hugging Face Inference Providers router plus your personal Hugging Face access token.

**Step 1 – Create `.env.local`:**

```env
OPENAI_BASE_URL=https://router.huggingface.co/v1
OPENAI_API_KEY=hf_************************
```

`OPENAI_API_KEY` can come from any OpenAI-compatible endpoint you plan to call. Pick the combo that matches your setup:

| Provider                                      | Example `OPENAI_BASE_URL`          | Example key                                                             |
| --------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| Hugging Face Inference Providers router       | `https://router.huggingface.co/v1` | `OPENAI_API_KEY=hf_xxx` (or `HF_TOKEN` legacy alias)                    |
| llama.cpp server (`llama.cpp --server --api`) | `http://127.0.0.1:8080/v1`         | `OPENAI_API_KEY=sk-local-demo` (any string works; llama.cpp ignores it) |
| Ollama (with OpenAI-compatible bridge)        | `http://127.0.0.1:11434/v1`        | `OPENAI_API_KEY=ollama`                                                 |
| OpenRouter                                    | `https://openrouter.ai/api/v1`     | `OPENAI_API_KEY=sk-or-v1-...`                                           |
| Poe                                           | `https://api.poe.com/v1`           | `OPENAI_API_KEY=pk_...`                                                 |

Check the root [`.env` template](./.env) for the full list of optional variables you can override.

**Step 2 – Install and launch the dev server:**

```bash
git clone https://github.com/opengovsg/duo
cd duo
npm install
npm run dev -- --open
```

You now have Duo running locally. Open the browser and start chatting.

## How Duo stores data

Duo does not use a database. All persistence happens in the browser:

- **Conversations** are stored in **IndexedDB** (`duo-cache` database). The browser owns the full message tree; the server generation endpoint is stateless and persists nothing. When the server does respond, its data always overwrites the local cache ("server always wins").
- **Settings** are stored in **`localStorage`** (`duo-settings`).
- **Identity** is carried in an encrypted session cookie sealed with `iron-session` — there is no session store.
- **Offline support**: a service worker plus the IndexedDB cache let the app keep working without a connection.

Because there is no shared server-side store, each browser is the source of record for its own conversations. Clearing site data clears history.

## Launch

After configuring your environment variables, start Duo with:

```bash
npm install
npm run dev
```

The dev server listens on `http://localhost:5173` by default. Use `npm run build` / `npm run preview` for production builds.

## Authentication

Login is **optional**. With no OIDC configured, Duo runs anonymously and everything is stored locally in the browser.

To enable sign-in, configure an OpenID Connect provider and a session secret:

```env
OPENID_CLIENT_ID=...
OPENID_CLIENT_SECRET=...
OPENID_PROVIDER_URL=https://your-issuer/
SESSION_SECRET=<at least 32 characters>   # required when login is enabled
```

Additional options: `OPENID_SCOPES`, `OPENID_NAME_CLAIM`, `OPENID_CONFIG` (JSON5), `ALLOWED_USER_DOMAINS`, `ALLOWED_USER_EMAILS`, `AUTOMATIC_LOGIN`, and cookie controls (`COOKIE_NAME`, `COOKIE_SECURE`, `COOKIE_SAMESITE`, `ALLOW_INSECURE_COOKIES`). For reverse-proxy setups you can trust an upstream-provided identity header via `TRUSTED_EMAIL_HEADER`.

## Docker image

```bash
docker run \
  -p 3000:3000 \
  -e OPENAI_BASE_URL=https://router.huggingface.co/v1 \
  -e OPENAI_API_KEY=hf_*** \
  ghcr.io/opengovsg/duo:latest
```

All environment variables accepted in `.env.local` can be provided as `-e` flags. Because Duo is database-free, no volume or database service is required.

## Extra parameters

### Theming

You can customize the look and feel of Duo. Defaults:

```env
PUBLIC_APP_NAME=Duo
PUBLIC_APP_ASSETS=duo
PUBLIC_APP_DESCRIPTION="Making the community's best AI chat models available to everyone."
PUBLIC_APP_DATA_SHARING=
```

- `PUBLIC_APP_NAME` The name used as a title throughout the app.
- `PUBLIC_APP_ASSETS` Used to find logos & favicons in `static/$PUBLIC_APP_ASSETS`; current option is `duo`.
- `PUBLIC_APP_DATA_SHARING` Set to `1` to add a user-settings toggle for opting into data sharing with model creators.

### Models

Models are discovered from `${OPENAI_BASE_URL}/models`. You can optionally override their metadata via the `MODELS` env var (JSON5). `TASK_MODEL` selects the model used for auxiliary tasks such as conversation-title generation. Authorization uses `OPENAI_API_KEY` (preferred); `HF_TOKEN` remains a legacy alias.

### LLM Router (Optional)

Duo can perform server-side smart routing using a **local heuristic** — no separate router service or selection model is called. The UI exposes a virtual model alias called "Omni" (configurable) that, when selected, chooses the best route/model per message: image inputs go to a `multimodal` route, MCP-tool-enabled requests go to an `agentic` route, and everything else goes to a `default` route.

- Provide a routes policy JSON via `LLM_ROUTER_ROUTES_PATH`. A sample ships at [`config/routes.json`](./config/routes.json). Each entry needs `name`, `description`, `primary_model`, and optional `fallback_models`. The router recognizes the route names `default`, `multimodal`, and `agentic`.
- The default route name is configurable via `LLM_ROUTER_DEFAULT_ROUTE` (default: `default`). If the selected route's models all fail, calls fall back to `LLM_ROUTER_FALLBACK_MODEL`.
- Omni alias configuration: `PUBLIC_LLM_ROUTER_ALIAS_ID` (default `omni`), `PUBLIC_LLM_ROUTER_DISPLAY_NAME` (default `Omni`), and optional `PUBLIC_LLM_ROUTER_LOGO_URL`.

When you select Omni in the UI, Duo will:

- Pick a route locally based on request signals (image attached, MCP server enabled, or default).
- Emit RouterMetadata immediately (route and actual model used) so the UI can display it.
- Stream from the selected model via your configured `OPENAI_BASE_URL`. On errors, it tries route fallbacks in order, then `LLM_ROUTER_FALLBACK_MODEL`.

Tool and multimodal shortcuts:

- Multimodal: If `LLM_ROUTER_ENABLE_MULTIMODAL=true` and the user sends an image, the router bypasses the policy file and uses `LLM_ROUTER_MULTIMODAL_MODEL`. Route name: `multimodal`.
- Tools: If `LLM_ROUTER_ENABLE_TOOLS=true` and the user has at least one MCP server enabled, the router bypasses the policy file and uses `LLM_ROUTER_TOOLS_MODEL`. If that model is missing or misconfigured, it falls back to the heuristic route. Route name: `agentic`.

### MCP Tools (Optional)

Duo can call tools exposed by Model Context Protocol (MCP) servers and feed results back to the model using OpenAI function calling. You can preconfigure trusted servers via env, let users add their own, and optionally have the Omni router auto-select a tools-capable model.

Configure servers (base list for all users):

```env
# JSON array of servers: name, url, optional headers
MCP_SERVERS=[
  {"name": "Web Search (Exa)", "url": "https://mcp.exa.ai/mcp"},
  {"name": "Hugging Face MCP Login", "url": "https://hf.co/mcp?login"}
]

# Forward the signed-in user's Hugging Face token to the official HF MCP login endpoint
# when no Authorization header is set on that server entry.
MCP_FORWARD_HF_USER_TOKEN=true
```

Enable router tool path (Omni):

- Set `LLM_ROUTER_ENABLE_TOOLS=true` and choose a tools-capable target with `LLM_ROUTER_TOOLS_MODEL=<model id or name>`.
- The target must support OpenAI tools/function calling. Duo surfaces a "tools" badge on models that advertise this; you can also force-enable it per-model in settings (see below).

Use tools in the UI:

- Open "MCP Servers" from the top-right menu or from the `+` menu in the chat input to add servers, toggle them on, and run Health Check. The server card lists available tools.
- When a model calls a tool, the message shows a compact "tool" block with parameters, a progress bar while running, and the result (or error). Results are also provided back to the model for follow-up.

Per-model overrides:

- In Settings → Model, you can toggle "Tool calling (functions)" and "Multimodal input" per model. These overrides apply even if the provider metadata doesn't advertise the capability.

## Building

To create a production version of your app:

```bash
npm run build
```

You can preview the production build with `npm run preview`. Duo builds with `adapter-node` by default; run `npm run build:static` (`ADAPTER=static`) for a static build.

> To deploy your app, you may need to install an [adapter](https://kit.svelte.dev/docs/adapters) for your target environment.
