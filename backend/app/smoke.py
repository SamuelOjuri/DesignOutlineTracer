import json

from fastapi.testclient import TestClient

from app.config import REPO_ROOT
from app.main import app


def main() -> None:
    sample_pdf = REPO_ROOT / "docs" / "TP17221_25.01_input.pdf"
    with TestClient(app) as client, sample_pdf.open("rb") as pdf:
        health_response = client.get("/health")
        health_response.raise_for_status()

        upload_response = client.post(
            "/api/documents",
            files={"file": (sample_pdf.name, pdf, "application/pdf")},
        )
        upload_response.raise_for_status()

    data = upload_response.json()
    print(
        json.dumps(
            {
                "health": health_response.json()["status"],
                "source_type": data["classification"]["source_type"],
                "recommended_pipeline": data["classification"]["recommended_pipeline"],
                "vector_path_count": data["classification"]["vector_path_count"],
                "preview": data["preview_png_path"],
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
