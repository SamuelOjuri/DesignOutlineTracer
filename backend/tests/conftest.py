from pathlib import Path

import fitz
import pytest


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


@pytest.fixture(scope="session")
def docs_dir(repo_root: Path) -> Path:
    return repo_root / "docs"


@pytest.fixture(scope="session")
def tp17202_pdf(docs_dir: Path) -> Path:
    return docs_dir / "TP17202_25.01_input.pdf"


@pytest.fixture(scope="session")
def tp17221_pdf(docs_dir: Path) -> Path:
    return docs_dir / "TP17221_25.01_input.pdf"


@pytest.fixture(scope="session")
def tp17256_pdf(docs_dir: Path) -> Path:
    return docs_dir / "TP17256_25.01 - A - input.pdf"


@pytest.fixture(scope="session")
def tp17221_raster_clean_pdf(tmp_path_factory: pytest.TempPathFactory, tp17221_pdf: Path) -> Path:
    output = tmp_path_factory.mktemp("rasterized") / "TP17221_raster_clean.pdf"
    _render_image_only_pdf(tp17221_pdf, output, dpi=120)
    return output


@pytest.fixture(scope="session")
def tp17221_raster_lowres_noisy_pdf(
    tmp_path_factory: pytest.TempPathFactory,
    tp17221_pdf: Path,
) -> Path:
    output = tmp_path_factory.mktemp("rasterized") / "TP17221_raster_lowres_noisy.pdf"
    _render_image_only_pdf(tp17221_pdf, output, dpi=72)
    return output


def _render_image_only_pdf(source: Path, output: Path, dpi: int) -> None:
    with fitz.open(source) as document:
        page = document[0]
        pixmap = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), alpha=False)
        image_pdf = fitz.open()
        rect = fitz.Rect(0, 0, page.rect.width, page.rect.height)
        new_page = image_pdf.new_page(width=rect.width, height=rect.height)
        new_page.insert_image(rect, stream=pixmap.tobytes("png"))
        image_pdf.save(output)
        image_pdf.close()
