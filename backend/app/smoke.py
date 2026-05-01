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
    with TestClient(app) as client:
        vector_response = client.get(f"/api/documents/{data['document_id']}/vector")
        vector_response.raise_for_status()
        candidates_response = client.get(f"/api/documents/{data['document_id']}/candidates")
        candidates_response.raise_for_status()

    vector_data = vector_response.json()
    candidates_data = candidates_response.json()
    print(
        json.dumps(
            {
                "health": health_response.json()["status"],
                "source_type": data["classification"]["source_type"],
                "recommended_pipeline": data["classification"]["recommended_pipeline"],
                "vector_path_count": data["classification"]["vector_path_count"],
                "text_blocks": vector_data["summary"]["text_block_count"],
                "rwp_labels": vector_data["summary"]["rwp_labels"],
                "rooflight_rectangles": vector_data["summary"]["rooflight_rectangle_count"],
                "top_candidate_id": candidates_data["summary"]["top_candidate_id"],
                "top_candidate_score": candidates_data["summary"]["top_candidate_score"],
                "preview": data["preview_png_path"],
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
