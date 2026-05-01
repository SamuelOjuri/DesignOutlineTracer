import json

from fastapi.testclient import TestClient

from app.main import app


def main() -> None:
    response = TestClient(app).get("/health")
    response.raise_for_status()
    print(json.dumps({"health": response.json()["status"]}))


if __name__ == "__main__":
    main()
