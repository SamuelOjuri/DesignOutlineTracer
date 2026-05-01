.PHONY: dev test lint typecheck smoke

dev:
	uvicorn app.main:app --reload --port 8000

test:
	pytest -q

lint:
	ruff check .

typecheck:
	mypy app tests

smoke:
	python -m app.smoke
