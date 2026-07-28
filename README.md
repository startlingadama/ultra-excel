# ultra-excel

Hybrid architecture: a **Go/Gin API Gateway** streams uploaded `.xlsx`
files over **gRPC** to a **Python/Pandas** worker for analysis, and
returns a structured JSON summary.

```
client --HTTP(multipart)--> [go: Gin Gateway] --gRPC(stream Chunk)--> [python: Pandas worker]
                                    ^                                          |
                                    |-------------- ProcessingSummary ---------|
```

## Project layout (organized by métier / responsibility)

```
ultra-excel/
├── proto/
│   └── excel_processor.proto      # shared gRPC contract (source of truth)
│
├── go/                            # HTTP layer — API Gateway (Gin)
│   ├── go.mod                     # module: ultraexcel
│   ├── cmd/
│   │   └── gateway/
│   │       └── main.go            # Gin server, upload handler, gRPC client, CORS
│   └── proto/
│       └── excelprocessor/        # generated Go stubs land here (gitignored)
│
├── python/                        # Compute layer — gRPC worker (Pandas)
│   ├── requirements.txt
│   ├── server.py                  # gRPC service implementation
│   └── excel_processor_pb2*.py    # generated Python stubs land here (gitignored)
│
├── front/                         # UI layer — React + Radix Themes
│   ├── package.json
│   ├── vite.config.ts             # dev-server proxy to the Go gateway
│   ├── index.html
│   ├── .env.example
│   └── src/
│       ├── main.tsx               # Radix <Theme> provider
│       ├── App.tsx                # upload state machine (idle/uploading/success/error)
│       ├── api.ts                 # typed client for POST /upload
│       ├── styles/global.css      # design tokens (see front/README section below)
│       └── components/
│           ├── UploadZone.tsx      # drag-and-drop, spreadsheet-grid signature
│           └── SummaryView.tsx     # stat tiles + column/dtype table
│
├── .gitignore
└── README.md
```

Each layer only depends on `proto/excel_processor.proto` (for `go/` and
`python/`) or on the gateway's JSON contract (for `front/`) — no layer
imports another directly. Generated stub code and `node_modules`/`dist`
are intentionally **not** committed (`.gitignore` excludes them);
regenerate/reinstall with the commands below any time you clone the repo.

## 1. Generate code from the shared contract

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

`main.go` imports these as `pb "ultraexcel/proto/excelprocessor"` — this
resolves correctly because the Go module is named `ultraexcel` (see
`go/go.mod`) and the generated package lives at
`go/proto/excelprocessor/`, matching the `go_package` option in the
`.proto` file.

## 2. Run the Python worker

```bash
cd python
export GRPC_PORT=50051
export MAX_UPLOAD_BYTES=209715200   # 200MB, optional override
python server.py
```

```
DataProcessor gRPC worker listening on [::]:50051 (max_workers=10, max_upload=209715200 bytes)
```

## 3. Run the Go gateway

```bash
cd go
go mod tidy    # resolves gin / grpc / protobuf and writes go.sum

export PYTHON_WORKER_ADDR=localhost:50051
export HTTP_ADDR=:8080
go run ./cmd/gateway
```

```
Gin API Gateway listening on :8080, forwarding to worker at localhost:50051
```

## 4. Run the React front-end

Built with **React + Vite + TypeScript** and **Radix Themes** (Radix's
prebuilt, accessible component set — `Card`, `Table`, `Progress`,
`Callout`, `Badge` — so the UI didn't need hand-rolled component
primitives). `@radix-ui/react-icons` supplies the icon set.

```bash
cd front
npm install
npm run dev
```

```
  VITE ready
  ➜  Local:   http://localhost:5173/
```

Open `http://localhost:5173`. In dev, Vite proxies `/api/*` straight to
the Go gateway at `http://localhost:8080` (see `front/vite.config.ts`),
so no CORS configuration is needed locally. For a production build
pointed at a deployed gateway:

```bash
cp .env.example .env
# edit .env: VITE_API_URL=https://your-gateway-host
npm run build   # outputs front/dist/, deploy as a static site
```

When the front-end and gateway are on different origins in production,
also set `FRONTEND_ORIGIN` on the **Go** side (see `go/cmd/gateway/main.go`)
to the exact deployed front-end origin — the gateway's CORS middleware
defaults to `*`, which is fine for local dev but should be locked down
before going to production.

### Front-end design notes

- **Palette**: a "paper ledger" theme — warm neutral paper background,
  deep ledger-green accent for verified/processed state, clay amber
  reserved only for flagging missing values. Deliberately not the
  cream+terracotta or near-black+neon looks that generic AI-generated
  UIs default to.
- **Type**: Space Grotesk for the wordmark/headings, Inter for body copy,
  JetBrains Mono for every number, dtype, and filename — numbers and
  schema data read like ledger entries.
- **Signature element**: the drop zone renders a faint spreadsheet grid
  behind the copy; once processing succeeds, its columns fill in
  left-to-right, echoing a workbook being read column by column. It's
  the one animated moment in the UI — everything else stays still.
  `prefers-reduced-motion` disables the stagger.

## 5. Test end-to-end

```bash
curl -X POST http://localhost:8080/upload \
  -F "file=@/path/to/sample.xlsx"
```

```json
{
  "total_rows": 1523,
  "total_columns": 8,
  "columns_names": ["id", "name", "revenue", "region", "date", "status", "notes", "tier"],
  "missing_values_count": 14,
  "data_types": {
    "id": "int64",
    "name": "object",
    "revenue": "float64",
    "date": "datetime64[ns]"
  },
  "execution_time_ms": 42.7
}
```

## 6. Error-handling matrix

| Failure scenario                                    | Go HTTP status              |
|-------------------------------------------------------|------------------------------|
| Non-`.xlsx` extension                                 | 415 Unsupported Media Type   |
| File larger than the gateway's size cap                | 413 Payload Too Large        |
| File exceeds the worker's `MAX_UPLOAD_BYTES` mid-stream | 413 Payload Too Large        |
| Corrupted / non-Excel binary content                    | 422 Unprocessable Entity     |
| Empty file                                              | 422 Unprocessable Entity     |
| Python worker down / connection dropped                 | 503 Service Unavailable      |
| Worker exceeds the 2-minute call timeout                | 504 Gateway Timeout          |
| Client disconnects mid-upload                           | (request canceled, no reply) |

## 7. Production hardening already applied

- **One shared gRPC connection** dialed once at gateway startup, reused
  across all concurrent Gin handlers.
- **Bounded memory on transfer**: 32KB chunks in both directions of the
  pipe, so concurrency doesn't multiply peak memory by file size.
- **Size caps enforced on both sides** — Go checks upload size before
  streaming; Python enforces its own ceiling while accumulating chunks.
- **No stack traces leak to clients** — every pandas/openpyxl exception
  is caught and converted to a clean gRPC status + message.
- **Missing-value count computed pre-cleaning**, reflecting the raw
  uploaded data's actual quality.
- **Insecure gRPC credentials are for trusted-network use only** — see
  the comments in `go/cmd/gateway/main.go` and `python/server.py` for
  where to add TLS/mTLS for cross-network deployments.
- **CORS is permissive by default** (`FRONTEND_ORIGIN` defaults to `*`)
  to keep local dev friction-free — lock it to the exact deployed
  front-end origin before shipping to production.

## 8. Suggested next steps (out of scope of this deliverable)

- gRPC health-checking service (`grpc_health_probe`) for k8s liveness/readiness.
- Retries with backoff on `Unavailable` from Go (needs idempotency care for streaming uploads).
- Persist the cleaned DataFrame (currently computed but discarded) to object storage.
- OpenTelemetry tracing across the HTTP → gRPC boundary.
