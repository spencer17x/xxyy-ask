# ADR 0001: Interview-Oriented AI Agent Stack

## Status

Accepted

## Context

The project should help demonstrate AI agent and AI application development skills in interviews. A minimal custom RAG system would be enough for production MVP work, but it would under-show agent orchestration, tracing, evaluation, and framework familiarity.

## Decision

Use a Python agent core with a TypeScript product layer:

- Next.js and Vercel AI SDK for the web support UI.
- FastAPI for the agent API.
- LangGraph for agent workflow orchestration.
- LangChain selectively for RAG building blocks.
- OpenAI SDK and Responses API for model calls.
- Supabase Postgres with pgvector for structured storage and vector retrieval.
- Telegram bot integration as a second channel.
- LangSmith-compatible configuration for traces and evaluations.

## Consequences

This stack is heavier than a pure TypeScript service, but it creates stronger interview signal. It shows practical RAG, agent state, tool orchestration, product UX, and evaluation thinking in one project.

