# Project Initialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Initialize XXYY Ask as an interview-ready AI agent and RAG application scaffold.

**Architecture:** Use a TypeScript monorepo for the web layer and shared types, plus a Python FastAPI service for the agent core. The initial LangGraph workflow is a placeholder that establishes the orchestration boundary for later RAG, reranking, citation checks, and fallback logic.

**Tech Stack:** Next.js, Vercel AI SDK, FastAPI, LangGraph, LangChain, OpenAI SDK, Supabase Postgres with pgvector, Telegram bot, LangSmith-ready observability.

---

### Task 1: Repository Metadata

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Create: `.gitignore`
- Create: `.editorconfig`
- Create: `.env.example`

- [x] Add MIT license.
- [x] Add ignore rules for Node, Python, local env files, logs, local data, and editor files.
- [x] Add environment variable examples for OpenAI, Supabase, Telegram, agent API, and LangSmith.

### Task 2: Workspace Configuration

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `pyproject.toml`

- [x] Configure pnpm workspace for `apps/web` and `packages/*`.
- [x] Configure Python dependencies for FastAPI, LangGraph, LangChain, OpenAI, Supabase, Telegram, pytest, and Ruff.
- [x] Add root scripts for web dev, API dev, Python tests, and linting.

### Task 3: Web App Scaffold

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/next.config.mjs`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/page.tsx`
- Create: `apps/web/src/app/globals.css`
- Create: `apps/web/src/lib/config.ts`

- [x] Add a Next.js app shell for Ask XXYY.
- [x] Add a realistic support chat interface placeholder.
- [x] Add agent API URL configuration.

### Task 4: Agent API Scaffold

**Files:**
- Create: `apps/agent-api/src/xxyy_agent_api/main.py`
- Create: `apps/agent-api/src/xxyy_agent_api/graph.py`
- Create: `apps/agent-api/src/xxyy_agent_api/settings.py`
- Create: `apps/agent-api/tests/test_health.py`

- [x] Add a FastAPI app with `/health`.
- [x] Add `/chat` backed by a minimal LangGraph workflow.
- [x] Add a health-check test.

### Task 5: Bot and Shared Types

**Files:**
- Create: `apps/bot/src/xxyy_ask_bot/main.py`
- Create: `packages/shared/src/index.ts`

- [x] Add Telegram bot polling entrypoint.
- [x] Add shared `ChatRequest`, `ChatResponse`, and `Citation` types.

### Task 6: Documentation

**Files:**
- Create: `docs/architecture.md`
- Create: `docs/decisions/0001-interview-stack.md`

- [x] Document the selected interview-oriented architecture.
- [x] Document why this stack is heavier than a pure MVP stack.

