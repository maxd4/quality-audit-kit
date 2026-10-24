#!/usr/bin/env python3
"""Narrow, dependency-free consistency checks for synthetic examples.

This does not replace a real JSON Schema 2020-12 validator.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def main():
    run = read("examples/run.example.json")
    decisions = read("examples/decisions.example.json")
    run_schema = read("schemas/audit-run.schema.json")
    decision_schema = read("schemas/triage-decision.schema.json")
    assert run["schemaVersion"] == run_schema["properties"]["schemaVersion"]["const"]
    assert decisions["schemaVersion"] == decision_schema["properties"]["schemaVersion"]["const"]
    assert run["repository"]["name"] == "fictional-demo-repo"
    assert run["reproducible"] is False, "a fictional demo must not assert real reproducibility"
    assert run["inputScope"] in run_schema["properties"]["inputScope"]["enum"]
    measurement_statuses = {e["name"]: e["measurementStatus"] for e in run["engines"]}
    engine_outcomes = {e["name"]: e["gateOutcome"] for e in run["engines"]}
    assert len(measurement_statuses) == len(run["engines"]), "duplicated engine"
    assert any(state != "MEASURED" for state in measurement_statuses.values()), "negative-state fixture missing"
    for name, status in measurement_statuses.items():
        assert status in run_schema["properties"]["engines"]["items"]["properties"]["measurementStatus"]["enum"]
        if status != "MEASURED":
            assert engine_outcomes[name] != "PASS", "unmeasured engine cannot pass"
    ids = {finding["id"] for finding in run["findings"]}
    assert len(ids) == len(run["findings"]), "duplicate finding ID"
    assert all(f["engine"] in measurement_statuses for f in run["findings"])
    for finding in run["findings"]:
        assert measurement_statuses[finding["engine"]] == "MEASURED", "finding without measured engine"
        assert not finding["path"].startswith("/"), "must use repo-relative path"
    for decision in decisions["decisions"]:
        assert decision["findingId"] in ids, "orphan synthetic decision"
        assert decision["reviewedRevision"] == run["repository"]["commitSha"]
        assert decision["evidence"], "decision lacks evidence state"
        assert not (decision["decision"] == "KEEP_JUSTIFIED" and not decision["reason"].strip())
    print("PASS: synthetic fixture and contract consistency checks (not full schema validation)")


if __name__ == "__main__":
    main()
