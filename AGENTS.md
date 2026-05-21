# AGENTS.md

## Project Goal

XXYY Ask is an interview-focused AI Agent project. The goal is not to generate a complete system all at once, but to build a clear AI application step by step: agent workflow, tool calling, RAG, evaluation, observability, a web support page, and a Telegram bot.

## Collaboration Rules

- Implement one small capability at a time. Do not generate large amounts of code in one pass.
- Before writing code, explain the concept, design, and trade-offs in English.
- For non-trivial changes, propose a small plan and wait for user confirmation before editing.
- Prefer small commits. Each commit should demonstrate one clear interview concept.
- After each step, include how to explain the work in an interview.
- Code should support learning and demonstration. Do not add complexity just to show off.

## Tech Stack

- Web: Next.js, TypeScript, Vercel AI SDK
- Agent API: FastAPI, Python
- Agent orchestration: LangGraph
- RAG components: LangChain where useful
- Database: Supabase Postgres, pgvector
- Model calls: OpenAI SDK, Responses API
- Observability: LangSmith or equivalent tracing
- Bot: Telegram

## Development Order

1. Minimal Agent API
2. Tool calling
3. Document crawling and cleaning
4. Embeddings and pgvector retrieval
5. LangGraph workflow
6. Citation checking and refusal strategy
7. Evaluation and tracing
8. Web support page
9. Telegram bot

## Interview Focus

- Explain what an Agent is and how it differs from a normal chatbot.
- Explain why tool calling is needed instead of relying only on prompts.
- Explain the full RAG pipeline: ingestion, chunking, embedding, retrieval, generation, and citation.
- Explain why LangGraph is useful for managing multi-step state.
- Show how to evaluate answer quality, retrieval quality, latency, and cost.
- Explain the trade-offs behind each technology choice instead of only naming tools.

