// main.go — Go/Gin API Gateway.
//
// Responsibilities:
//   1. Expose POST /upload accepting multipart/form-data with a "file" field.
//   2. Validate the upload (extension, size).
//   3. Stream the file to the Python gRPC worker in fixed-size chunks via
//      a client-streaming RPC, using a single shared, long-lived gRPC
//      connection (NOT one connection per request).
//   4. Return the ProcessingSummary as clean JSON.
//   5. Handle errors robustly: oversized files, network/connection loss,
//      corrupted workbooks, worker timeouts.
//
// Build/run instructions are in README.md.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"strconv"
	"time"

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
	chunkSize       = 32 * 1024         // 32KB per streamed chunk
	maxUploadBytes  = 200 * 1024 * 1024 // 200MB hard ceiling, mirrors Python worker
	grpcCallTimeout = 2 * time.Minute   // generous ceiling for large files
	grpcDialTimeout = 5 * time.Second
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

	srv := &server{grpcClient: pb.NewDataProcessorClient(conn)}

	router := gin.New()
	router.Use(gin.Logger(), gin.Recovery(), corsMiddleware())

	// Belt-and-suspenders limit on top of our own manual streaming check —
	// prevents Gin from buffering an enormous multipart body in the first
	// place.
	router.MaxMultipartMemory = 8 << 20 // 8MB kept in memory; rest spills to temp files

	router.POST("/upload", srv.handleUpload)

	addr := os.Getenv("HTTP_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	log.Printf("Gin API Gateway listening on %s, forwarding to worker at %s", addr, workerAddr)
	if err := router.Run(addr); err != nil {
		log.Fatalf("HTTP server failed: %v", err)
	}
}

// corsMiddleware allows the React front-end (see front/) to call this API
// from a different origin — necessary in production where the SPA and the
// gateway are typically served from different hosts (in local dev, Vite's
// own proxy avoids CORS entirely, see front/vite.config.ts).
//
// FRONTEND_ORIGIN defaults to "*" for convenience in local/dev setups.
// In production, set it to the exact deployed front-end origin (e.g.
// "https://ultra-excel.example.com") — do not leave it as "*" once
// credentials or cookies are involved.
func corsMiddleware() gin.HandlerFunc {
	allowedOrigin := os.Getenv("FRONTEND_ORIGIN")
	if allowedOrigin == "" {
		allowedOrigin = "*"
	}

	return func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", allowedOrigin)
		c.Header("Access-Control-Allow-Methods", "POST, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Content-Type")
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

// uploadResponse mirrors ProcessingSummary but as clean, idiomatic JSON.
type uploadResponse struct {
	TotalRows          int64             `json:"total_rows"`
	TotalColumns       int64             `json:"total_columns"`
	ColumnsNames       []string          `json:"columns_names"`
	MissingValuesCount int64             `json:"missing_values_count"`
	DataTypes          map[string]string `json:"data_types"`
	ExecutionTimeMs    float32           `json:"execution_time_ms"`
}

type errorResponse struct {
	Error string `json:"error"`
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

	if !hasXlsxExtension(fileHeader.Filename) {
		c.JSON(http.StatusUnsupportedMediaType, errorResponse{
			Error: "only .xlsx files are supported, received: " + fileHeader.Filename,
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

	c.JSON(http.StatusOK, uploadResponse{
		TotalRows:          summary.GetTotalRows(),
		TotalColumns:       summary.GetTotalColumns(),
		ColumnsNames:       summary.GetColumnsNames(),
		MissingValuesCount: summary.GetMissingValuesCount(),
		DataTypes:          summary.GetDataTypes(),
		ExecutionTimeMs:    summary.GetExecutionTimeMs(),
	})
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
		// Not a gRPC status error — likely a local I/O error or a wrapped
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

func hasXlsxExtension(filename string) bool {
	if len(filename) < 6 {
		return false
	}
	return filename[len(filename)-5:] == ".xlsx"
}
