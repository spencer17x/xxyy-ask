from typing import NotRequired, TypedDict

from langgraph.graph import END, StateGraph


class Citation(TypedDict):
    title: str
    url: str


class AgentState(TypedDict):
    question: str
    intent: NotRequired[str]
    answer: NotRequired[str]
    citations: NotRequired[list[Citation]]


def classify_intent(state: AgentState) -> AgentState:
    return {**state, "intent": "documentation_support"}


def retrieve_context(state: AgentState) -> AgentState:
    citation = {
        "title": "XXYY documentation",
        "url": "https://docs.xxyy.io",
    }
    return {**state, "citations": [citation]}


def draft_answer(state: AgentState) -> AgentState:
    question = state["question"].strip()
    answer = (
        "The knowledge base scaffold is ready. After ingestion is implemented, "
        f"I will answer this question from indexed XXYY docs: {question}"
    )
    return {**state, "answer": answer}


def build_agent_graph():
    graph = StateGraph(AgentState)
    graph.add_node("classify_intent", classify_intent)
    graph.add_node("retrieve_context", retrieve_context)
    graph.add_node("draft_answer", draft_answer)
    graph.set_entry_point("classify_intent")
    graph.add_edge("classify_intent", "retrieve_context")
    graph.add_edge("retrieve_context", "draft_answer")
    graph.add_edge("draft_answer", END)
    return graph.compile()


agent_graph = build_agent_graph()

