param(
    [Parameter(Position = 0)]
    [ValidateSet("Dev", "Test", "Lint", "Typecheck", "Smoke")]
    [string]$Task = "Test"
)

$ErrorActionPreference = "Stop"

switch ($Task) {
    "Dev" {
        uvicorn app.main:app --reload --port 8000
    }
    "Test" {
        pytest -q
    }
    "Lint" {
        ruff check .
    }
    "Typecheck" {
        mypy app tests
    }
    "Smoke" {
        python -m app.smoke
    }
}
