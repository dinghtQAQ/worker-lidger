# worker-lidger Project Guidance

## Git Delivery

- Target branch: `main`
- Integration branch: `codex/test`
- PR mode: `local-only`

## Project Rules

- Keep secrets, personal identifiers, database paths, and deployment-specific
  values in the worker configuration or environment variables. Never commit
  real values.
- Use SQLite transactions and constraints for ledger writes; monetary values
  must not use binary floating point.
- Preserve an auditable history for financial records. Avoid destructive
  deletes when a reversible status change is sufficient.
- Run the documented test suite before committing a requirement.
