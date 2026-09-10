import json
import re

from pydantic import ValidationError

from .errors import OutputDiagnostic, RoiError
from .models import Geometry, Proposal, SUBTYPES, Task


def unique_object(pairs: list[tuple]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_key")
        result[key] = value
    return result


def reject_constant(value: str) -> None:
    raise ValueError("invalid_constant")


def parse_proposals(
    text: str, task: Task, parent_ids: set[str], max_bytes: int, max_annotations: int
) -> list[Proposal]:
    if len(text.encode("utf-8")) > max_bytes:
        raise RoiError("response_too_large", 502)
    payload = text.strip()
    fence = re.fullmatch(r"```(?:json)?[ \t]*\r?\n(.*?)\r?\n```", payload, re.IGNORECASE | re.DOTALL)
    if fence:
        payload = fence.group(1)
    if not payload.strip():
        raise RoiError("malformed_output", 502, diagnostic=OutputDiagnostic.EMPTY_TEXT)
    try:
        records = json.loads(payload, object_pairs_hook=unique_object, parse_constant=reject_constant)
    except (ValueError, TypeError, RecursionError):
        raise RoiError("malformed_output", 502, diagnostic=OutputDiagnostic.JSON_SYNTAX) from None
    if not isinstance(records, list):
        raise RoiError("malformed_output", 502, diagnostic=OutputDiagnostic.JSON_STRUCTURE)
    if len(records) > max_annotations:
        raise RoiError("annotation_limit_exceeded", 502)
    proposals = []
    for record in records:
        fields = {"label", "box_2d"}
        if task != "roof_roi":
            fields |= {"roi_id", "subtype"}
        if not isinstance(record, dict) or set(record) != fields:
            raise RoiError("malformed_output", 502, diagnostic=OutputDiagnostic.ANNOTATION_FIELDS)
        try:
            Geometry.model_validate({"box_2d": record["box_2d"]})
        except ValidationError:
            raise RoiError("malformed_output", 502, diagnostic=OutputDiagnostic.ANNOTATION_GEOMETRY) from None
        if task != "roof_roi":
            if (not isinstance(record["roi_id"], str) or record["roi_id"] not in parent_ids
                    or record["subtype"] not in SUBTYPES[task]):
                raise RoiError("malformed_output", 502, diagnostic=OutputDiagnostic.ANNOTATION_ASSOCIATION)
        try:
            proposal = Proposal.model_validate(record)
        except ValidationError:
            raise RoiError("malformed_output", 502, diagnostic=OutputDiagnostic.ANNOTATION_LABEL) from None
        proposals.append(proposal)
    return proposals