"""
server.py — Python gRPC processing worker.

Responsibilities (and ONLY these — this process has no HTTP layer, no
routing, no auth; it is a pure compute worker sitting behind gRPC):

  1. Accept a client-streamed sequence of `Chunk` messages over gRPC.
  2. Assemble the chunks into an in-memory byte buffer.
  3. Parse the buffer with pandas.read_excel().
  4. Compute summary statistics + a placeholder cleaning step.
  5. Return a `ProcessingSummary` message.

Run with:
    python server.py

Environment variables:
    GRPC_PORT                 (default: 50051)
    GRPC_MAX_WORKERS          (default: 10)   -> thread pool size
    MAX_UPLOAD_BYTES          (default: 209715200 / 200MB) -> hard cap on
                               assembled file size to protect worker memory
"""

from __future__ import annotations

import io
import logging
import os
import time
from concurrent import futures
from typing import Iterator

import grpc
import pandas as pd

import excel_processor_pb2 as pb2
import excel_processor_pb2_grpc as pb2_grpc

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

GRPC_PORT = int(os.environ.get("GRPC_PORT", "50051"))
GRPC_MAX_WORKERS = int(os.environ.get("GRPC_MAX_WORKERS", "10"))
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(200 * 1024 * 1024)))  # 200MB

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("excel-worker")


class DataProcessorServicer(pb2_grpc.DataProcessorServicer):
    """Implements the DataProcessor gRPC service defined in
    excel_processor.proto."""

    def UploadAndProcess(
        self,
        request_iterator: Iterator[pb2.Chunk],
        context: grpc.ServicerContext,
    ) -> pb2.ProcessingSummary:
        """Consume the incoming Chunk stream, assemble it, and process it
        with pandas.

        Design notes:
          - We buffer chunks into a single io.BytesIO because
            pandas/openpyxl need random-access/seekable input to parse the
            .xlsx zip container — true zero-copy incremental xlsx parsing
            isn't feasible with a streaming pandas API. The streaming RPC
            still buys us bounded *network transfer* memory (one chunk at
            a time in flight) and lets Go start forwarding the file before
            it has finished reading it from the client's multipart body.
          - We enforce MAX_UPLOAD_BYTES while accumulating, so a
            malicious/mistaken huge upload is rejected before pandas ever
            touches it, rather than after we've already paid the memory
            cost of loading the whole thing.
        """
        start = time.perf_counter()
        filename = "<unknown>"
        buffer = io.BytesIO()
        received_bytes = 0

        try:
            for i, chunk in enumerate(request_iterator):
                if i == 0 and chunk.filename:
                    filename = chunk.filename

                received_bytes += len(chunk.data)
                if received_bytes > MAX_UPLOAD_BYTES:
                    logger.warning(
                        "Rejecting upload '%s': exceeded max size (%d > %d bytes)",
                        filename,
                        received_bytes,
                        MAX_UPLOAD_BYTES,
                    )
                    context.abort(
                        grpc.StatusCode.RESOURCE_EXHAUSTED,
                        f"File exceeds maximum allowed size of {MAX_UPLOAD_BYTES} bytes",
                    )
                    # context.abort raises internally; this return is unreachable
                    # but keeps type-checkers/linters happy.
                    return pb2.ProcessingSummary(success=False)

                buffer.write(chunk.data)

        except grpc.RpcError:
            # A client-side disconnect or transport error while streaming.
            # Nothing more to do — gRPC will surface this to the client.
            logger.exception("Client streaming error while receiving '%s'", filename)
            raise

        if received_bytes == 0:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "Received an empty file")
            return pb2.ProcessingSummary(success=False)

        buffer.seek(0)
        logger.info("Received '%s' (%d bytes), beginning processing", filename, received_bytes)

        # ---- Parse -----------------------------------------------------
        try:
            df = pd.read_excel(buffer, engine="openpyxl")
        except Exception as exc:  # noqa: BLE001 - we deliberately want to
            # convert ANY pandas/openpyxl parsing failure into a clean,
            # user-facing gRPC error rather than a stack trace leak.
            logger.warning("Failed to parse '%s' as an Excel file: %s", filename, exc)
            context.abort(
                grpc.StatusCode.INVALID_ARGUMENT,
                f"Could not parse file as a valid .xlsx workbook: {exc}",
            )
            return pb2.ProcessingSummary(success=False)

        if df.empty and len(df.columns) == 0:
            context.abort(
                grpc.StatusCode.INVALID_ARGUMENT,
                "Workbook parsed successfully but contains no columns",
            )
            return pb2.ProcessingSummary(success=False)

        # ---- Analyze (BEFORE cleaning, so missing-value count reflects
        #      the raw uploaded data, not the post-cleaning state) --------
        total_rows = int(df.shape[0])
        total_columns = int(df.shape[1])
        column_names = [str(c) for c in df.columns]
        missing_values_count = int(df.isnull().sum().sum())
        data_types = {str(col): str(dtype) for col, dtype in df.dtypes.items()}

        # ---- Clean -------------------------------------------------------
        # Placeholder cleaning step as specified: forward-fill missing
        # values. This mutates `df` locally only; the cleaned frame is not
        # currently persisted or returned (no such field exists on
        # ProcessingSummary), but the step demonstrates where a real
        # cleaning/normalization pipeline would hook in (e.g. before
        # writing to a warehouse or cache).
        df = df.ffill()

        elapsed_ms = (time.perf_counter() - start) * 1000.0

        logger.info(
            "Finished processing '%s': %d rows x %d cols, %d missing cells, %.2fms",
            filename,
            total_rows,
            total_columns,
            missing_values_count,
            elapsed_ms,
        )

        return pb2.ProcessingSummary(
            success=True,
            total_rows=total_rows,
            total_columns=total_columns,
            columns_names=column_names,
            missing_values_count=missing_values_count,
            data_types=data_types,
            execution_time_ms=elapsed_ms,
            error_message="",
        )


def serve() -> None:
    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=GRPC_MAX_WORKERS),
        options=[
            # These bound the size of any SINGLE gRPC message. Individual
            # Chunk messages are small (~32-64KB), so the defaults would
            # be fine, but we set generous explicit limits so the service
            # also tolerates a ProcessingSummary with a very large
            # columns_names/data_types payload (e.g. wide spreadsheets).
            ("grpc.max_send_message_length", 32 * 1024 * 1024),
            ("grpc.max_receive_message_length", 32 * 1024 * 1024),
        ],
    )
    pb2_grpc.add_DataProcessorServicer_to_server(DataProcessorServicer(), server)

    bind_addr = f"[::]:{GRPC_PORT}"
    server.add_insecure_port(bind_addr)
    # NOTE: add_insecure_port is appropriate here because this service is
    # intended to run on a private network / sidecar / same pod as the Go
    # gateway. For cross-network deployments, replace with
    # server.add_secure_port(bind_addr, grpc.ssl_server_credentials(...))
    # and configure mTLS between Go and Python.

    server.start()
    logger.info("DataProcessor gRPC worker listening on %s (max_workers=%d, max_upload=%d bytes)",
                bind_addr, GRPC_MAX_WORKERS, MAX_UPLOAD_BYTES)

    try:
        server.wait_for_termination()
    except KeyboardInterrupt:
        logger.info("Shutting down gracefully...")
        server.stop(grace=5)


if __name__ == "__main__":
    serve()
