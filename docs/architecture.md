# Architecture

XXYY Ask is organized as an interview-ready AI application with a real product surface and a clear agent backend.

## System Components

```text
Web chat UI
  -> Agent API
    -> LangGraph workflow
      -> query rewrite
      -> document retrieval
      -> reranking
      -> answer drafting
      -> citation check
  -> Supabase Postgres + pgvector
  -> OpenAI Responses API

Telegram bot
  -> Agent API
```

## Why This Shape

- The web app demonstrates product delivery and streaming chat UX.
- The FastAPI service demonstrates production API design in the Python AI ecosystem.
- LangGraph demonstrates stateful agent orchestration instead of a single prompt call.
- LangChain can be used selectively for document loading, splitting, and retriever interfaces.
- Supabase Postgres with pgvector keeps documents, embeddings, chat logs, and feedback in one database.
- LangSmith-ready environment variables make traces and evaluations easy to add.

## Initial Agent Graph

The initial graph is intentionally small:

```text
classify_intent -> retrieve_context -> draft_answer
```

Future iterations should replace the placeholder retrieval node with a real RAG pipeline:

```text
query_rewrite -> hybrid_retrieve -> rerank -> answer -> citation_check -> fallback
```

## Interview Talking Points

- RAG quality depends on ingestion, chunking, metadata, retrieval, reranking, and evaluation.
- Agent orchestration is useful when the workflow needs explicit state, retries, fallbacks, and tool calls.
- Citations are a product requirement, not decoration; every answer should be source-grounded.
- Evaluation should include retrieval metrics and answer-quality metrics, not only manual demos.

