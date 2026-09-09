from collections import Counter
from datetime import date
from hashlib import sha256
import json
import math
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .contracts import SUBTYPES, TASKS, ReferenceError, parse_response, validate_box
from .runner import read_bounded_json


Task = Literal["roof_roi", "penetration", "rainwater_outlet"]
REQUIRED_TAGS = {
    "multiple_disconnected", "nonrectangular", "interior_rooflight", "small_vent",
    "boundary_outlet", "dense_notes", "rotation", "ambiguous_scope", "no_targets", "unmarked",
}


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Target(StrictModel):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    label: str = Field(min_length=1, max_length=240)
    box_2d: list[float]
    roi_id: str | None = None
    subtype: str | None = None

    @model_validator(mode="before")
    @classmethod
    def check_coordinates(cls, value):
        if isinstance(value, dict):
            validate_box(value.get("box_2d"))
        return value


class Review(StrictModel):
    reviewer: str = Field(min_length=1, max_length=120)
    reviewed_on: date
    policy_version: Literal["scope-policy-draft-v1"]


class Case(StrictModel):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    document_id: str = Field(min_length=1, max_length=120)
    split: Literal["development", "held_out"]
    tags: list[str]
    input_variant: Literal["original_jpeg", "pdfjs_page", "other_raster"]
    image_path: str | None
    source_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    status: Literal["awaiting_source", "awaiting_review", "reviewed"]
    review: Review | None = None
    expected: dict[Task, list[Target] | None]

    @model_validator(mode="after")
    def check_review(self):
        if set(self.expected) != set(TASKS):
            raise ValueError("Every task needs an explicit expectation or null pending review")
        if self.status == "reviewed":
            if not self.review or not self.image_path or not self.source_sha256:
                raise ValueError("Reviewed cases require reviewer, image and hash")
            if any(targets is None for targets in self.expected.values()):
                raise ValueError("Reviewed cases require all task labels, including explicit negatives")
        rois = {target.id for target in (self.expected["roof_roi"] or [])}
        identifiers = set()
        for task, targets in self.expected.items():
            for target in targets or []:
                if target.id in identifiers:
                    raise ValueError("Target IDs must be unique within a page")
                identifiers.add(target.id)
                if task == "roof_roi":
                    if target.roi_id is not None or target.subtype is not None:
                        raise ValueError("Roof targets cannot have parent/subtype")
                elif target.roi_id not in rois or target.subtype not in SUBTYPES[task]:
                    raise ValueError("Child targets require a known parent and included subtype")
        return self


class Manifest(StrictModel):
    schema_version: Literal["evaluation-v1"]
    policy_status: Literal["draft", "approved"]
    policy_review: Review | None = None
    original_jpeg_status: Literal["unavailable", "obtained"]
    cases: list[Case] = Field(min_length=1)

    @model_validator(mode="after")
    def check_splits(self):
        identifiers = set()
        source_splits = {}
        for case in self.cases:
            if case.id in identifiers:
                raise ValueError("Duplicate case ID")
            identifiers.add(case.id)
            for source in (case.document_id, case.source_sha256):
                if source:
                    if source in source_splits and source_splits[source] != case.split:
                        raise ValueError("Source leakage between development and held-out sets")
                    source_splits[source] = case.split
        if self.policy_status == "approved" and not self.policy_review:
            raise ValueError("Approved policy needs a domain reviewer")
        return self


def load_manifest(path: Path) -> Manifest:
    return Manifest.model_validate(read_bounded_json(path))


def audit_manifest(manifest: Manifest, base: Path) -> dict:
    reviewed = [case for case in manifest.cases if case.status == "reviewed"]
    blockers = []
    if manifest.policy_status != "approved":
        blockers.append("category_policy_not_approved")
    for case in manifest.cases:
        if case.status != "reviewed":
            blockers.append(f"{case.id}:{case.status}")
    for case in reviewed:
        path = base / (case.image_path or "")
        if not path.is_file():
            blockers.append(f"{case.id}:image_unavailable")
        else:
            with path.open("rb") as source:
                digest = sha256()
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != case.source_sha256:
                blockers.append(f"{case.id}:image_hash_mismatch")
    tags = {tag for case in reviewed for tag in case.tags}
    blockers.extend(f"missing_reviewed_coverage:{tag}" for tag in sorted(REQUIRED_TAGS - tags))
    coverage = {}
    for split in ("development", "held_out"):
        selected = [case for case in reviewed if case.split == split]
        coverage[split] = {}
        for task in TASKS:
            positive = sum(bool(case.expected[task]) for case in selected)
            negative = sum(case.expected[task] == [] and
                           (task == "roof_roi" or bool(case.expected["roof_roi"])) for case in selected)
            coverage[split][task] = {"positive": positive, "negative": negative}
            if not positive or not negative:
                blockers.append(f"missing_positive_or_negative:{split}:{task}")
    return {"status": "ready" if not blockers else "blocked", "reviewed_cases": len(reviewed),
            "original_jpeg_status": manifest.original_jpeg_status,
            "coverage": coverage, "blockers": blockers}


def box_iou(first: list[float], second: list[float]) -> float:
    overlap = max(0, min(first[2], second[2]) - max(first[0], second[0])) * max(
        0, min(first[3], second[3]) - max(first[1], second[1])
    )
    first_area = (first[2] - first[0]) * (first[3] - first[1])
    second_area = (second[2] - second[0]) * (second[3] - second[1])
    return overlap / (first_area + second_area - overlap)


def score_boxes(expected: list[dict], predicted: list[dict], threshold: float) -> dict:
    if not math.isfinite(threshold) or not 0 < threshold <= 1:
        raise ReferenceError("invalid_iou_threshold")
    candidates = sorted(
        ((box_iou(target["box_2d"], proposal["box_2d"]), target_index, proposal_index)
         for target_index, target in enumerate(expected)
         for proposal_index, proposal in enumerate(predicted)
         if target.get("subtype") == proposal.get("subtype")), reverse=True,
    )
    used_targets, used_proposals = set(), set()
    overlaps, position_errors = [], []
    parent_matches = 0
    for overlap, target_index, proposal_index in candidates:
        if overlap < threshold or target_index in used_targets or proposal_index in used_proposals:
            continue
        used_targets.add(target_index)
        used_proposals.add(proposal_index)
        overlaps.append(overlap)
        target, proposal = expected[target_index], predicted[proposal_index]
        parent_matches += target.get("roi_id") == proposal.get("roi_id")
        target_box, proposal_box = target["box_2d"], proposal["box_2d"]
        position_errors.append(math.hypot(
            (target_box[0] + target_box[2] - proposal_box[0] - proposal_box[2]) / 2,
            (target_box[1] + target_box[3] - proposal_box[1] - proposal_box[3]) / 2,
        ))
    true_positive = len(overlaps)
    return {"true_positive": true_positive, "false_positive": len(predicted) - true_positive,
            "false_negative": len(expected) - true_positive, "matched_ious": overlaps,
            "correct_parent_matches": parent_matches, "matched_position_errors_0_1000": position_errors}


def evaluate(manifest_path: Path, runs: Path, split: str, threshold: float) -> dict:
    manifest = load_manifest(manifest_path)
    audit = audit_manifest(manifest, manifest_path.parent)
    if audit["status"] != "ready":
        raise ReferenceError("evaluation_manifest_not_ready")
    records = {}
    configurations = set()
    for path in sorted(runs.glob("*/result.json")):
        result = read_bounded_json(path)
        key = (result.get("case_id"), result.get("task"))
        if key in records:
            raise ReferenceError("duplicate_case_task_run")
        request = read_bounded_json(path.with_name("request.json"))
        records[key] = (result, request)
    cases = [case for case in manifest.cases if case.split == split]
    if not cases:
        raise ReferenceError("empty_evaluation_split")
    scores = []
    for case in cases:
        for task in TASKS:
            if task != "roof_roi" and not case.expected["roof_roi"]:
                scores.append({"case_id": case.id, "task": task, "status": "not_applicable_no_parent",
                               **score_boxes([], [], threshold)})
                continue
            pair = records.get((case.id, task))
            if pair is None:
                raise ReferenceError("missing_evaluation_run")
            result, request = pair
            if result.get("status") not in ("complete", "no_detections"):
                raise ReferenceError("failed_or_partial_evaluation_run")
            if result.get("source_sha256") != case.source_sha256 or request["image"]["source_sha256"] != case.source_sha256:
                raise ReferenceError("evaluation_image_mismatch")
            if result.get("request_id") != request.get("request_id") or request.get("task") != task or request.get("case_id") != case.id:
                raise ReferenceError("evaluation_request_mismatch")
            configurations.add((request["model"], request["config_sha256"], request["profile"],
                                request["generation_config"]["max_output_tokens"], request["provider"]))
            if task != "roof_roi":
                expected_parents = [{"id": target.id, "box_2d": target.box_2d} for target in case.expected["roof_roi"] or []]
                if (request.get("accepted_rois") or {}).get("rois") != expected_parents:
                    raise ReferenceError("evaluation_parent_context_mismatch")
            predictions = [{key: value for key, value in record.items()
                            if key in {"box_2d", "label", "roi_id", "subtype"}}
                           for record in result.get("annotations", [])]
            parse_response(json.dumps(predictions), task, tuple(target.id for target in case.expected["roof_roi"] or []))
            if (result["status"] == "no_detections") != (not predictions):
                raise ReferenceError("evaluation_status_mismatch")
            score = score_boxes([target.model_dump() for target in case.expected[task] or []], predictions, threshold)
            scores.append({"case_id": case.id, "task": task, **score})
    if len(configurations) != 1:
        raise ReferenceError("mixed_evaluation_configurations")
    totals = Counter()
    for score in scores:
        totals.update({key: score[key] for key in ("true_positive", "false_positive", "false_negative")})
    true_positive = totals["true_positive"]
    return {"schema_version": "evaluation-report-v1", "split": split,
            "matching": "greedy_descending_iou_same_subtype", "iou_threshold": threshold,
            "counts": dict(totals), "cases": scores,
            "precision": true_positive / (true_positive + totals["false_positive"]) if true_positive + totals["false_positive"] else None,
            "recall": true_positive / (true_positive + totals["false_negative"]) if true_positive + totals["false_negative"] else None,
            "quality_gate": "not_set_domain_owner_required"}


def check_fixtures(path: Path) -> dict:
    fixtures = read_bounded_json(path)
    if fixtures.get("evidence") != "synthetic_contract_only":
        raise ReferenceError("fixture_evidence_must_be_explicit")
    checked = []
    for case in fixtures["cases"]:
        try:
            parsed = parse_response(case["response"], case["task"], tuple(case.get("parent_ids", [])))
        except ReferenceError as error:
            if error.code != case.get("expected_error"):
                raise ReferenceError("fixture_error_mismatch") from None
        else:
            if case.get("expected_error") or parsed != case["expected"]:
                raise ReferenceError("fixture_result_mismatch")
        checked.append(case["id"])
    return {"status": "passed", "evidence": "synthetic_contract_only", "checked": checked}