# Averix Engineering Rules

Rules for every new Averix project. Follow them for all code, tests, commits and PRs.
Stack: Node.js/Express + TypeScript, Next.js, Flutter, PostgreSQL.

> For existing projects (e.g. ApnaBot), these rules apply in **adoption mode**: new and changed
> code only, with the project's own exceptions listed in its `CLAUDE.md`. Existing project
> safety rules win on any conflict.

## 1. Repository setup
- One repo per app: `<client>-api`, `<client>-admin`, `<client>-mobile`. No mixed-language monorepos.
- Repo lives under the Averix GitHub/GitLab organization, never a personal account.
- Repo and package names must include the client/product name. Never use generic names like `app`, `api`, `backend`, `web`.
- Required root files: `README.md`, `LICENSE`, `.env.example`, `.gitignore`, `.github/workflows/ci.yml`, `.github/pull_request_template.md`.
- `package.json` must have `name`, `author: "Averix Solutions Pvt. Ltd."`, `license`, and a `test` script that runs Jest.
- README first paragraph: "Built by Averix Solutions Pvt. Ltd. for <Client Legal Name>."
- LICENSE must contain: `Copyright (c) <year> Averix Solutions Pvt. Ltd.`
- Flutter: `applicationId` and iOS bundle id = `com.<client>.<app>` (client name, not averix).

## 2. Folder structure

### Node / Next.js
```
src/modules/<feature>/
  <feature>.service.ts
  <feature>.service.test.ts
  <feature>.controller.ts
  <feature>.controller.test.ts
  <feature>.routes.ts
tests/fixtures/   tests/helpers/   tests/mocks/   (support only, no test cases)
```

### Flutter
```
lib/features/<feature>/<name>.dart
test/features/<feature>/<name>_test.dart
```

- Never commit `node_modules/`, `dist/`, `build/`, `.next/`, `coverage/`.
- Generated files (`*.g.dart`, `*.freezed.dart`, `*.d.ts`, `*.min.js`) must keep their standard suffix.

## 3. Tests (mandatory)
- Every source file gets a test file with the SAME base name:
  - `orders.service.ts` → `orders.service.test.ts`
  - `auth_repository.dart` → `auth_repository_test.dart`
- Node/Next.js: use Jest only (not Vitest or Mocha). Configure `coverageReporters: ["json-summary", "text"]`.
- Every test uses `describe` + `it()`/`test()` with real `expect()` assertions on actual behavior.
- Flutter: every test file must contain at least one `test('...')` call. Widget tests go inside `group()` alongside a `test()`, never `testWidgets` alone.
- Forbidden:
  - trivial assertions (`expect(true).toBe(true)`, `expect(1).toBe(1)`)
  - `it.skip`, `xit`, `xdescribe`, `test.todo`, `skip: true`
  - test files with no test cases
- Target ≥ 80% line coverage on the backend.
- Put fixtures, mocks and helpers only in `fixtures/`, `mocks/`, `helpers/` folders.

## 4. Code quality
- Functions ≤ 30 lines. Split anything larger.
- Max line length 100 (Prettier `printWidth: 100`). Never exceed 120.
- Comments make up 5–30% of lines. Add a JSDoc/dartdoc on every exported function and class. No commented-out code.
- No copy-paste: shared logic goes in `src/shared/` or `lib/core/`.
- Nesting depth ≤ 4 levels; use early returns.
- ESLint + Prettier (Node), `flutter analyze` with `very_good_analysis` or `flutter_lints` (Flutter). Zero warnings.

## 5. Secrets and PII
- Never hardcode passwords, API keys, tokens, JWTs or private keys, including in tests and seed files.
- Read all secrets from env (`process.env`, `--dart-define`).
- `.env.example` uses placeholders only: `your_api_key`, `changeme`.
- No real email addresses or phone numbers in code; use `user@example.com`.

## 6. Commits
- Conventional commits: `feat(orders): add bulk export`, `fix(auth): handle expired OTP`.
- Never start the subject with `chore`, `docs`, `style`, or use the words `bump`, `typo`, `config`, `version`, `lint`, `format`, `readme`. Group such changes into a feature or fix commit.
- Reference the issue in the body: `Refs #42` or `AV-42`.
- Authors commit with their `@averixsolutions.co.in` email.

## 7. Pull requests
- Every change goes through a PR. No direct pushes to `main`.
- One PR = one issue. Description starts with `Closes #<issue>`.
- 3–10 files per PR. Every PR that changes logic also changes or adds tests.
- PR title follows the commit convention and avoids the words in section 6.
- Merge with squash so the final title ends in `(#<PR number>)`.
- At least one human reviewer, with real review comments before merge.

## 8. CI/CD
`.github/workflows/ci.yml` must have separate jobs: `lint`, `test` (with coverage), `build`.
- Runs on every PR and push to `main`.
- Never merge on red. Fix failing pipelines immediately.

## 9. Before finishing any task, check
- [ ] Every new or changed source file has a matching test file with real assertions
- [ ] Tests pass and coverage did not drop
- [ ] No function over 30 lines, no line over 100 characters
- [ ] No secrets, real emails or duplicated code
- [ ] Commit message and PR title follow sections 6–7
