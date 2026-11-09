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


def model_object(pairs: list[tuple]) -> dict:
    """Provider objects only: Gemini occasionally pads a key (" label"), sometimes repeating it unpadded.

    A padded key is trimmed. A repeat is tolerated only when one copy was padded and both
    values are identical; exact duplicate keys and conflicting values are still rejected.
    """
    result, padded = {}, set()
    for raw_key, value in pairs:
        key = raw_key.strip()
        if key in result:
            if ((raw_key != key or key in padded)
                    and json.dumps(result[key], sort_keys=True) == json.dumps(value, sort_keys=True)):
                continue
            raise ValueError("duplicate_key")
        if raw_key != key:
            padded.add(key)
        result[key] = value
    return result


SAFE_TOKEN = re.compile(r"[a-z][a-z0-9_]{0,63}")


def validation_detail(error: ValidationError) -> str:
    """Failed rule names and schema field names only, never provider-supplied keys or values."""
    parts = set()
    for item in error.errors():
        kind = item["type"]
        reason = str((item.get("ctx") or {}).get("error", ""))
        if kind == "value_error" and SAFE_TOKEN.fullmatch(reason):
            kind = reason
        field = next((part for part in reversed(item["loc"]) if isinstance(part, str)), None)
        if kind != "extra_forbidden" and field and SAFE_TOKEN.fullmatch(field):
            kind = f"{field}:{kind}"
        parts.add(kind)
    return ",".join(sorted(parts))[:200]


FENCE = re.compile(r"```(?:json)?[ \t]*\r?\n(.*?)\r?\n```", re.IGNORECASE | re.DOTALL)
# Gemini intermittently emits stray non-ASCII tokens before the JSON, e.g. "密的{" or, in JSON
# mode, a thought marker such as "💭\nையான{". At most three short non-ASCII tokens separated
# only by whitespace are dropped; any ASCII word (prose, leaked reasoning) is still rejected.
LEADING_NOISE = re.compile(r"[^\x00-\x7f\s]{1,8}(?:\s{1,2}[^\x00-\x7f\s]{1,8}){0,2}\s{0,2}(?=[\[{`])")


def _payload(text: str) -> str:
    payload = text.strip()
    noise = LEADING_NOISE.match(payload)
    if noise:
        payload = payload[noise.end():]
    fence = FENCE.fullmatch(payload)
    return fence.group(1) if fence else payload


def _leaked_part_text(value) -> str | None:
    """Answer text from a leaked response-part envelope: [{"think": ...}, {"text": "<json>"}]."""
    if not isinstance(value, list) or not value:
        return None
    texts = []
    for part in value:
        if not isinstance(part, dict) or len(part) != 1:
            return None
        ((key, content),) = part.items()
        if key not in {"think", "text"} or not isinstance(content, str):
            return None
        if key == "text":
            texts.append(content)
    return "".join(texts) if texts else None


def decode_model_json(text: str):
    """Strictly decode one JSON value, tolerating only the envelope noise observed from the provider."""
    payload = _payload(text)
    if not payload.strip():
        raise RoiError("malformed_output", 502, diagnostic=OutputDiagnostic.EMPTY_TEXT)
    try:
        value = json.loads(payload, object_pairs_hook=model_object, parse_constant=reject_constant)
        inner = _leaked_part_text(value)
        if inner is not None:
            value = json.loads(_payload(inner), object_pairs_hook=model_object, parse_constant=reject_constant)
    except (ValueError, TypeError, RecursionError):
        raise RoiError("malformed_output", 502, diagnostic=OutputDiagnostic.JSON_SYNTAX) from None
    return value


def parse_proposals(
    text: str, task: Task, parent_ids: set[str], max_bytes: int, max_annotations: int
) -> list[Proposal]:
    if len(text.encode("utf-8")) > max_bytes:
        raise RoiError("response_too_large", 502)
    records = decode_model_json(text)
    if not isinstance(records, list):
        raise RoiError("malformed_output", 502, diagnostic=OutputDiagnostic.JSON_STRUCTURE)
    if len(records) > max_annotations:
        raise RoiError("annotation_limit_exceeded", 502)
    proposals = []
    for record in records:
        fields = {"label", "box_2d"}
        if task != "roof_roi":
            fields |= {"roi_id", "subtype"}
        optional = {"footprint"} if task == "penetration" else set()
        if not isinstance(record, dict) or not fields <= set(record) or set(record) - fields - optional:
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
        if proposal.footprint is not None:
            from .penetration_geometry import valid_ring
            points = [(point.x, point.y) for point in proposal.footprint]
            if (any(x > 1000 or y > 1000 for x, y in points) or not valid_ring(points)
                    or any(not proposal.box_2d[1] - .5 <= x <= proposal.box_2d[3] + .5
                           or not proposal.box_2d[0] - .5 <= y <= proposal.box_2d[2] + .5 for x, y in points)):
                raise RoiError("malformed_output", 502, diagnostic=OutputDiagnostic.ANNOTATION_GEOMETRY)
        proposals.append(proposal)
    return proposals
