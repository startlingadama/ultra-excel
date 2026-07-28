/**
 * Typed client for the ultra-excel Go gateway.
 *
 * Mirrors the JSON shape returned by `go/cmd/gateway/main.go`'s
 * `uploadResponse` struct, which itself mirrors `ProcessingSummary`
 * from excel_processor.proto.
 */

export interface ProcessingSummary {
  total_rows: number;
  total_columns: number;
  columns_names: string[];
  missing_values_count: number;
  data_types: Record<string, string>;
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

/**
 * Uploads a file to POST {API_BASE}/upload as multipart/form-data,
 * reporting upload progress via onProgress (0-100). Uses XHR rather than
 * fetch because fetch has no cross-browser upload-progress event.
 */
export function uploadExcelFile(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<ProcessingSummary> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/upload`);

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
