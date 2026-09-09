import json
import math
from typing import Any


MODEL = "gemini-3.6-flash"
TASKS = ("roof_roi", "penetration", "rainwater_outlet")
SUBTYPES = {
    "roof_roi": (),
    "penetration": ("rooflight", "vent", "flue", "access_hatch"),
    "rainwater_outlet": ("internal_outlet", "parapet_outlet", "scupper"),
}
MAX_OBJECTS = 25
MAX_RESPONSE_BYTES = 256 * 1024


class ReferenceError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def validate_box(value: Any) -> list[float]:
    if not isinstance(value, list) or len(value) != 4:
        raise ReferenceError("invalid_box")
    if any(
        type(coordinate) not in (int, float)
        or not 0 <= coordinate <= 1000
        or not math.isfinite(coordinate)
        for coordinate in value
    ):
        raise ReferenceError("invalid_box")
    ymin, xmin, ymax, xmax = value
    if ymin >= ymax or xmin >= xmax:
        raise ReferenceError("invalid_box")
    return value.copy()


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ReferenceError("duplicate_json_key")
        result[key] = value
    return result


def load_json(text: str) -> Any:
    def reject_constant(_value: str) -> None:
        raise ReferenceError("invalid_json")

    try:
        return json.loads(
            text, object_pairs_hook=_unique_object, parse_constant=reject_constant
        )
    except (ValueError, RecursionError) as error:
        if isinstance(error, ReferenceError):
            raise
        raise ReferenceError("invalid_json") from None


def parse_response(
    text: str, task: str = "roof_roi", parent_ids: tuple[str, ...] = ()
) -> list[dict[str, Any]]:
    if task not in TASKS:
        raise ReferenceError("invalid_task")
    if len(text.encode("utf-8")) > MAX_RESPONSE_BYTES:
        raise ReferenceError("response_too_large")
    payload = text.strip()
    if payload.startswith("```json\n") and payload.endswith("\n```"):
        payload = payload[8:-4]
    records = load_json(payload)
    if not isinstance(records, list):
        raise ReferenceError("invalid_response_shape")
    if len(records) > MAX_OBJECTS:
        raise ReferenceError("annotation_limit_exceeded")
    for record in records:
        required = {"label", "box_2d"}
        if task != "roof_roi":
            required |= {"roi_id", "subtype"}
        if not isinstance(record, dict) or set(record) != required:
            raise ReferenceError("invalid_annotation_fields")
        if not isinstance(record["label"], str) or not record["label"].strip():
            raise ReferenceError("invalid_label")
        if len(record["label"]) > 240:
            raise ReferenceError("invalid_label")
        validate_box(record["box_2d"])
        if task != "roof_roi":
            if record["roi_id"] not in parent_ids:
                raise ReferenceError("unknown_parent")
            if record["subtype"] not in SUBTYPES[task]:
                raise ReferenceError("invalid_subtype")
    return records


def response_schema(task: str, parent_ids: tuple[str, ...]) -> dict[str, Any]:
    properties: dict[str, Any] = {
        "label": {"type": "string"},
        "box_2d": {
            "type": "array",
            "items": {"type": "number", "minimum": 0, "maximum": 1000},
            "minItems": 4,
            "maxItems": 4,
        },
    }
    if task != "roof_roi":
        properties["roi_id"] = {"type": "string", "enum": list(parent_ids)}
        properties["subtype"] = {"type": "string", "enum": list(SUBTYPES[task])}
    return {
        "type": "array",
        "maxItems": MAX_OBJECTS,
        "items": {
            "type": "object",
            "properties": properties,
            "required": list(properties),
            "additionalProperties": False,
        },
    }