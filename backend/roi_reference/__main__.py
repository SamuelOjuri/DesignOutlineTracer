import argparse
import json
import logging
from pathlib import Path

from pydantic import ValidationError

from .contracts import TASKS, ReferenceError
from .evaluation import audit_manifest, check_fixtures, evaluate, load_manifest
from .runner import INPUT_VARIANTS, ROOT, read_bounded_json, run_reference


EVALUATION = ROOT.parents[1] / "docs/roi-evaluation"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Offline-first ROI reference tooling. Live runs send images to Google.")
    commands = parser.add_subparsers(dest="command", required=True)
    fixtures = commands.add_parser("fixtures", help="Validate synthetic response contracts without networking")
    fixtures.add_argument("--path", type=Path, default=EVALUATION / "response-fixtures.json")
    audit = commands.add_parser("audit", help="Report missing domain review and dataset coverage")
    audit.add_argument("--manifest", type=Path, default=EVALUATION / "manifest.json")
    evaluation = commands.add_parser("evaluate", help="Score one complete run set; never calls a provider")
    evaluation.add_argument("--manifest", type=Path, default=EVALUATION / "manifest.json")
    evaluation.add_argument("--runs", type=Path, required=True)
    evaluation.add_argument("--split", choices=("development", "held_out"), required=True)
    evaluation.add_argument("--iou-threshold", type=float, required=True)
    run = commands.add_parser("run", help="Prepare locally or explicitly authorize ONE billable request")
    run.add_argument("--image", type=Path, required=True)
    run.add_argument("--case-id", required=True)
    run.add_argument("--input-variant", choices=INPUT_VARIANTS, required=True)
    run.add_argument("--task", choices=TASKS, default="roof_roi")
    run.add_argument("--profile", choices=("reference", "json", "json-minimal"), default="reference")
    run.add_argument("--provider", choices=("developer", "vertex"), default="developer")
    run.add_argument("--parents", type=Path)
    run.add_argument("--prepare-only", action="store_true")
    run.add_argument("--allow-live", action="store_true")
    run.add_argument("--max-calls", type=int, default=0)
    run.add_argument("--max-output-tokens", type=int, default=4096)
    arguments = parser.parse_args(argv)
    logging.disable(logging.CRITICAL)
    try:
        if arguments.command == "fixtures":
            result = check_fixtures(arguments.path)
        elif arguments.command == "audit":
            result = audit_manifest(load_manifest(arguments.manifest), arguments.manifest.parent)
        elif arguments.command == "evaluate":
            result = evaluate(arguments.manifest, arguments.runs, arguments.split, arguments.iou_threshold)
        else:
            directory, result = run_reference(
                arguments.image, case_id=arguments.case_id, input_variant=arguments.input_variant,
                task=arguments.task, profile=arguments.profile, provider=arguments.provider,
                parents=read_bounded_json(arguments.parents) if arguments.parents else None,
                prepare_only=arguments.prepare_only, allow_live=arguments.allow_live,
                max_calls=arguments.max_calls, max_output_tokens=arguments.max_output_tokens,
            )
            result = {"status": result["status"], "request_id": result["request_id"],
                      "error": result.get("error"), "artifacts": str(directory)}
        print(json.dumps(result, indent=2, allow_nan=False))
        return 2 if result.get("status") in ("error", "partial", "blocked") else 0
    except ReferenceError as error:
        print(json.dumps({"status": "error", "error": error.code}))
    except (ValidationError, OSError, ValueError, KeyError, TypeError):
        print(json.dumps({"status": "error", "error": "invalid_local_input_or_configuration"}))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())