# AttendSure — working rules for Claude sessions

Read [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md) first. It says which phase is active, what is done, and which decisions are still open.

## Project
- Attendance and class-monitoring system exclusively for Knutsford University, Accra, Ghana. Not a multi-university product.
- The product owner is learning software engineering. Explain important technical decisions in plain language and give step-by-step instructions for anything they must do themselves.
- Design documents live in `docs/`. UI designs live on the design canvas: https://claude.ai/artifact/QA6eYPCN51FNpWASQbgLUV (its data is sample data only).
- Platform: Windows 11. PowerShell and Git Bash are both available.

## Hard rules
1. Work one phase at a time, and start a phase only after the product owner approves it.
2. Never invent Knutsford data: departments, programmes, courses, people, rooms, or ID formats. Make it configurable. Test fixtures must be obviously fake and must never be seeded into production.
3. The backend decides attendance and class status, using server time. Clients only collect evidence and show results.
4. Attendance is never QR-only. Classes are never cancelled automatically. Fraud flags go to review and never punish a student automatically.
5. Never overwrite attendance silently. Every correction carries a reason, the actor and an audit entry.
6. No fake dashboard numbers, no buttons that do nothing, no secrets in git, no ignored errors.
7. Never claim a test passed unless it was run. Report the actual output.
8. Keep modules separate. Business logic lives in services, not controllers. One module never writes another module's tables or checks its rules; it calls the owning module's service. Read-only joins across modules are allowed only to display data, such as a programme name (decided by the product owner, 2026-11-09). The identity modules (auth, users, roles, authorization) share the account tables.

## After every implementation step, report
What was built · files created or modified · database changes · commands run · tests run · actual test results · known limitations · next step. Then update IMPLEMENTATION_PROGRESS.md.
