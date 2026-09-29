"""Compare the parts of OpenAPI contracts that define client/server compatibility."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

Classification = Literal["breaking", "compatible", "review"]
Direction = Literal["request", "response"]
_METHODS = {"delete", "get", "head", "options", "patch", "post", "put", "trace"}
_DOCUMENTATION_KEYS = {"deprecated", "description", "example", "examples", "summary", "title"}
_KNOWN_SCHEMA_KEYS = {
    "$ref",
    "additionalProperties",
    "const",
    "default",
    "enum",
    "exclusiveMaximum",
    "exclusiveMinimum",
    "format",
    "items",
    "maxItems",
    "maximum",
    "maxLength",
    "maxProperties",
    "minItems",
    "minimum",
    "minLength",
    "minProperties",
    "multipleOf",
    "nullable",
    "pattern",
    "properties",
    "required",
    "type",
    "uniqueItems",
}


@dataclass(frozen=True)
class Change:
    classification: Classification
    location: str
    message: str


def compare_contracts(baseline: dict[str, Any], current: dict[str, Any]) -> list[Change]:
    """Return readable compatibility changes between two OpenAPI documents.

    Request changes are judged against what existing clients send. Response changes
    are judged against what existing clients accept. Unknown schema keywords need
    human review because their compatibility direction is not inferred here.
    """
    changes: list[Change] = []
    if baseline.get("security") != current.get("security"):
        changes.append(Change("review", "security", "global security requirements changed"))
    old_paths = baseline.get("paths", {})
    new_paths = current.get("paths", {})

    for path, old_path in old_paths.items():
        new_path = new_paths.get(path, {})
        if old_path.get("parameters") != new_path.get("parameters"):
            changes.append(Change("review", path, "path-level parameters changed"))
        for method, old_operation in old_path.items():
            if method not in _METHODS:
                continue
            label = f"{method.upper()} {path}"
            new_operation = new_path.get(method)
            if new_operation is None:
                changes.append(Change("breaking", label, "operation was removed"))
                continue
            if old_operation.get("security") != new_operation.get("security"):
                changes.append(Change("review", label, "security requirements changed"))
            old_id = old_operation.get("operationId")
            new_id = new_operation.get("operationId")
            if old_id != new_id:
                changes.append(
                    Change("breaking", label, f"operationId changed from {old_id!r} to {new_id!r}")
                )
            _compare_parameters(baseline, current, old_operation, new_operation, label, changes)
            _compare_request_body(baseline, current, old_operation, new_operation, label, changes)
            _compare_responses(baseline, current, old_operation, new_operation, label, changes)

    for path, new_path in new_paths.items():
        old_path = old_paths.get(path, {})
        for method in new_path:
            if method in _METHODS and method not in old_path:
                changes.append(
                    Change("compatible", f"{method.upper()} {path}", "operation was added")
                )
    return sorted(
        changes, key=lambda change: (change.location, change.classification, change.message)
    )


def _compare_parameters(
    baseline: dict[str, Any],
    current: dict[str, Any],
    old_operation: dict[str, Any],
    new_operation: dict[str, Any],
    operation: str,
    changes: list[Change],
) -> None:
    old_parameters = _parameters(baseline, old_operation)
    new_parameters = _parameters(current, new_operation)
    for key, old_parameter in old_parameters.items():
        location = f"{operation} {key[1]}.{key[0]}"
        new_parameter = new_parameters.get(key)
        if new_parameter is None:
            changes.append(Change("breaking", location, "parameter was removed"))
            continue
        if not old_parameter.get("required", False) and new_parameter.get("required", False):
            changes.append(Change("breaking", location, "optional parameter became required"))
        elif old_parameter.get("required", False) and not new_parameter.get("required", False):
            changes.append(Change("compatible", location, "required parameter became optional"))
        _compare_schema(
            baseline,
            current,
            old_parameter.get("schema", {}),
            new_parameter.get("schema", {}),
            "request",
            location + " schema",
            changes,
            set(),
        )
    for key in new_parameters.keys() - old_parameters.keys():
        parameter = new_parameters[key]
        classification: Classification = (
            "breaking" if parameter.get("required", False) else "compatible"
        )
        note = (
            "required parameter was added"
            if classification == "breaking"
            else "optional parameter was added"
        )
        changes.append(Change(classification, f"{operation} {key[1]}.{key[0]}", note))


def _parameters(
    document: dict[str, Any], operation: dict[str, Any]
) -> dict[tuple[str, str], dict[str, Any]]:
    result: dict[tuple[str, str], dict[str, Any]] = {}
    for parameter in operation.get("parameters", []):
        value = _resolve(document, parameter)
        result[(value.get("name", "?"), value.get("in", "?"))] = value
    return result


def _compare_request_body(
    baseline: dict[str, Any],
    current: dict[str, Any],
    old_operation: dict[str, Any],
    new_operation: dict[str, Any],
    operation: str,
    changes: list[Change],
) -> None:
    old_body = old_operation.get("requestBody")
    new_body = new_operation.get("requestBody")
    if old_body is None:
        if new_body is not None and _resolve(current, new_body).get("required", False):
            changes.append(
                Change("breaking", operation + " requestBody", "required request body was added")
            )
        elif new_body is not None:
            changes.append(
                Change("compatible", operation + " requestBody", "optional request body was added")
            )
        return
    if new_body is None:
        changes.append(Change("breaking", operation + " requestBody", "request body was removed"))
        return
    old_value = _resolve(baseline, old_body)
    new_value = _resolve(current, new_body)
    location = operation + " requestBody"
    if not old_value.get("required", False) and new_value.get("required", False):
        changes.append(Change("breaking", location, "optional request body became required"))
    old_content = old_value.get("content", {})
    new_content = new_value.get("content", {})
    _compare_content(baseline, current, old_content, new_content, "request", location, changes)


def _compare_responses(
    baseline: dict[str, Any],
    current: dict[str, Any],
    old_operation: dict[str, Any],
    new_operation: dict[str, Any],
    operation: str,
    changes: list[Change],
) -> None:
    old_responses = old_operation.get("responses", {})
    new_responses = new_operation.get("responses", {})
    for status, old_response in old_responses.items():
        location = f"{operation} response {status}"
        new_response = new_responses.get(status)
        if new_response is None:
            changes.append(Change("breaking", location, "response was removed"))
            continue
        old_value = _resolve(baseline, old_response)
        new_value = _resolve(current, new_response)
        _compare_content(
            baseline,
            current,
            old_value.get("content", {}),
            new_value.get("content", {}),
            "response",
            location,
            changes,
        )
    for status in new_responses.keys() - old_responses.keys():
        changes.append(Change("compatible", f"{operation} response {status}", "response was added"))


def _compare_content(
    baseline: dict[str, Any],
    current: dict[str, Any],
    old_content: dict[str, Any],
    new_content: dict[str, Any],
    direction: Direction,
    location: str,
    changes: list[Change],
) -> None:
    for media_type, old_media in old_content.items():
        media_location = f"{location} {media_type}"
        new_media = new_content.get(media_type)
        if new_media is None:
            changes.append(Change("breaking", media_location, "media type was removed"))
            continue
        _compare_schema(
            baseline,
            current,
            old_media.get("schema", {}),
            new_media.get("schema", {}),
            direction,
            location,
            changes,
            set(),
        )
    for media_type in new_content.keys() - old_content.keys():
        changes.append(Change("compatible", f"{location} {media_type}", "media type was added"))


def _compare_schema(
    baseline: dict[str, Any],
    current: dict[str, Any],
    old_schema: dict[str, Any],
    new_schema: dict[str, Any],
    direction: Direction,
    location: str,
    changes: list[Change],
    seen_refs: set[tuple[str, str]],
) -> None:
    old_ref = old_schema.get("$ref")
    new_ref = new_schema.get("$ref")
    if old_ref or new_ref:
        if old_ref and new_ref and old_ref == new_ref:
            pair = (old_ref, new_ref)
            if pair in seen_refs:
                return
            _compare_schema(
                baseline,
                current,
                _resolve(baseline, old_schema),
                _resolve(current, new_schema),
                direction,
                location,
                changes,
                seen_refs | {pair},
            )
            return
        _emit(changes, "breaking", location, "schema reference changed")
        return

    old_type = _types(old_schema)
    new_type = _types(new_schema)
    if old_type != new_type:
        _emit(changes, "breaking", location, f"type changed from {old_type} to {new_type}")
        return

    old_enum = old_schema.get("enum")
    new_enum = new_schema.get("enum")
    if old_enum is not None or new_enum is not None:
        if old_enum is None or new_enum is None:
            _emit(changes, "review", location + " enum", "enum constraint was added or removed")
        else:
            removed = set(old_enum) - set(new_enum)
            added = set(new_enum) - set(old_enum)
            breaking = removed if direction == "request" else added
            compatible = added if direction == "request" else removed
            if breaking:
                _emit(
                    changes, "breaking", location + " enum", f"values {sorted(breaking, key=str)}"
                )
            if compatible:
                _emit(
                    changes,
                    "compatible",
                    location + " enum",
                    f"values {sorted(compatible, key=str)}",
                )

    old_properties = old_schema.get("properties", {})
    new_properties = new_schema.get("properties", {})
    old_required = set(old_schema.get("required", []))
    new_required = set(new_schema.get("required", []))
    for name, old_property in old_properties.items():
        child = f"{location}.{name}"
        new_property = new_properties.get(name)
        if new_property is None:
            _emit(changes, "breaking", child, "property was removed")
            continue
        if direction == "request" and name not in old_required and name in new_required:
            _emit(changes, "breaking", child, "optional property became required")
        elif direction == "request" and name in old_required and name not in new_required:
            _emit(changes, "compatible", child, "required property became optional")
        elif direction == "response" and name in old_required and name not in new_required:
            _emit(changes, "breaking", child, "required response property became optional")
        _compare_schema(
            baseline,
            current,
            old_property,
            new_property,
            direction,
            child,
            changes,
            seen_refs,
        )
    for name in new_properties.keys() - old_properties.keys():
        child = f"{location}.{name}"
        if direction == "request" and name in new_required:
            _emit(changes, "breaking", child, "required property was added")
        else:
            _emit(changes, "compatible", child, "property was added")

    old_items = old_schema.get("items")
    new_items = new_schema.get("items")
    if old_items is not None and new_items is not None:
        _compare_schema(
            baseline, current, old_items, new_items, direction, location + "[]", changes, seen_refs
        )
    elif old_items != new_items:
        _emit(changes, "review", location + "[]", "array item schema changed")

    for keyword in ("anyOf", "oneOf", "allOf"):
        old_branches = old_schema.get(keyword, [])
        new_branches = new_schema.get(keyword, [])
        if old_branches != new_branches:
            _emit(changes, "review", location + "." + keyword, "schema composition changed")
        for index, (old_branch, new_branch) in enumerate(
            zip(old_branches, new_branches, strict=False)
        ):
            _compare_schema(
                baseline,
                current,
                old_branch,
                new_branch,
                direction,
                f"{location}.{keyword}[{index}]",
                changes,
                seen_refs,
            )

    handled = _DOCUMENTATION_KEYS | _KNOWN_SCHEMA_KEYS | {"anyOf", "oneOf", "allOf"}
    for key in (old_schema.keys() | new_schema.keys()) - handled:
        if old_schema.get(key) != new_schema.get(key):
            _emit(changes, "review", location + "." + key, "unclassified schema keyword changed")
    for key in (
        _KNOWN_SCHEMA_KEYS - {"$ref", "type", "enum", "required", "properties", "items"}
    ) & (old_schema.keys() | new_schema.keys()):
        if old_schema.get(key) != new_schema.get(key):
            _emit(
                changes,
                "review",
                location + "." + key,
                "schema constraint changed; review compatibility",
            )


def _types(schema: dict[str, Any]) -> set[str] | None:
    value = schema.get("type")
    if isinstance(value, str):
        return {value}
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return set(value)
    return None


def _resolve(document: dict[str, Any], value: dict[str, Any]) -> dict[str, Any]:
    reference = value.get("$ref")
    if not isinstance(reference, str) or not reference.startswith("#/"):
        return value
    target: Any = document
    for component in reference[2:].split("/"):
        target = target.get(component.replace("~1", "/").replace("~0", "~"), {})
    return target if isinstance(target, dict) else value


def _emit(
    changes: list[Change], classification: Classification, location: str, message: str
) -> None:
    changes.append(Change(classification, location, message))
