"""Contract policy examples: fail on incompatible edits and explain their locations."""

import json
from pathlib import Path

import pytest

from sangam.openapi_compatibility import compare_contracts

FIXTURES = Path(__file__).parent / "fixtures" / "openapi"


def load_contract(name: str) -> dict[str, object]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_breaking_fixture_reports_operation_and_schema_locations() -> None:
    changes = compare_contracts(load_contract("baseline.json"), load_contract("breaking.json"))

    reported = {(change.classification, change.location) for change in changes}
    assert ("breaking", "GET /items") in reported
    assert ("breaking", "POST /items requestBody.owner") in reported
    assert ("breaking", "POST /items requestBody.state enum") in reported
    assert ("breaking", "POST /items response 201.id") in reported
    assert ("breaking", "POST /items response 201.state") in reported


def test_compatible_fixture_allows_additive_fields_and_directional_enum_changes() -> None:
    changes = compare_contracts(load_contract("baseline.json"), load_contract("compatible.json"))

    assert {(change.classification, change.location) for change in changes} == {
        ("compatible", "GET /items query.state schema enum"),
        ("compatible", "GET /items response 200.items[].updated_at"),
        ("compatible", "GET /items response 200.items[].state enum"),
        ("compatible", "POST /items requestBody.description"),
        ("compatible", "POST /items requestBody.state enum"),
        ("compatible", "POST /items response 201.updated_at"),
        ("compatible", "POST /items response 201.state enum"),
    }


def test_new_required_response_field_is_additive_for_existing_clients() -> None:
    baseline = load_contract("baseline.json")
    current = load_contract("compatible.json")
    current_schemas = current["components"]["schemas"]
    current_schemas["Item"]["required"].append("created_at")
    current_schemas["Item"]["properties"]["created_at"] = {"type": "string"}

    changes = compare_contracts(baseline, current)

    assert ("compatible", "POST /items response 201.created_at") in {
        (change.classification, change.location) for change in changes
    }


def test_unrecognized_schema_keywords_are_reported_for_review() -> None:
    baseline = load_contract("baseline.json")
    current = load_contract("baseline.json")
    current["components"]["schemas"]["Item"]["additionalProperties"] = False

    changes = compare_contracts(baseline, current)

    assert any(change.classification == "review" for change in changes)


@pytest.mark.parametrize(
    "change", ["required_response", "type_removed", "security", "path_parameter", "union_reference"]
)
def test_unclassified_changes_never_silently_pass(change):
    baseline = load_contract("baseline.json")
    current = load_contract("baseline.json")
    if change == "required_response":
        current["components"]["schemas"]["Item"]["required"].remove("id")
    elif change == "type_removed":
        del current["components"]["schemas"]["Item"]["properties"]["id"]["type"]
    elif change == "security":
        current["paths"]["/items"]["get"]["security"] = [{"bearer": []}]
    elif change == "path_parameter":
        current["paths"]["/items"]["parameters"] = [
            {"name": "tenant", "in": "header", "required": True, "schema": {"type": "string"}}
        ]
    else:
        for schema in (baseline, current):
            schema["paths"]["/items"]["get"]["responses"]["200"]["content"]["application/json"][
                "schema"
            ] = {"anyOf": [{"$ref": "#/components/schemas/Item"}, {"type": "null"}]}
            del schema["paths"]["/items"]["post"]
        current["components"]["schemas"]["Item"]["properties"]["id"]["type"] = "string"
    assert any(
        item.classification in {"breaking", "review"}
        for item in compare_contracts(baseline, current)
    )
