from datetime import datetime, timezone
from hashlib import sha256
from importlib.metadata import version
import json
import os
from pathlib import Path
import re
from time import perf_counter
from typing import Any
from uuid import uuid4

from .contracts import (
    MAX_OBJECTS, MAX_RESPONSE_BYTES, MODEL, TASKS, ReferenceError,
    load_json, parse_response, response_schema, validate_box,
)
from .images import PreparedImage, prepare_image


ROOT = Path(__file__).resolve().parent
PROMPTS = {
    "roof_roi": "roof-roi-v1",
    "penetration": "penetration-draft-v1",
    "rainwater_outlet": "outlet-draft-v1",
}
INPUT_VARIANTS = ("original_jpeg", "pdfjs_page", "other_raster", "synthetic")


def read_config() -> dict:
    config = load_json((ROOT / "config.json").read_text(encoding="utf-8"))
    if config["model"] != MODEL or config["attempts"] != 1:
        raise ReferenceError("reference_configuration_mismatch")
    return config


def read_bounded_json(path: Path) -> Any:
    with path.open("rb") as source:
        data = source.read(MAX_RESPONSE_BYTES + 1)
    if len(data) > MAX_RESPONSE_BYTES:
        raise ReferenceError("json_file_too_large")
    try:
        return load_json(data.decode("utf-8"))
    except UnicodeError:
        raise ReferenceError("invalid_json_encoding") from None


def validate_parents(parents: Any, source_hash: str) -> tuple[str, ...]:
    if not isinstance(parents, dict) or set(parents) != {"source_sha256", "revision", "rois"}:
        raise ReferenceError("invalid_parent_context")
    if parents["source_sha256"] != source_hash:
        raise ReferenceError("parent_image_mismatch")
    if type(parents["revision"]) is not int or parents["revision"] < 1:
        raise ReferenceError("invalid_roi_revision")
    rois = parents["rois"]
    if not isinstance(rois, list) or not 1 <= len(rois) <= MAX_OBJECTS:
        raise ReferenceError("invalid_parent_context")
    identifiers = []
    for roi in rois:
        if not isinstance(roi, dict) or set(roi) != {"id", "box_2d"}:
            raise ReferenceError("invalid_parent_context")
        identifier = roi["id"]
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", identifier):
            raise ReferenceError("invalid_parent_id")
        validate_box(roi["box_2d"])
        if identifier in identifiers:
            raise ReferenceError("duplicate_parent_id")
        identifiers.append(identifier)
    return tuple(identifiers)


def build_request(
    prepared: PreparedImage, *, task: str, profile: str, case_id: str,
    input_variant: str, provider: str, max_output_tokens: int, parents: Any = None,
) -> dict:
    config = read_config()
    if task not in TASKS or profile not in config["profiles"]:
        raise ReferenceError("invalid_task_or_profile")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", case_id):
        raise ReferenceError("invalid_case_id")
    if input_variant not in INPUT_VARIANTS or provider not in ("developer", "vertex"):
        raise ReferenceError("invalid_input_variant_or_provider")
    if type(max_output_tokens) is not int or not 1 <= max_output_tokens <= config["max_output_tokens"]:
        raise ReferenceError("invalid_output_budget")
    parent_ids = ()
    if task != "roof_roi":
        if profile == "reference":
            raise ReferenceError("child_task_requires_json_profile")
        parent_ids = validate_parents(parents, prepared.source_sha256)
    elif parents is not None:
        raise ReferenceError("roof_task_cannot_have_parents")
    prompt = (ROOT / "prompts" / f"{PROMPTS[task]}.txt").read_text(encoding="utf-8")
    system = (ROOT / "prompts/system-reference-v1.txt").read_text(encoding="utf-8")
    settings = config["profiles"][profile]
    if profile != "reference":
        system += "\n" + (ROOT / "prompts/contract-v1.txt").read_text(encoding="utf-8")
    if parents is not None:
        prompt += "\nAccepted ROI context:\n" + json.dumps(parents, sort_keys=True)
    generation_config = {
        "system_instruction": system,
        "temperature": config["temperature"],
        "max_output_tokens": max_output_tokens,
        "automatic_function_calling": {"disable": True},
        "safety_settings": [{
            "category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_ONLY_HIGH",
        }],
    }
    if settings["structured_json"]:
        generation_config["response_mime_type"] = "application/json"
        generation_config["response_json_schema"] = response_schema(task, parent_ids)
    if settings["thinking_config"] is not None:
        generation_config["thinking_config"] = settings["thinking_config"]
    return {
        "schema_version": config["schema_version"],
        "config_version": config["version"],
        "config_sha256": sha256(json.dumps({
            "config": config,
            "prompts": {path.name: path.read_text(encoding="utf-8") for path in sorted((ROOT / "prompts").glob("*.txt"))},
            "sdk_version": version("google-genai"), "pillow_version": version("Pillow"),
        }, sort_keys=True).encode()).hexdigest(),
        "request_id": uuid4().hex,
        "case_id": case_id,
        "task": task,
        "model": MODEL,
        "provider": provider,
        "deployment_project": os.environ.get("GOOGLE_CLOUD_PROJECT") if provider == "vertex" else None,
        "deployment_location": os.environ.get("GOOGLE_CLOUD_LOCATION") if provider == "vertex" else None,
        "profile": profile,
        "prompt_version": PROMPTS[task],
        "policy_version": config["policy_version"],
        "prompt": prompt,
        "generation_config": generation_config,
        "transport": {"api_version": config["api_versions"][provider], "timeout_ms": config["timeout_ms"], "attempts": 1},
        "input_variant": input_variant,
        "image": prepared.metadata(),
        "accepted_rois": parents,
        "coordinate_order": config["coordinate_order"],
        "coordinate_range": config["coordinate_range"],
        "sdk_version": version("google-genai"),
        "pillow_version": version("Pillow"),
        "started_at": datetime.now(timezone.utc).isoformat(),
    }


def response_text(raw: dict) -> str:
    candidates = raw.get("candidates", [])
    if len(candidates) != 1:
        return ""
    return "".join(
        part.get("text", "") for part in candidates[0].get("content", {}).get("parts", [])
        if not part.get("thought", False)
    )


def interpret_response(raw: dict, request: dict) -> dict:
    feedback = raw.get("prompt_feedback", {})
    if feedback.get("block_reason") not in (None, "BLOCKED_REASON_UNSPECIFIED"):
        raise ReferenceError("provider_refusal")
    candidates = raw.get("candidates", [])
    if len(candidates) != 1:
        raise ReferenceError("missing_or_multiple_candidates")
    candidate = candidates[0]
    finish = candidate.get("finish_reason")
    if finish not in ("STOP", "MAX_TOKENS"):
        raise ReferenceError("provider_refusal_or_incomplete")
    if any(rating.get("blocked") for rating in candidate.get("safety_ratings", [])):
        raise ReferenceError("provider_refusal")
    parent_ids = tuple(roi["id"] for roi in (request["accepted_rois"] or {}).get("rois", []))
    try:
        annotations = parse_response(response_text(raw), request["task"], parent_ids)
    except ReferenceError:
        if finish == "MAX_TOKENS":
            raise ReferenceError("truncated_output") from None
        raise
    warnings = []
    if finish == "MAX_TOKENS":
        warnings.append("provider_output_limit")
    if len(annotations) == MAX_OBJECTS:
        warnings.append("object_cap_possible_truncation")
    status = "partial" if warnings else ("complete" if annotations else "no_detections")
    return {
        "status": status,
        "annotations": [
            {**record, "id": uuid4().hex, "kind": request["task"],
             "origin": "gemini", "review_status": "suggested"}
            for record in annotations
        ],
        "warnings": warnings,
        "finish_reason": finish,
        "provider_response_id": raw.get("response_id"),
        "model_version": raw.get("model_version"),
        "usage": raw.get("usage_metadata"),
    }


def write_json(path: Path, value: Any) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as target:
        json.dump(value, target, indent=2, ensure_ascii=True, allow_nan=False)
        target.write("\n")


def run_reference(
    image_path: Path, *, allow_live: bool = False, max_calls: int = 0,
    prepare_only: bool = False, output_dir: Path = ROOT / "private/runs", **options: Any,
) -> tuple[Path, dict]:
    if not prepare_only and (not allow_live or type(max_calls) is not int or max_calls != 1):
        raise ReferenceError("live_run_requires_consent_and_one_call_budget")
    prepared = prepare_image(image_path, read_config())
    request = build_request(prepared, **options)
    directory = output_dir / request["request_id"]
    directory.mkdir(parents=True, exist_ok=False)
    (directory / "inference.png").write_bytes(prepared.png)
    write_json(directory / "request.json", request)
    result = {
        "request_id": request["request_id"], "case_id": request["case_id"],
        "task": request["task"], "source_sha256": prepared.source_sha256,
        "status": "prepared", "attempted_calls": 0, "provider_settings_accepted": False,
    }
    started = perf_counter()
    try:
        if not prepare_only:
            from .provider import create_client, generate

            with create_client(request["provider"], read_config()) as client:
                result["attempted_calls"] = 1
                raw = generate(client, request, prepared.png)
            result["provider_settings_accepted"] = True
            raw_json = json.dumps(raw, ensure_ascii=True)
            if len(raw_json.encode("utf-8")) > MAX_RESPONSE_BYTES:
                raise ReferenceError("response_too_large")
            write_json(directory / "raw-response.json", raw)
            (directory / "response.txt").write_text(response_text(raw), encoding="utf-8")
            result.update(interpret_response(raw, request))
    except ReferenceError as error:
        result.update(status="error", error=error.code)
    except KeyboardInterrupt:
        result.update(status="error", error="interrupted_completion_unknown")
    except Exception:
        result.update(status="error", error="reference_execution_failed")
    result["elapsed_seconds"] = perf_counter() - started
    result["completed_at"] = datetime.now(timezone.utc).isoformat()
    write_json(directory / "result.json", result)
    return directory, result