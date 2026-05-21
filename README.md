# XXYY Ask

XXYY Ask is an interview-ready AI agent application that turns `docs.xxyy.io` into a searchable knowledge base and exposes it through a web support page and Telegram bot.

The project is intentionally structured to demonstrate real AI application skills: RAG, agent orchestration, tool calling, source-grounded answers, evaluation, observability, and product delivery.

## Tech Stack

- **Web:** Next.js, TypeScript, Vercel AI SDK
- **Agent API:** FastAPI, LangGraph, LangChain
- **LLM:** OpenAI SDK and Responses API
- **Knowledge Store:** Supabase Postgres with pgvector
- **Bot:** Telegram bot integration
- **Observability:** LangSmith-ready tracing and evaluation hooks

## Repository Layout

```text
apps/web          Next.js chat interface for Ask XXYY
apps/agent-api    FastAPI service with the LangGraph agent workflow
apps/bot          Telegram bot entrypoint
packages/shared   Shared TypeScript types for the web app
docs              Architecture notes and decisions
```

## Quick Start

Copy the environment file:

```bash
cp .env.example .env
```

Install JavaScript dependencies:

```bash
pnpm install
```

Install Python dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

Start the agent API:

```bash
pnpm dev:api
```

Start the web app:

```bash
pnpm dev:web
```

## Roadmap

1. Crawl and normalize `docs.xxyy.io`.
2. Chunk documents with source metadata.
3. Embed chunks into Supabase pgvector.
4. Build a LangGraph workflow for query rewrite, retrieval, reranking, answering, and citation checks.
5. Add Web and Telegram clients.
6. Add evaluation datasets, traces, and interview-friendly architecture notes.

