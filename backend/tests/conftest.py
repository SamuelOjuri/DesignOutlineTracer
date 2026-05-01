from pathlib import Path

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
