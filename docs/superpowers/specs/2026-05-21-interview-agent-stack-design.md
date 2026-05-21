# Interview Agent Stack Design

## Goal

Initialize XXYY Ask as an interview-ready AI agent application that can grow into a source-grounded docs support assistant.

## Scope

The initial scaffold includes the repository structure, MIT license, environment examples, Next.js web app, FastAPI agent API, LangGraph placeholder workflow, Telegram bot entrypoint, shared TypeScript types, and architecture docs.

## Architecture

The web app and Telegram bot call a FastAPI service. The FastAPI service owns the LangGraph workflow. The graph starts with a small placeholder flow and will later expand into query rewriting, RAG retrieval, reranking, answer generation, citation checks, and fallback handling.

## Data Flow

```text
user question -> client -> FastAPI /chat -> LangGraph -> answer + citations -> client
```

Future ingestion will crawl `docs.xxyy.io`, normalize content, split it into chunks, generate embeddings, and store chunks in Supabase Postgres with pgvector.

## Testing

The scaffold includes a FastAPI health-check test. Full test execution requires Python dependencies from `pyproject.toml`.

