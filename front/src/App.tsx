import { useCallback, useState } from "react";
import { Callout, Progress, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { UploadZone } from "./components/UploadZone";
import { SummaryView } from "./components/SummaryView";
import { ProcessingSummary, uploadExcelFile, UploadError } from "./api";

type Status = "idle" | "uploading" | "success" | "error";

export default function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [fileName, setFileName] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<ProcessingSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleFileSelected = useCallback(async (file: File) => {
    setFileName(file.name);
    setSummary(null);
    setErrorMessage(null);
    setProgress(0);

    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setStatus("error");
      setErrorMessage("Seuls les fichiers .xlsx sont acceptés.");
      return;
    }

    setStatus("uploading");
    try {
      const result = await uploadExcelFile(file, setProgress);
      setSummary(result);
      setStatus("success");
    } catch (err) {
      const message =
        err instanceof UploadError ? err.message : "Une erreur inattendue est survenue.";
      setErrorMessage(message);
      setStatus("error");
    }
  }, []);

  return (
    <div className="ue-shell">
      <div className="ue-wordmark">
        <div className="ue-wordmark__mark" aria-hidden="true" />
        <div className="ue-wordmark__text">
          ultra<b>excel</b>
        </div>
      </div>

      <main className="ue-main">
        <UploadZone
          selectedFileName={fileName}
          filled={status === "success"}
          disabled={status === "uploading"}
          onFileSelected={handleFileSelected}
        />

        {status === "uploading" && (
          <div style={{ marginTop: 18 }}>
            <Progress value={progress} color="teal" />
            <Text as="p" size="1" color="gray" style={{ marginTop: 6 }}>
              Envoi et analyse en cours — {progress}%
            </Text>
          </div>
        )}

        {status === "error" && errorMessage && (
          <Callout.Root color="red" variant="surface" style={{ marginTop: 18 }}>
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>{errorMessage}</Callout.Text>
          </Callout.Root>
        )}

        {status === "success" && summary && <SummaryView summary={summary} />}
      </main>
    </div>
  );
}
