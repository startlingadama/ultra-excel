"""
server.py - Python gRPC processing worker.

Responsibilities (and ONLY these - this process has no HTTP layer, no
routing, no auth; it is a pure compute worker sitting behind gRPC):

  1. Accept a client-streamed sequence of `Chunk` messages over gRPC.
  2. Assemble the chunks into an in-memory byte buffer.
  3. Detect the workbook format from the filename and pick the matching
     pandas engine (openpyxl / xlrd / pyxlsb).
  4. Parse EVERY sheet in the workbook with pandas.
  5. Compute per-sheet summary statistics, numeric column stats,
     duplicate-row counts, a small data preview, and a placeholder
     cleaning step.
  6. Return a structured `ProcessingSummary` covering all sheets.

Run with:
    python server.py

Environment variables:
    GRPC_PORT                 (default: 50051)
    GRPC_MAX_WORKERS          (default: 10)   -> thread pool size
    MAX_UPLOAD_BYTES          (default: 209715200 / 200MB) -> hard cap on
                               assembled file size to protect worker memory
    SAMPLE_ROWS                (default: 5)   -> rows included in the preview
"""

from __future__ import annotations

import io
import json
import logging
import math
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
SAMPLE_ROWS = int(os.environ.get("SAMPLE_ROWS", "5"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)
logger = logging.getLogger("excel-worker")

# --------------------------------------------------------------------------
# Format detection: map file extension -> pandas/openpyxl-family engine.
#
#   openpyxl -> modern XML-zip formats (Excel 2007+)
#   xlrd     -> legacy binary format (Excel 97-2003). Note: xlrd>=2.0
#               dropped .xlsx support entirely, so it is ONLY used here
#               for the true legacy extensions.
#   pyxlsb   -> Excel's binary workbook format (a distinct format from
#               legacy .xls, introduced in Excel 2007 as a faster binary
#               alternative to .xlsx).
# --------------------------------------------------------------------------

ENGINE_BY_EXTENSION: dict[str, str] = {
    ".xlsx": "openpyxl",
    ".xlsm": "openpyxl",
    ".xltx": "openpyxl",
    ".xltm": "openpyxl",
    ".xls": "xlrd",
    ".xlt": "xlrd",
    ".xlsb": "pyxlsb",
}


def resolve_engine(filename: str) -> str:
    """Returns the pandas engine name for a given filename's extension,
    or raises ValueError if the extension isn't a supported Excel format."""
    _, ext = os.path.splitext(filename.lower())
    engine = ENGINE_BY_EXTENSION.get(ext)
    if engine is None:
        supported = ", ".join(sorted(ENGINE_BY_EXTENSION))
        raise ValueError(f"Unsupported file extension '{ext}'. Supported: {supported}")
    return engine


def _safe_float(value: float) -> float:
    """Coerces NaN/inf (which protobuf `double` cannot represent safely
    for JSON consumers downstream) to 0.0."""
    if value is None or (isinstance(value, float) and (math.isnan(value) or math.isinf(value))):
        return 0.0
    return float(value)


def _json_default(value):
    """Fallback serializer for values json.dumps doesn't natively handle
    (pandas Timestamps, numpy scalars, NaT, etc.)."""
    if pd.isna(value):
        return None
    return str(value)


def _build_sheet_summary(sheet_name: str, df: pd.DataFrame) -> pb2.SheetSummary:
    """Analyzes a single already-loaded DataFrame and returns its
    SheetSummary. Statistics are computed BEFORE the cleaning step so
    they reflect the sheet's actual, as-uploaded data quality."""

    total_rows = int(df.shape[0])
    total_columns = int(df.shape[1])
    column_names = [str(c) for c in df.columns]
    missing_values_count = int(df.isnull().sum().sum())
    data_types = {str(col): str(dtype) for col, dtype in df.dtypes.items()}
    duplicate_rows_count = int(df.duplicated().sum())

    # ---- Numeric column statistics -----------------------------------
    numeric_stats: dict[str, pb2.ColumnStats] = {}
    numeric_df = df.select_dtypes(include="number")
    for col in numeric_df.columns:
        series = numeric_df[col].dropna()
        if series.empty:
            continue
        numeric_stats[str(col)] = pb2.ColumnStats(
            min=_safe_float(series.min()),
            max=_safe_float(series.max()),
            mean=_safe_float(series.mean()),
            median=_safe_float(series.median()),
            std_dev=_safe_float(series.std()) if len(series) > 1 else 0.0,
            count=int(series.count()),
        )

    # ---- Sample preview rows ------------------------------------------
    preview_df = df.head(SAMPLE_ROWS)
    sample_rows_json = [
        json.dumps(row, default=_json_default, ensure_ascii=False)
        for row in preview_df.to_dict(orient="records")
    ]

    return pb2.SheetSummary(
        sheet_name=str(sheet_name),
        total_rows=total_rows,
        total_columns=total_columns,
        columns_names=column_names,
        missing_values_count=missing_values_count,
        data_types=data_types,
        duplicate_rows_count=duplicate_rows_count,
        numeric_stats=numeric_stats,
        sample_rows_json=sample_rows_json,
    )


class DataProcessorServicer(pb2_grpc.DataProcessorServicer):
    """Implements the DataProcessor gRPC service defined in
    excel_processor.proto."""

    def UploadAndProcess(
        self,
        request_iterator: Iterator[pb2.Chunk],
        context: grpc.ServicerContext,
    ) -> pb2.ProcessingSummary:
        """Consume the incoming Chunk stream, assemble it, and process
        every sheet with pandas.

        Design notes:
          - We buffer chunks into a single io.BytesIO because every
            supported Excel format (zip-based or legacy binary) needs
            random-access/seekable input to parse its container - true
            zero-copy incremental parsing isn't feasible for any of
            these formats. The streaming RPC still buys us bounded
            *network transfer* memory (one chunk at a time in flight)
            and lets Go start forwarding the file before it has finished
            reading it from the client's multipart body.
          - We enforce MAX_UPLOAD_BYTES while accumulating, so an
            oversized upload is rejected before pandas ever touches it.
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
                    return pb2.ProcessingSummary(success=False)  # unreachable, keeps linters happy

                buffer.write(chunk.data)

        except grpc.RpcError:
            logger.exception("Client streaming error while receiving '%s'", filename)
            raise

        if received_bytes == 0:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "Received an empty file")
            return pb2.ProcessingSummary(success=False)

        # ---- Resolve format / engine --------------------------------
        try:
            engine = resolve_engine(filename)
        except ValueError as exc:
            logger.warning("Rejecting '%s': %s", filename, exc)
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(exc))
            return pb2.ProcessingSummary(success=False)

        buffer.seek(0)
        logger.info(
            "Received '%s' (%d bytes), parsing with engine=%s",
            filename, received_bytes, engine,
        )

        # ---- Parse workbook + enumerate sheets --------------------------
        try:
            workbook = pd.ExcelFile(buffer, engine=engine)
        except Exception as exc:  # noqa: BLE001 - convert ANY parsing failure
            # into a clean, user-facing gRPC error rather than a stack trace.
            logger.warning("Failed to parse '%s' (engine=%s): %s", filename, engine, exc)
            context.abort(
                grpc.StatusCode.INVALID_ARGUMENT,
                f"Could not parse '{filename}' as a valid workbook: {exc}",
            )
            return pb2.ProcessingSummary(success=False)

        sheet_names = workbook.sheet_names
        if not sheet_names:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "Workbook contains no worksheets")
            return pb2.ProcessingSummary(success=False)

        sheet_summaries: list[pb2.SheetSummary] = []
        for sheet_name in sheet_names:
            try:
                df = workbook.parse(sheet_name)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Failed to parse sheet '%s' in '%s': %s", sheet_name, filename, exc)
                context.abort(
                    grpc.StatusCode.INVALID_ARGUMENT,
                    f"Could not parse worksheet '{sheet_name}': {exc}",
                )
                return pb2.ProcessingSummary(success=False)

            if df.shape[1] == 0:
                # An entirely empty sheet is not an error - just report it
                # as zero rows/columns rather than aborting the whole batch.
                sheet_summaries.append(pb2.SheetSummary(sheet_name=str(sheet_name)))
                continue

            summary = _build_sheet_summary(sheet_name, df)
            sheet_summaries.append(summary)

            # ---- Clean (placeholder step, as specified) -----------------
            # Forward-fill missing values. This mutates the local `df`
            # only; the cleaned frame isn't persisted or returned, but the
            # step demonstrates where a real cleaning/normalization
            # pipeline would hook in (e.g. before writing to a warehouse).
            _ = df.ffill()

        elapsed_ms = (time.perf_counter() - start) * 1000.0

        logger.info(
            "Finished processing '%s': %d sheet(s), %.2fms",
            filename, len(sheet_summaries), elapsed_ms,
        )

        return pb2.ProcessingSummary(
            success=True,
            filename=filename,
            engine_used=engine,
            total_sheets=len(sheet_summaries),
            sheets=sheet_summaries,
            execution_time_ms=elapsed_ms,
            error_message="",
        )


def serve() -> None:
    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=GRPC_MAX_WORKERS),
        options=[
            # These bound the size of any SINGLE gRPC message. Individual
            # Chunk messages are small (~32-64KB); the ProcessingSummary
            # can now be larger than before (multi-sheet, stats, sample
            # rows), so the receive/send limits are set generously.
            ("grpc.max_send_message_length", 64 * 1024 * 1024),
            ("grpc.max_receive_message_length", 64 * 1024 * 1024),
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
    logger.info(
        "DataProcessor gRPC worker listening on %s (max_workers=%d, max_upload=%d bytes, formats=%s)",
        bind_addr, GRPC_MAX_WORKERS, MAX_UPLOAD_BYTES, ", ".join(sorted(ENGINE_BY_EXTENSION)),
    )

    try:
        server.wait_for_termination()
    except KeyboardInterrupt:
        logger.info("Shutting down gracefully...")
        server.stop(grace=5)


if __name__ == "__main__":
    serve()
