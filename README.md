# ultra-excel

Hybrid architecture: a **Go/Gin API Gateway** streams uploaded Excel
files over **gRPC** to a **Python/Pandas** worker for analysis, and
returns a structured JSON summary. Access is protected end-to-end by
**Keycloak** (OIDC, Authorization Code + PKCE/S256), backed by **Postgres**.

```
                      (1) redirect to sign in                (4) Bearer <access_token>
        ┌────────────────────────────────────┐       ┌──────────────────────────────────┐
        ▼                                    │       ▼                                  │
[front: React SPA] ──(2) login──▶ [Keycloak] │  [go: Gin Gateway] ──gRPC(stream Chunk)──▶ [python: Pandas worker]
        ▲                                    │       │                                  │
        └──────────(3) code + PKCE verify────┘       └───────────ProcessingSummary───────┘
```

1. The SPA redirects the whole page to Keycloak (never handles a login
   form itself).
2. The user authenticates there.
3. Keycloak redirects back with an authorization code; the SPA exchanges
   it for tokens, presenting the PKCE `code_verifier` it generated
   up front - no client secret needed, safe for a public SPA.
4. The SPA attaches the resulting access token as `Authorization: Bearer
   <token>` on every call to the gateway, which verifies it (signature,
   issuer, audience, expiry) against Keycloak before doing anything else.

**Supported formats**: `.xlsx`, `.xlsm`, `.xltx`, `.xltm` (openpyxl),
`.xls`, `.xlt` (xlrd, legacy Excel 97-2003), `.xlsb` (pyxlsb). The engine
is picked from the filename extension - see `ENGINE_BY_EXTENSION` in
`python/server.py`. Every worksheet in the workbook is analyzed, not just
the first.

## Project layout (organized by métier / responsibility)

```
ultra-excel/
├── docker-compose.yml             # Postgres + Keycloak (the identity stack only)
├── .env.example                  # secrets for docker-compose (copy to .env)
│
├── infra/
│   └── keycloak/
│       └── realm-export.json      # realm "ultra-excel": PKCE-required SPA client,
│                                   # audience mapper, demo user
│
├── proto/
│   └── excel_processor.proto      # shared gRPC contract (source of truth)
│
├── go/                            # HTTP layer - API Gateway (Gin)
│   ├── go.mod                     # module: ultraexcel
│   ├── cmd/
│   │   └── gateway/
│   │       └── main.go            # Gin server, upload handler, gRPC client,
│   │                               # CORS, OIDC token verification (authMiddleware)
│   └── proto/
│       └── excelprocessor/        # generated Go stubs land here (gitignored)
│
├── python/                        # Compute layer - gRPC worker (Pandas)
│   ├── requirements.txt
│   ├── server.py                  # gRPC service implementation
│   └── excel_processor_pb2*.py    # generated Python stubs land here (gitignored)
│
├── front/                         # UI layer - React + Radix Themes
│   ├── package.json
│   ├── vite.config.ts             # dev-server proxy to the Go gateway
│   ├── index.html
│   ├── .env.example
│   └── src/
│       ├── main.tsx               # Radix <Theme> + react-oidc-context <AuthProvider>
│       ├── App.tsx                # sign-in gate + upload state machine
│       ├── api.ts                 # typed client for POST /upload (sends Bearer token)
│       ├── auth/oidcConfig.ts     # Authorization Code + PKCE(S256) config
│       ├── styles/global.css      # design tokens (see front/README section below)
│       └── components/
│           ├── UploadZone.tsx      # drag-and-drop, spreadsheet-grid signature
│           └── SummaryView.tsx     # stat tiles + column/dtype table
│
├── .gitignore
└── README.md
```

Each layer only depends on `proto/excel_processor.proto` (for `go/` and
`python/`) or on the gateway's JSON contract (for `front/`) - no layer
imports another directly. The identity stack (`docker-compose.yml`,
`infra/`) is a peer dependency both `go/` and `front/` talk to over OIDC,
never imported directly either. Generated stub code and `node_modules`/`dist`
are intentionally **not** committed (`.gitignore` excludes them);
regenerate/reinstall with the commands below any time you clone the repo.

## 1. Run the identity stack (Postgres + Keycloak)

This is the only piece that runs in Docker; `go/`, `python/`, and `front/`
keep running natively as shown further down.

```bash
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD and KEYCLOAK_ADMIN_PASSWORD to real values

docker compose up -d
```

Wait for Keycloak to finish booting (first boot importing the realm can
take a little while), then check:

```bash
curl -s http://localhost:8081/realms/ultra-excel/.well-known/openid-configuration | head -c 200
```

If that returns JSON, the realm imported successfully. You now have:

- **Keycloak admin console**: http://localhost:8081 (login with the
  admin credentials from `.env`)
- **Realm**: `ultra-excel`, containing:
  - Client `ultra-excel-front` - public client, Standard Flow (Authorization
    Code) enabled, `pkce.code.challenge.method` set to `S256`, redirect
    URIs `http://localhost:5173/*`. This is the ONLY client - there's no
    separate confidential client, because the front-end is a public SPA
    and the gateway only *validates* tokens, it never *requests* them.
  - A protocol mapper (`ultra-excel-gateway-audience`, attached directly
    to the client - not a separate named scope, to avoid clobbering
    Keycloak's built-in `profile`/`email`/`roles` scopes on import) that
    stamps `ultra-excel-gateway` into the access token's `aud` claim, so
    the Go gateway can require tokens meant for it specifically.
  - A demo user: **demo / demo1234** - for local testing only, change or
    remove it for anything beyond your own machine.

If realm import ever fails (schema drift between Keycloak versions is
real), the fallback is to create the same thing by hand in the admin
console: **Clients → Create client** → client ID `ultra-excel-front` →
public, Standard Flow only → Advanced tab → set "Proof Key for Code
Exchange Code Challenge Method" to **S256** → Valid redirect URIs
`http://localhost:5173/*` → Web origins `http://localhost:5173`.

### Troubleshooting: `Invalid scopes: openid profile email` / no login page

This means the client ended up with none of Keycloak's standard scopes
attached - usually because a realm export defines a custom `clientScopes`
list without also re-declaring the built-in ones (`profile`, `email`,
`roles`, `web-origins`, `acr`), which silently wipes them. The
`realm-export.json` here avoids this entirely by NOT touching
`clientScopes` at all (Keycloak seeds its own built-ins automatically)
and attaching the audience mapper directly to the client instead of via
a named scope.

**Important**: `--import-realm` only imports a realm the *first* time
Keycloak sees that realm name in its database - restarting the
containers after fixing `realm-export.json` will NOT re-import it, since
Postgres still has the old (broken) realm from the previous boot. To
force a clean re-import:

```bash
docker compose down -v   # -v removes the Postgres volume - full reset
docker compose up -d
```

If you'd rather not lose other data in that Postgres volume, instead
delete the `ultra-excel` realm by hand in the admin console (**Realm
settings → Delete**) and restart just Keycloak (`docker compose restart
keycloak`) to re-trigger the import.

## 2. Generate code from the shared contract

Run these from the **repository root** (`ultra-excel/`).

### 1a. Python stubs

```bash
cd python
pip install -r requirements.txt

python -m grpc_tools.protoc \
  -I ../proto \
  --python_out=. \
  --grpc_python_out=. \
  ../proto/excel_processor.proto
```

This drops `excel_processor_pb2.py` and `excel_processor_pb2_grpc.py`
directly into `python/`, next to `server.py`, which imports them as:
```python
import excel_processor_pb2 as pb2
import excel_processor_pb2_grpc as pb2_grpc
```

### 1b. Go stubs

Install the protoc plugins once:

```bash
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
export PATH="$PATH:$(go env GOPATH)/bin"
```

Generate, from the repo root:

```bash
protoc \
  -I proto \
  --go_out=go/proto/excelprocessor --go_opt=paths=source_relative \
  --go-grpc_out=go/proto/excelprocessor --go-grpc_opt=paths=source_relative \
  proto/excel_processor.proto
```

This produces:
- `go/proto/excelprocessor/excel_processor.pb.go`
- `go/proto/excelprocessor/excel_processor_grpc.pb.go`

`main.go` imports these as `pb "ultraexcel/proto/excelprocessor"` - this
resolves correctly because the Go module is named `ultraexcel` (see
`go/go.mod`) and the generated package lives at
`go/proto/excelprocessor/`, matching the `go_package` option in the
`.proto` file.

## 3. Run the Python worker

```bash
cd python
export GRPC_PORT=50051
export MAX_UPLOAD_BYTES=209715200   # 200MB, optional override
python server.py
```

```
DataProcessor gRPC worker listening on [::]:50051 (max_workers=10, max_upload=209715200 bytes)
```

## 4. Run the Go gateway

Requires the identity stack from step 1 to be up and reachable, since the
gateway performs OIDC discovery against Keycloak at startup (with a few
retries in case Keycloak is still booting - see `setupOIDCVerifier` in
`main.go`).

```bash
cd go
go mod tidy    # resolves gin / grpc / protobuf / go-oidc and writes go.sum

export PYTHON_WORKER_ADDR=localhost:50051
export HTTP_ADDR=:8080
export OIDC_ISSUER_URL=http://localhost:8081/realms/ultra-excel   # default if unset
export OIDC_AUDIENCE=ultra-excel-gateway                          # default if unset
go run ./cmd/gateway
```

```
Gin API Gateway listening on :8080, forwarding to worker at localhost:50051, requiring tokens from http://localhost:8081/realms/ultra-excel
```

Every call to `POST /upload` now requires `Authorization: Bearer
<access_token>`; without one (or with an expired/invalid one) the
gateway responds `401 Unauthorized` before ever touching the gRPC worker
- see `authMiddleware` in `main.go`.

## 5. Run the React front-end

Built with **React + Vite + TypeScript** and **Radix Themes** (Radix's
prebuilt, accessible component set - `Card`, `Table`, `Progress`,
`Callout`, `Badge` - so the UI didn't need hand-rolled component
primitives). `@radix-ui/react-icons` supplies the icon set. Sign-in uses
**react-oidc-context** (`oidc-client-ts` underneath) for Authorization
Code + PKCE against Keycloak.

```bash
cd front
npm install
npm run dev
```

```
  VITE ready
  ➜  Local:   http://localhost:5173/
```

Open `http://localhost:5173`. You'll land on a sign-in screen; clicking
**Se connecter** redirects the page to Keycloak's login form (try the
demo user: `demo` / `demo1234`), and Keycloak redirects back once you're
authenticated. In dev, Vite also proxies `/api/*` straight to the Go
gateway at `http://localhost:8080` (see `front/vite.config.ts`), so no
CORS configuration is needed locally. For a production build:

```bash
cp .env.example .env
# edit .env: VITE_API_URL, VITE_OIDC_AUTHORITY, VITE_OIDC_CLIENT_ID,
# VITE_OIDC_REDIRECT_URI to match your deployed gateway/Keycloak/domain
npm run build   # outputs front/dist/, deploy as a static site
```

When the front-end and gateway are on different origins in production,
also set `FRONTEND_ORIGIN` on the **Go** side (see `go/cmd/gateway/main.go`)
to the exact deployed front-end origin - the gateway's CORS middleware
defaults to `*`, which is fine for local dev but should be locked down
before going to production. Likewise, add the production front-end's
exact origin to the Keycloak client's **Valid redirect URIs** / **Web
origins** (`infra/keycloak/realm-export.json`, or the admin console).

### Authentication flow, in a bit more detail

1. `AuthProvider` (from `react-oidc-context`, configured in
   `front/src/auth/oidcConfig.ts`) checks `sessionStorage` for an
   existing session on load.
2. If none exists, `App.tsx` shows the sign-in screen. Clicking the
   button calls `auth.signinRedirect()`, which navigates the whole page
   to Keycloak's `/auth` endpoint with `response_type=code` and a
   `code_challenge`/`code_challenge_method=S256` generated on the fly -
   this is the PKCE part, and it happens automatically for a public
   client with no configuration beyond `response_type: "code"`.
3. After login, Keycloak redirects back to `redirect_uri` with
   `?code=...&state=...`. `AuthProvider` exchanges the code (plus the
   original `code_verifier`, kept in memory since step 2) for tokens,
   then `onSigninCallback` strips the query string from the URL.
4. `App.tsx` re-renders authenticated; `api.ts`'s `uploadExcelFile` reads
   `auth.user.access_token` and sends it as `Authorization: Bearer
   <token>` on every upload.
5. The Go gateway verifies that token - signature via Keycloak's JWKS,
   issuer, the `ultra-excel-gateway` audience, and expiry - before
   accepting the upload.

### Front-end design notes

- **Palette**: a "paper ledger" theme - warm neutral paper background,
  deep ledger-green accent for verified/processed state, clay amber
  reserved only for flagging missing values. Deliberately not the
  cream+terracotta or near-black+neon looks that generic AI-generated
  UIs default to.
- **Type**: Space Grotesk for the wordmark/headings, Inter for body copy,
  JetBrains Mono for every number, dtype, and filename - numbers and
  schema data read like ledger entries.
- **Signature element**: the drop zone renders a faint spreadsheet grid
  behind the copy; once processing succeeds, its columns fill in
  left-to-right, echoing a workbook being read column by column. It's
  the one animated moment in the UI - everything else stays still.
  `prefers-reduced-motion` disables the stagger.

## 6. Test end-to-end

The easiest path is simply using the front-end (step 5) - it handles the
whole PKCE dance for you. To hit the gateway directly with `curl`, you
need a real access token first. Since the SPA client intentionally has
`directAccessGrantsEnabled: false` (no password grant - PKCE only, as it
should be for a public client), the simplest way to grab one for testing
is straight from the browser after signing in:

```js
// paste in the browser devtools console after signing in at localhost:5173
const key = Object.keys(sessionStorage).find((k) => k.includes("oidc.user"));
console.log(JSON.parse(sessionStorage.getItem(key)).access_token);
```

Then:

```bash
TOKEN="<paste the access token here>"

curl -X POST http://localhost:8080/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/sample.xlsx"
```

Any supported extension works the same way - `.xls`, `.xlsm`, `.xlsb`, etc.
The response now covers every worksheet in the workbook:

```json
{
  "filename": "sample.xlsx",
  "engine_used": "openpyxl",
  "total_sheets": 2,
  "execution_time_ms": 58.3,
  "sheets": [
    {
      "sheet_name": "Sales",
      "total_rows": 1523,
      "total_columns": 8,
      "columns_names": ["id", "name", "revenue", "region", "date", "status", "notes", "tier"],
      "missing_values_count": 14,
      "duplicate_rows_count": 3,
      "data_types": {
        "id": "int64",
        "name": "object",
        "revenue": "float64",
        "date": "datetime64[ns]"
      },
      "numeric_stats": {
        "revenue": { "min": 12.5, "max": 98230.0, "mean": 4213.7, "median": 1980.0, "std_dev": 5920.4, "count": 1512 }
      },
      "sample_rows": [
        { "id": 1, "name": "Alice", "revenue": 4200.0, "region": "EMEA" }
      ]
    },
    { "sheet_name": "Summary", "total_rows": 12, "total_columns": 3, "...": "..." }
  ]
}
```

## 7. Error-handling matrix

| Failure scenario                                    | Go HTTP status              |
|-------------------------------------------------------|------------------------------|
| Missing, invalid, or expired Bearer token               | 401 Unauthorized             |
| Unsupported file extension                             | 415 Unsupported Media Type   |
| File larger than the gateway's size cap                | 413 Payload Too Large        |
| File exceeds the worker's `MAX_UPLOAD_BYTES` mid-stream | 413 Payload Too Large        |
| Corrupted / unparseable workbook, any supported format | 422 Unprocessable Entity     |
| Corrupted / unparseable individual worksheet            | 422 Unprocessable Entity     |
| Empty file, or workbook with zero worksheets            | 422 Unprocessable Entity     |
| Python worker down / connection dropped                 | 503 Service Unavailable      |
| Worker exceeds the 2-minute call timeout                | 504 Gateway Timeout          |
| Client disconnects mid-upload                           | (request canceled, no reply) |

## 8. Production hardening already applied

- **One shared gRPC connection** dialed once at gateway startup, reused
  across all concurrent Gin handlers.
- **Bounded memory on transfer**: 32KB chunks in both directions of the
  pipe, so concurrency doesn't multiply peak memory by file size.
- **Size caps enforced on both sides** - Go checks upload size before
  streaming; Python enforces its own ceiling while accumulating chunks.
- **No stack traces leak to clients** - every pandas/openpyxl/xlrd/pyxlsb
  exception is caught and converted to a clean gRPC status + message,
  both at the workbook level and per-worksheet.
- **Missing-value and duplicate-row counts computed pre-cleaning**,
  reflecting the raw uploaded data's actual quality.
- **Engine selection is extension-driven, not content-sniffed** - the
  worker trusts the filename extension to pick openpyxl/xlrd/pyxlsb,
  which is simple and fast; a mislabeled file (e.g. an .xls renamed to
  .xlsx) will fail with a clear `INVALID_ARGUMENT` rather than silently
  misparsing.
- **Sample rows cross the process boundary as opaque JSON strings**
  (protobuf `string`, not a typed structure), because spreadsheet cells
  can hold arbitrary/mixed types per column. The Go gateway validates
  each string with `json.Valid` before splicing it into the response
  and silently drops anything malformed rather than failing the whole
  request.
- **Insecure gRPC credentials are for trusted-network use only** - see
  the comments in `go/cmd/gateway/main.go` and `python/server.py` for
  where to add TLS/mTLS for cross-network deployments.
- **CORS is permissive by default** (`FRONTEND_ORIGIN` defaults to `*`)
  to keep local dev friction-free - lock it to the exact deployed
  front-end origin before shipping to production.
- **Public client, no client secret, PKCE mandatory** - the front-end is
  a browser SPA and can't keep a secret, so it never gets one; Keycloak
  enforces `pkce.code.challenge.method=S256` on the client, meaning an
  authorization code intercepted in transit is useless without the
  matching `code_verifier`, which never leaves the browser that
  generated it.
- **The gateway never sees credentials, only tokens** - it performs OIDC
  discovery once at startup and verifies tokens locally against
  Keycloak's public keys (JWKS); it never talks to Keycloak per-request
  and never handles a password.
- **Tokens are scoped with an explicit audience** (`ultra-excel-gateway`,
  via a protocol mapper on the client) rather than the gateway accepting
  any token Keycloak issues for any client - a token meant for some
  other application in the same realm will be rejected.
- **Access tokens live in `sessionStorage`, not `localStorage`** (see
  `front/src/auth/oidcConfig.ts`) - cleared when the tab closes, smaller
  exposure window if an XSS bug ever leaks storage contents.

## 9. Suggested next steps (out of scope of this deliverable)

- gRPC health-checking service (`grpc_health_probe`) for k8s liveness/readiness.
- Retries with backoff on `Unavailable` from Go (needs idempotency care for streaming uploads).
- Persist the cleaned DataFrame (currently computed but discarded) to object storage.
- OpenTelemetry tracing across the HTTP → gRPC boundary.
- Role-based authorization beyond "has a valid token" - `authMiddleware`
  already decodes `realm_access.roles` from the token; wiring a check
  for e.g. the `excel-user` realm role (already assigned to the demo
  user in `infra/keycloak/realm-export.json`) is a small addition.
- TLS everywhere - Keycloak's `start-dev`/`KC_HTTP_ENABLED` and the
  gateway's insecure gRPC credentials are both dev-only shortcuts; see
  the inline comments in each file for what to swap in for production.
- A refresh-token rotation strategy if you extend session lifetimes
  beyond Keycloak's default access-token expiry (5 minutes in the
  provided realm export).
