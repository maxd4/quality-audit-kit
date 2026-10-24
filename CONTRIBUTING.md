# Contributing

This is an experimental documentation and contract repository, not yet a functioning audit framework.

Before proposing a new scanner integration, describe a specific observable maintenance problem and the information that existing tools cannot already provide. Prefer small changes to the canonical document or schema over duplicate configuration.

For data-contract changes, update the schema, fictional fixtures, explanatory text and validation checks together. Explicitly distinguish `CURRENT` from `TARGET`. Do not weaken the meaning of an unmeasured check, silently upgrade proof levels or add permanent exceptions just to make reports pass.

Do not submit CleanMyMap implementation fragments, real audit artifacts, confidential paths, credentials or third-party assets unless their provenance and reuse rights have been reviewed.

To run initial checks:

```bash
python3 tools/validate_examples.py
```

The presence of this small fixture check does not mean that the proposed CLI or engine integrations have passed tests.
