from fastapi import FastAPI
from pydantic import BaseModel, Field

from xxyy_agent_api.graph import agent_graph

app = FastAPI(
    title="XXYY Ask Agent API",
    description="LangGraph-powered agent API for source-grounded XXYY support.",
    version="0.1.0",
)


class ChatRequest(BaseModel):
    question: str = Field(min_length=1)


class ChatResponse(BaseModel):
    answer: str
    citations: list[dict[str, str]]


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "service": "xxyy-agent-api",
        "status": "ok",
        "agent": "langgraph",
    }


@app.post("/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    result = agent_graph.invoke({"question": request.question})
    return ChatResponse(
        answer=result["answer"],
        citations=result.get("citations", []),
    )

