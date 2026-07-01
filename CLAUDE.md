# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Duo is a SvelteKit application that provides a chat interface for LLMs, derived from Chat UI (the app that powers HuggingChat). It is a **database-free** deployment: the server is stateless and the browser owns all conversation state. The app speaks exclusively to OpenAI-compatible APIs via `OPENAI_BASE_URL`.

## Commands

```bash
npm run dev          # Start dev server on localhost:5173
npm run build        # Production build (adapter-node; ADAPTER=static for a static build)
npm run preview      # Preview production build
npm run check        # TypeScript validation (svelte-kit sync + svelte-check)
npm run lint         # Check formatting (Prettier) and linting (ESLint)
npm run format       # Auto-format with Prettier
npm run test         # Run all tests (Vitest)
```

### Running a Single Test

```bash
npx vitest run path/to/file.spec.ts        # Run specific test file
npx vitest run -t "test name"              # Run test by name
npx vitest --watch path/to/file.spec.ts    # Watch mode for single file
```

### Test Environments

Tests are split into three workspaces (configured in vite.config.ts):

- **Client tests** (`*.svelte.test.ts`): Browser environment with Playwright
- **SSR tests** (`*.ssr.test.ts`): Node environment for server-side rendering
- **Server tests** (`*.test.ts`, `*.spec.ts`): Node environment for utilities

## Architecture

### Stack

- **SvelteKit 2** with Svelte 5 (uses runes: `$state`, `$effect`, `$bindable`)
- **TailwindCSS v4** for styling
- **TypeScript** strict mode
- **No database.** Conversation history is persisted client-side in **IndexedDB**; user settings live in **localStorage**. The server keeps no per-user state.

### Storage model (database-free / client-state)

This is the most important thing to understand about the codebase. There is no MongoDB and no server-side persistence layer.

- **Conversations** are owned by the browser. `src/lib/repositories/ConversationRepository.ts` manages an IndexedDB database (`duo-cache`) with two object stores: `conversations` (sidebar list) and `conversation_details` (full message trees). Consistency rule: **server always wins** — server responses overwrite local cache; only server-acknowledged messages are persisted, optimistic state stays in the UI stores.
- **Reactive state** lives in `src/lib/stores/` (Svelte 5 runes). `conversations.svelte.ts` is the sidebar store, seeded from IndexedDB; it is context-scoped (no module-level `$state`) so SSR requests don't share data.
- **Settings** are always stored in `localStorage` (`duo-settings`), never on the server — see `src/lib/stores/settings.ts`.
- **Auth is stateless.** `src/lib/server/auth.ts` uses `iron-session` to seal identity + OAuth tokens into an encrypted cookie; there is no session store. OAuth token refresh is deduped in-process. `ObjectId` from the `mongodb` package is still imported, but only as a deterministic id-generation helper — no database connection is opened.
- **Offline support.** `src/service-worker.ts` plus the `isOnline` store and the IndexedDB cache let the app function without connectivity.

### Key Directories

```
src/
├── lib/
│   ├── components/       # Svelte components (chat/, mcp/, voice/, players/, icons/)
│   ├── repositories/     # ConversationRepository.ts — IndexedDB persistence
│   ├── stores/           # Svelte 5 rune stores (conversations, settings, mcpServers, isOnline, …)
│   ├── workers/          # Web workers (markdownWorker.ts)
│   ├── server/
│   │   ├── api/utils/       # Shared API helpers (requireAuth, resolveModel, superjsonResponse)
│   │   ├── textGeneration/  # LLM streaming pipeline (generate, title, reasoning, artifacts, mcp)
│   │   ├── endpoints/    # OpenAI client + image/message preprocessing
│   │   ├── mcp/          # Model Context Protocol integration
│   │   ├── router/       # Smart model routing (Omni) — local heuristic
│   │   ├── models.ts     # Model registry from OPENAI_BASE_URL/models (+ MODELS override)
│   │   ├── auth.ts       # Stateless OIDC + iron-session sealed-cookie auth
│   │   └── config.ts     # Env-only config manager (no DB-backed runtime config)
│   ├── types/            # TypeScript interfaces (Conversation, Message, User, Model, …)
│   ├── utils/            # Helpers (tree/, marked.ts, createConversation, messageUpdates, …)
│   ├── APIClient.ts      # Typed client for the v2 API
│   └── createShareLink.ts
├── routes/               # SvelteKit file-based routing
│   ├── conversation/[id]/  # Chat page (+page) + stateless generation endpoint (+server)
│   ├── settings/         # User settings pages
│   ├── api/              # Legacy endpoints (mcp, transcribe, fetch-url, models, user)
│   ├── api/v2/           # REST API (models, feature-flags, public-config, user, debug/config)
│   ├── login/ logout/    # OIDC login flow
│   └── models/ privacy/ healthcheck/ metrics/
├── service-worker.ts     # Offline caching
```

### Text Generation Flow

The generation endpoint is **stateless** — it generates and persists nothing.

1. User sends a message; the browser (which owns the conversation tree) `POST`s to `/conversation/[id]` with the model, message history, and any overrides in a `FormData` payload.
2. Server resolves identity from the sealed session cookie (when login is enabled) and validates the request.
3. Server calls the LLM via the OpenAI client (`src/lib/server/endpoints/openai/`) and streams `MessageUpdate` events back (tokens, reasoning, tool calls, router metadata, title).
4. The browser applies the stream to its local tree and persists server-acknowledged messages to IndexedDB.

### Model Context Protocol (MCP)

MCP servers are configured via the `MCP_SERVERS` env var (JSON array of `{name, url, headers?}`); users can also add their own from the UI. When enabled, tools are exposed as OpenAI function calls and results are fed back to the model. The router can auto-select a tools-capable model when `LLM_ROUTER_ENABLE_TOOLS=true`.

### LLM Router (Omni)

Smart routing is done **server-side with a local heuristic** — no separate router service or selection model is called. The UI exposes a virtual "Omni" alias that picks a route per message:

- `multimodal` route for image inputs, `agentic` route for MCP-tool requests, `default` route otherwise.
- Routes policy is a JSON array at `LLM_ROUTER_ROUTES_PATH` (a sample ships at `config/routes.json`). Each entry has `name`, `description`, `primary_model`, and optional `fallback_models`.
- Fallback chain: route models → route `fallback_models` → `LLM_ROUTER_FALLBACK_MODEL`.
- Shortcuts bypass the policy file: `LLM_ROUTER_ENABLE_MULTIMODAL` + `LLM_ROUTER_MULTIMODAL_MODEL`, and `LLM_ROUTER_ENABLE_TOOLS` + `LLM_ROUTER_TOOLS_MODEL`.
- Omni alias display config: `PUBLIC_LLM_ROUTER_ALIAS_ID`, `PUBLIC_LLM_ROUTER_DISPLAY_NAME`, `PUBLIC_LLM_ROUTER_LOGO_URL`.

### Models

Models are discovered from `${OPENAI_BASE_URL}/models`. Metadata can be overridden via the `MODELS` env var (JSON5). `TASK_MODEL` selects the model used for auxiliary tasks like title generation. Authorization uses `OPENAI_API_KEY` (`HF_TOKEN` is a legacy alias).

## Environment Setup

Copy `.env` to `.env.local` and configure at minimum:

```env
OPENAI_BASE_URL=https://router.huggingface.co/v1
OPENAI_API_KEY=hf_***
```

The app is database-free, so there is nothing else to provision. `SESSION_SECRET` (≥32 chars) is required only when OIDC login (`OPENID_CLIENT_ID`) is enabled. See `.env` for the full list (auth, router, MCP, theming, feature flags).

## Code Conventions

- TypeScript strict mode enabled
- ESLint: no `any`, no non-null assertions
- Prettier: tabs, 100 char width, Tailwind class sorting
- Server vs client separation via SvelteKit conventions (`+page.server.ts` vs `+page.ts`)

## Feature Development Checklist

When building new features, consider:

1. **Settings persistence**: Settings live in `localStorage` via `src/lib/stores/settings.ts`. Add new fields to `src/lib/types/Settings.ts` and the store; there is no server-side settings store.
2. **Conversation persistence**: Client-side only — go through `src/lib/repositories/ConversationRepository.ts` and the conversations store, remembering the "server always wins" rule.
3. **Rich dropdowns**: Use `bits-ui` (Select, DropdownMenu) instead of native elements when you need icons/images in options.
4. **Scrollbars**: Use `scrollbar-custom` class for styled scrollbars.
5. **Icons**: Custom icons in `$lib/components/icons/`, use Carbon (`~icons/carbon/*`) or Lucide (`~icons/lucide/*`) for standard icons.
