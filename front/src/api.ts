/**
 * Typed client for the ultra-excel Go gateway.
 *
 * Mirrors the JSON shape returned by `go/cmd/gateway/main.go`'s
 * `uploadResponse` struct, which itself mirrors `ProcessingSummary`
 * from excel_processor.proto (now multi-sheet, with numeric stats,
 * duplicate-row counts, and a small data preview per sheet).
 */

export interface ColumnStats {
  min: number;
  max: number;
  mean: number;
  median: number;
  std_dev: number;
  count: number;
}

export interface SheetSummary {
  sheet_name: string;
  total_rows: number;
  total_columns: number;
  columns_names: string[];
  missing_values_count: number;
  data_types: Record<string, string>;
  duplicate_rows_count: number;
  numeric_stats: Record<string, ColumnStats>;
  /** Each entry is one previewed row, already parsed as a plain object. */
  sample_rows: Record<string, unknown>[];
}

export interface ProcessingSummary {
  filename: string;
  engine_used: string;
  total_sheets: number;
  sheets: SheetSummary[];
  execution_time_ms: number;
}

export interface ApiError {
  error: string;
}

export class UploadError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

// In dev, Vite proxies /api -> the Go gateway (see vite.config.ts), so
// same-origin requests avoid CORS entirely. In production, point
// VITE_API_URL at the deployed gateway origin directly.
const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}`
  : "/api";

/** Extensions accepted by both the gateway and the worker - kept here so
 * the drop zone can reject obviously-wrong files before even uploading. */
export const ACCEPTED_EXTENSIONS = [
  ".xlsx",
  ".xlsm",
  ".xltx",
  ".xltm",
  ".xls",
  ".xlt",
  ".xlsb",
];

/**
 * Uploads a file to POST {API_BASE}/upload as multipart/form-data,
 * reporting upload progress via onProgress (0-100). Uses XHR rather than
 * fetch because fetch has no cross-browser upload-progress event.
 *
 * accessToken is the Keycloak-issued access token obtained by the
 * front-end's Authorization Code + PKCE flow (see auth/oidcConfig.ts).
 * The gateway's authMiddleware rejects requests without a valid one.
 */
export function uploadExcelFile(
  file: File,
  accessToken: string,
  onProgress?: (percent: number) => void,
): Promise<ProcessingSummary> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/upload`);
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        reject(new UploadError(xhr.status, "Réponse invalide du serveur"));
        return;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as ProcessingSummary);
      } else {
        const message =
          (body as ApiError)?.error ?? `Échec du traitement (HTTP ${xhr.status})`;
        reject(new UploadError(xhr.status, message));
      }
    };

    xhr.onerror = () => {
      reject(new UploadError(0, "Impossible de joindre le serveur ultra excel"));
    };

    const formData = new FormData();
    formData.append("file", file);
    xhr.send(formData);
  });
}

