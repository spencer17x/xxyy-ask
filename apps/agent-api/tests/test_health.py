from fastapi.testclient import TestClient

from xxyy_agent_api.main import app


def test_health_reports_service_status() -> None:
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "service": "xxyy-agent-api",
        "status": "ok",
        "agent": "langgraph",
    }

