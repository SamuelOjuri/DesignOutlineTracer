import pathlib

FORBIDDEN_DEPENDENCIES = [
    "tesseract",
    "paddleocr",
    "documentai",
    "textract",
    "torch",
    "torchvision",
    "transformers",
    "cuda",
    "mlx",
    "segment-anything",
]


def test_main_backend_does_not_add_forbidden_raster_dependencies() -> None:
    pyproject = pathlib.Path("pyproject.toml").read_text(encoding="utf-8").lower()

    for dependency in FORBIDDEN_DEPENDENCIES:
        assert dependency not in pyproject
