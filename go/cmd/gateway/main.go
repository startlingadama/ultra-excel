// main.go - Go/Gin API Gateway.
//
// Responsibilities:
//  1. Expose POST /upload accepting multipart/form-data with a "file" field.
//     Accepts any Excel format the Python worker can parse: .xlsx, .xlsm,
//     .xltx, .xltm, .xls, .xlt, .xlsb (see supportedExtensions below).
//  2. Validate the upload (extension, size).
//  3. Require and verify a Keycloak-issued OIDC access token (Bearer
//     JWT) on every call to /upload --see authMiddleware. The gateway
//     never handles login itself; the front-end obtains the token via
//     Authorization Code + PKCE (S256) directly against Keycloak (see
//     infra/keycloak/ and front/src/auth/), then attaches it here.
//  4. Stream the file to the Python gRPC worker in fixed-size chunks via
//     a client-streaming RPC, using a single shared, long-lived gRPC
//     connection (NOT one connection per request).
//  5. Return the ProcessingSummary (per-sheet, with numeric stats,
//     duplicate counts, and a data preview) as clean JSON.
//  6. Handle errors robustly: oversized files, network/connection loss,
//     corrupted workbooks, worker timeouts, invalid/expired tokens.
//
// Build/run instructions are in README.md.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-gonic/gin"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "ultraexcel/proto/excelprocessor"
)

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

const (
	chunkSize          = 32 * 1024         // 32KB per streamed chunk
	maxUploadBytes     = 200 * 1024 * 1024 // 200MB hard ceiling, mirrors Python worker
	grpcCallTimeout    = 2 * time.Minute   // generous ceiling for large files
	grpcDialTimeout    = 5 * time.Second
	oidcDiscoveryRetry = 3 * time.Second // Keycloak may still be booting when we start
	oidcDiscoveryTries = 10
)

// server bundles the shared gRPC client connection so it is created once
// at startup and reused (pooled internally by gRPC) across concurrent
// Gin handlers, rather than dialing per-request.
type server struct {
	grpcClient pb.DataProcessorClient
}

func main() {
	workerAddr := os.Getenv("PYTHON_WORKER_ADDR")
	if workerAddr == "" {
		workerAddr = "localhost:50051"
	}

	conn, err := dialWorker(workerAddr)
	if err != nil {
		log.Fatalf("failed to connect to Python gRPC worker at %s: %v", workerAddr, err)
	}
	defer conn.Close()

	issuerURL := os.Getenv("OIDC_ISSUER_URL")
	if issuerURL == "" {
		issuerURL = "http://localhost:8081/realms/ultra-excel"
	}
	audience := os.Getenv("OIDC_AUDIENCE")
	if audience == "" {
		audience = "ultra-excel-gateway"
	}

	verifier, err := setupOIDCVerifier(context.Background(), issuerURL, audience)
	if err != nil {
		log.Fatalf(
			"failed to set up OIDC verifier against issuer %s (is Keycloak up and is the "+
				"realm imported? see infra/keycloak/): %v", issuerURL, err,
		)
	}

	srv := &server{grpcClient: pb.NewDataProcessorClient(conn)}

	router := gin.New()
	router.Use(gin.Logger(), gin.Recovery(), corsMiddleware())

	// Belt-and-suspenders limit on top of our own manual streaming check -
	// prevents Gin from buffering an enormous multipart body in the first
	// place.
	router.MaxMultipartMemory = 8 << 20 // 8MB kept in memory; rest spills to temp files

	router.POST("/upload", authMiddleware(verifier), srv.handleUpload)

	addr := os.Getenv("HTTP_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	log.Printf(
		"Gin API Gateway listening on %s, forwarding to worker at %s, requiring tokens from %s",
		addr, workerAddr, issuerURL,
	)
	if err := router.Run(addr); err != nil {
		log.Fatalf("HTTP server failed: %v", err)
	}
}

// setupOIDCVerifier performs OIDC discovery against Keycloak's realm
// (fetching /.well-known/openid-configuration to locate the JWKS
// endpoint) and returns a verifier that checks a token's signature,
// issuer, audience, and expiry. Discovery is retried for a while at
// startup since Keycloak (especially with --import-realm on first boot)
// can take longer to become ready than this gateway.
func setupOIDCVerifier(ctx context.Context, issuerURL, audience string) (*oidc.IDTokenVerifier, error) {
	var lastErr error
	for attempt := 1; attempt <= oidcDiscoveryTries; attempt++ {
		provider, err := oidc.NewProvider(ctx, issuerURL)
		if err == nil {
			return provider.Verifier(&oidc.Config{ClientID: audience}), nil
		}
		lastErr = err
		log.Printf(
			"OIDC discovery against %s failed (attempt %d/%d): %v - retrying in %s",
			issuerURL, attempt, oidcDiscoveryTries, err, oidcDiscoveryRetry,
		)
		time.Sleep(oidcDiscoveryRetry)
	}
	return nil, fmt.Errorf("giving up after %d attempts: %w", oidcDiscoveryTries, lastErr)
}

// authMiddleware requires a valid Keycloak-issued Bearer access token on
// every request it guards. It does NOT perform login - that happens
// entirely on the front-end via Authorization Code + PKCE against
// Keycloak directly (see front/src/auth/). This middleware only verifies
// the resulting token: signature (via Keycloak's JWKS), issuer, intended
// audience, and expiry.
func authMiddleware(verifier *oidc.IDTokenVerifier) gin.HandlerFunc {
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		const prefix = "Bearer "
		if !strings.HasPrefix(header, prefix) {
			c.AbortWithStatusJSON(http.StatusUnauthorized, errorResponse{
				Error: "missing bearer token - sign in first",
			})
			return
		}

		rawToken := strings.TrimPrefix(header, prefix)
		token, err := verifier.Verify(c.Request.Context(), rawToken)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, errorResponse{
				Error: "invalid or expired token: " + err.Error(),
			})
			return
		}

		var claims struct {
			PreferredUsername string `json:"preferred_username"`
			RealmAccess       struct {
				Roles []string `json:"roles"`
			} `json:"realm_access"`
		}
		if err := token.Claims(&claims); err == nil {
			// Stashed for handlers/logging that want to know who's
			// calling; not currently used for role-based authorization,
			// but claims.RealmAccess.Roles is where you'd check for e.g.
			// "excel-user" if you want to restrict access further.
			c.Set("username", claims.PreferredUsername)
		}

		c.Next()
	}
}

// corsMiddleware allows the React front-end (see front/) to call this API
// from a different origin - necessary in production where the SPA and the
// gateway are typically served from different hosts (in local dev, Vite's
// own proxy avoids CORS entirely, see front/vite.config.ts).
//
// FRONTEND_ORIGIN defaults to "*" for convenience in local/dev setups.
// In production, set it to the exact deployed front-end origin (e.g.
// "https://ultra-excel.example.com") - do not leave it as "*" once
// credentials or cookies are involved.
func corsMiddleware() gin.HandlerFunc {
	allowedOrigin := os.Getenv("FRONTEND_ORIGIN")
	if allowedOrigin == "" {
		allowedOrigin = "*"
	}

	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", allowedOrigin)
		c.Header("Access-Control-Allow-Methods", "POST, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization")
		c.Header("Access-Control-Max-Age", "600")

		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// dialWorker establishes the single long-lived gRPC connection to the
// Python worker. gRPC connections are safe for concurrent use by many
// goroutines, so this is created once and shared.
func dialWorker(addr string) (*grpc.ClientConn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), grpcDialTimeout)
	defer cancel()

	return grpc.DialContext(
		ctx,
		addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		// NOTE: insecure credentials are appropriate for a trusted internal
		// network (e.g. same pod/VPC as the worker). For cross-network
		// deployments, replace with TLS credentials and mTLS on both ends.
		grpc.WithBlock(),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallSendMsgSize(8*1024*1024),
			grpc.MaxCallRecvMsgSize(8*1024*1024),
		),
	)
}

// --------------------------------------------------------------------------
// JSON response types
// --------------------------------------------------------------------------

// columnStats mirrors ColumnStats.
type columnStats struct {
	Min    float64 `json:"min"`
	Max    float64 `json:"max"`
	Mean   float64 `json:"mean"`
	Median float64 `json:"median"`
	StdDev float64 `json:"std_dev"`
	Count  int64   `json:"count"`
}

// sheetSummary mirrors SheetSummary.
type sheetSummary struct {
	SheetName          string                 `json:"sheet_name"`
	TotalRows          int64                  `json:"total_rows"`
	TotalColumns       int64                  `json:"total_columns"`
	ColumnsNames       []string               `json:"columns_names"`
	MissingValuesCount int64                  `json:"missing_values_count"`
	DataTypes          map[string]string      `json:"data_types"`
	DuplicateRowsCount int64                  `json:"duplicate_rows_count"`
	NumericStats       map[string]columnStats `json:"numeric_stats"`
	// SampleRows holds each preview row as genuine nested JSON (not a
	// double-encoded string): the worker sends each row as a JSON object
	// string, and json.RawMessage lets us splice that string directly
	// into the outgoing response body without re-marshaling it.
	SampleRows []json.RawMessage `json:"sample_rows"`
}

// uploadResponse mirrors ProcessingSummary but as clean, idiomatic JSON.
type uploadResponse struct {
	Filename        string         `json:"filename"`
	EngineUsed      string         `json:"engine_used"`
	TotalSheets     int64          `json:"total_sheets"`
	Sheets          []sheetSummary `json:"sheets"`
	ExecutionTimeMs float32        `json:"execution_time_ms"`
}

type errorResponse struct {
	Error string `json:"error"`
}

// toUploadResponse converts the gRPC ProcessingSummary into the JSON
// shape returned to the front-end.
func toUploadResponse(summary *pb.ProcessingSummary) uploadResponse {
	sheets := make([]sheetSummary, 0, len(summary.GetSheets()))
	for _, s := range summary.GetSheets() {
		stats := make(map[string]columnStats, len(s.GetNumericStats()))
		for col, cs := range s.GetNumericStats() {
			stats[col] = columnStats{
				Min:    cs.GetMin(),
				Max:    cs.GetMax(),
				Mean:   cs.GetMean(),
				Median: cs.GetMedian(),
				StdDev: cs.GetStdDev(),
				Count:  cs.GetCount(),
			}
		}

		rows := make([]json.RawMessage, 0, len(s.GetSampleRowsJson()))
		for _, raw := range s.GetSampleRowsJson() {
			if json.Valid([]byte(raw)) {
				rows = append(rows, json.RawMessage(raw))
			}
			// Silently skip a malformed row rather than failing the whole
			// response - the worker should always emit valid JSON here,
			// but the gateway stays defensive about data crossing a
			// process boundary.
		}

		sheets = append(sheets, sheetSummary{
			SheetName:          s.GetSheetName(),
			TotalRows:          s.GetTotalRows(),
			TotalColumns:       s.GetTotalColumns(),
			ColumnsNames:       s.GetColumnsNames(),
			MissingValuesCount: s.GetMissingValuesCount(),
			DataTypes:          s.GetDataTypes(),
			DuplicateRowsCount: s.GetDuplicateRowsCount(),
			NumericStats:       stats,
			SampleRows:         rows,
		})
	}

	return uploadResponse{
		Filename:        summary.GetFilename(),
		EngineUsed:      summary.GetEngineUsed(),
		TotalSheets:     summary.GetTotalSheets(),
		Sheets:          sheets,
		ExecutionTimeMs: summary.GetExecutionTimeMs(),
	}
}

// --------------------------------------------------------------------------
// Handler
// --------------------------------------------------------------------------

func (s *server) handleUpload(c *gin.Context) {
	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "missing or invalid 'file' form field: " + err.Error()})
		return
	}

	if !hasSupportedExcelExtension(fileHeader.Filename) {
		c.JSON(http.StatusUnsupportedMediaType, errorResponse{
			Error: "unsupported file type for '" + fileHeader.Filename + "', accepted extensions: " + supportedExtensionsList(),
		})
		return
	}

	if fileHeader.Size > maxUploadBytes {
		c.JSON(http.StatusRequestEntityTooLarge, errorResponse{
			Error: "file exceeds maximum allowed size of " + strconv.Itoa(maxUploadBytes) + " bytes",
		})
		return
	}

	file, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "could not open uploaded file: " + err.Error()})
		return
	}
	defer file.Close()

	summary, err := s.streamToWorker(c.Request.Context(), file, fileHeader.Filename)
	if err != nil {
		writeStreamError(c, err)
		return
	}

	c.JSON(http.StatusOK, toUploadResponse(summary))
}

// streamToWorker opens the client-streaming RPC, reads the multipart file
// in chunkSize pieces, forwards each as a Chunk message, and returns the
// final ProcessingSummary once the worker finishes.
func (s *server) streamToWorker(
	ctx context.Context,
	file multipart.File,
	filename string,
) (*pb.ProcessingSummary, error) {
	ctx, cancel := context.WithTimeout(ctx, grpcCallTimeout)
	defer cancel()

	stream, err := s.grpcClient.UploadAndProcess(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to open stream to worker: %w", err)
	}

	buf := make([]byte, chunkSize)
	firstChunk := true

	for {
		n, readErr := file.Read(buf)
		if n > 0 {
			chunk := &pb.Chunk{Data: buf[:n]}
			if firstChunk {
				chunk.Filename = filename
				firstChunk = false
			}
			if sendErr := stream.Send(chunk); sendErr != nil {
				// If Send fails, the real error is usually surfaced by
				// CloseAndRecv (per gRPC client-streaming semantics), so
				// we break out and let that call return the authoritative
				// error rather than returning io.EOF from Send here.
				break
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			// Local disk/network read failure on the multipart body itself.
			return nil, fmt.Errorf("error reading uploaded file: %w", readErr)
		}
	}

	summary, err := stream.CloseAndRecv()
	if err != nil {
		return nil, fmt.Errorf("worker processing failed: %w", err)
	}
	if !summary.GetSuccess() {
		return nil, fmt.Errorf("worker reported failure: %s", summary.GetErrorMessage())
	}
	return summary, nil
}

// writeStreamError maps gRPC/transport errors into appropriate HTTP status
// codes and a clean JSON error body.
func writeStreamError(c *gin.Context, err error) {
	st, ok := status.FromError(err)
	if !ok {
		// Not a gRPC status error - likely a local I/O error or a wrapped
		// context deadline.
		if errors.Is(err, context.DeadlineExceeded) {
			c.JSON(http.StatusGatewayTimeout, errorResponse{Error: "processing timed out"})
			return
		}
		c.JSON(http.StatusInternalServerError, errorResponse{Error: err.Error()})
		return
	}

	switch st.Code() {
	case codes.InvalidArgument:
		// Corrupted/unparseable Excel file, or empty upload.
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: st.Message()})
	case codes.ResourceExhausted:
		c.JSON(http.StatusRequestEntityTooLarge, errorResponse{Error: st.Message()})
	case codes.DeadlineExceeded:
		c.JSON(http.StatusGatewayTimeout, errorResponse{Error: "worker did not respond in time"})
	case codes.Unavailable:
		// Network loss / worker down / connection reset mid-stream.
		c.JSON(http.StatusServiceUnavailable, errorResponse{Error: "processing worker is unavailable, please retry"})
	case codes.Canceled:
		c.JSON(http.StatusRequestTimeout, errorResponse{Error: "request was canceled"})
	default:
		c.JSON(http.StatusBadGateway, errorResponse{Error: "unexpected worker error: " + st.Message()})
	}
}

// supportedExtensions mirrors the Python worker's ENGINE_BY_EXTENSION
// (see python/server.py) - every format pandas can parse there is
// accepted here. Kept as a set literal rather than importing anything
// from the worker, since Go and Python are intentionally decoupled and
// only agree via the .proto contract.
var supportedExtensions = map[string]bool{
	".xlsx": true, // modern XML-zip workbook
	".xlsm": true, // macro-enabled workbook
	".xltx": true, // XML-zip template
	".xltm": true, // macro-enabled template
	".xls":  true, // legacy binary workbook (Excel 97-2003)
	".xlt":  true, // legacy binary template
	".xlsb": true, // Excel binary workbook
}

func hasSupportedExcelExtension(filename string) bool {
	return supportedExtensions[strings.ToLower(filepath.Ext(filename))]
}

func supportedExtensionsList() string {
	exts := make([]string, 0, len(supportedExtensions))
	for ext := range supportedExtensions {
		exts = append(exts, ext)
	}
	return strings.Join(exts, ", ")
}
