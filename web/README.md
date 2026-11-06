# maillog web UI

Angular 22 + Angular Material (Material 3) single-page app, standalone components and signals.
It talks only to the maillog user API (`/api/v1`, see `../docs/API.md`) with the session cookie; nothing is stored in
`localStorage` except the light/dark preference.

## Develop

```bash
npm install
npm start          # ng serve on http://localhost:4200, proxies /api, /openapi, /install.sh to http://localhost:8080
npm test           # unit tests (vitest)
npm run build      # production build into dist/ (flat: index.html directly in dist/)
```

The Dockerfile builds this app in a Node stage and copies `dist/` into the ASP.NET `wwwroot`.

## Layout

```
src/app/
  api/        models.ts (types mirroring docs/API.md), api.service.ts (the only HTTP gateway)
  core/       auth, guards (role based), http interceptor (401 -> /login, errors -> snackbar), theme, webauthn, utils
  layout/     shell (sidenav + toolbar, role filtered navigation)
  shared/     dependency free SVG charts, copy box, confirm / one-time-secret dialogs
  features/   login, overview, queue, messages, trace, stats, alerts, agents, users, account, settings
```

## Roles

* `viewer`: Messages, Trace, Statistics, Account (the API already scopes data to the user's sender domains)
* `operator`: additionally Overview, Queue, Alerts, Agents (read-only)
* `admin`: everything, incl. Users and Settings

Route guards hide what a role cannot use; the API enforces the same rules server side.

## Passkeys

Sign-in and registration use WebAuthn discoverable credentials. The browser helpers
`PublicKeyCredential.parseRequestOptionsFromJSON` / `parseCreationOptionsFromJSON` / `toJSON()` are used when present,
otherwise the base64url conversion is done manually (`src/app/core/webauthn.ts`). Passkeys need HTTPS (or localhost).
