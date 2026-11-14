# Load test (Phase 8 step 4)

Checks the production setup under the worst expected moment: a whole class checking in at once.
It runs against the **production rehearsal only** (`infra/production`, DEPLOYMENT.md §7), never a real system.

- `seed.mjs` creates obviously fake data: a made-up faculty, course and room, a class that started two
  minutes ago, a lecturer, a university administrator and up to 99,999 students (numbers `99RNNNNN`), each
  with a registered, trusted phone and its own signing key. It runs inside the rehearsal network with the
  release image, and refuses to run unless `LOAD_TEST=rehearsal-only` and the bucket is the rehearsal's.
  Each run needs a new `LOAD_RUN` (1–9), because a student checks in only once per class.
- `drive.mjs` sends the check-ins through the HTTPS proxy as phones do (signed, with an Idempotency-Key,
  resending after a gateway error as the app does). At the same time the lecturer's live roster is connected
  and an administrator uses the dashboard, analytics and a report file. Then every phone retries once
  (same key: same answer, nothing stored twice). It prints a JSON summary.

## Running it

With the rehearsal up (DEPLOYMENT.md §7), from the repository root in Git Bash:

```bash
mkdir -p infra/production/secrets/load
MSYS_NO_PATHCONV=1 docker compose -f infra/production/compose.yml -f infra/production/compose.rehearsal.yml \
  run --rm --no-deps -e LOAD_TEST=rehearsal-only -e LOAD_RUN=1 \
  -v "$(pwd -W)/apps/api/load:/app/apps/api/load:ro" -v "$(pwd -W)/infra/production/secrets/load:/out" \
  release node load/seed.mjs
node apps/api/load/drive.mjs infra/production/secrets/load/load-run.json burst    # or: minute
```

The sign-in tokens in `load-run.json` last 15 minutes, so run the driver straight after the setup. The file
holds the fake phones' keys; it stays in the git-ignored `secrets` folder.

`burst` sends every check-in at the same moment. `minute` spreads them at random over 60 seconds, each
using the code on the lecturer's screen at that moment (the Phase 5 target: 500 check-ins within a minute).
To test a failure, stop one API instance while `minute` runs (`docker compose … stop api-1`).

Results are recorded in DEPLOYMENT.md §8.
