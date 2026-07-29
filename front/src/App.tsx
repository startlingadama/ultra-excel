import { useCallback, useState } from "react";
import { Button, Callout, Progress, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon, LockClosedIcon } from "@radix-ui/react-icons";
import { useAuth } from "react-oidc-context";
import { UploadZone } from "./components/UploadZone";
import { SummaryView } from "./components/SummaryView";
import { ACCEPTED_EXTENSIONS, ProcessingSummary, uploadExcelFile, UploadError } from "./api";

type Status = "idle" | "uploading" | "success" | "error";

function Wordmark() {
  return (
    <div className="ue-wordmark">
      <div className="ue-wordmark__mark" aria-hidden="true" />
      <div className="ue-wordmark__text">
        ultra<b>excel</b>
      </div>
    </div>
  );
}

/** Shown while react-oidc-context is checking for / renewing a session. */
function AuthLoadingScreen() {
  return (
    <div className="ue-shell">
      <Wordmark />
      <Text as="p" size="2" color="gray">
        Vérification de la session…
      </Text>
    </div>
  );
}

/** Shown when no valid session exists yet - the entry point into the
 * Authorization Code + PKCE (S256) flow against Keycloak. Clicking the
 * button redirects the whole page to Keycloak's login form; after the
 * user authenticates there, Keycloak redirects back here with an
 * authorization code, which react-oidc-context exchanges for tokens
 * automatically (see auth/oidcConfig.ts for the exact PKCE mechanics). */
function SignInScreen({ onSignIn, error }: { onSignIn: () => void; error?: string }) {
  return (
    <div className="ue-shell">
      <Wordmark />
      <main className="ue-main" style={{ textAlign: "center" }}>
        <LockClosedIcon width={28} height={28} style={{ marginBottom: 12, color: "var(--accent-9)" }} />
        <Text as="p" size="2" color="gray" style={{ marginBottom: 20 }}>
          Connecte-toi pour déposer et analyser un classeur.
        </Text>
        <Button size="3" color="teal" onClick={onSignIn}>
          Se connecter
        </Button>

        {error && (
          <Callout.Root color="red" variant="surface" style={{ marginTop: 20, textAlign: "left" }}>
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
      </main>
    </div>
  );
}

export default function App() {
  const auth = useAuth();

  const [status, setStatus] = useState<Status>("idle");
  const [fileName, setFileName] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<ProcessingSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleFileSelected = useCallback(
    async (file: File) => {
      setFileName(file.name);
      setSummary(null);
      setErrorMessage(null);
      setProgress(0);

      const lowerName = file.name.toLowerCase();
      const isAccepted = ACCEPTED_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
      if (!isAccepted) {
        setStatus("error");
        setErrorMessage(`Format non supporté. Formats acceptés : ${ACCEPTED_EXTENSIONS.join(", ")}`);
        return;
      }

      const accessToken = auth.user?.access_token;
      if (!accessToken) {
        setStatus("error");
        setErrorMessage("Session expirée - merci de te reconnecter.");
        return;
      }

      setStatus("uploading");
      try {
        const result = await uploadExcelFile(file, accessToken, setProgress);
        setSummary(result);
        setStatus("success");
      } catch (err) {
        const message =
          err instanceof UploadError ? err.message : "Une erreur inattendue est survenue.";
        setErrorMessage(message);
        setStatus("error");
      }
    },
    [auth.user],
  );

  if (auth.isLoading) {
    return <AuthLoadingScreen />;
  }

  if (!auth.isAuthenticated) {
    return (
      <SignInScreen
        onSignIn={() => auth.signinRedirect()}
        error={auth.error?.message}
      />
    );
  }

  return (
    <div className="ue-shell">
      <Wordmark />

      <div style={{ position: "absolute", top: 24, right: 24 }}>
        <Text size="1" color="gray" className="ue-mono" style={{ marginRight: 10 }}>
          {auth.user?.profile.preferred_username}
        </Text>
        <Button size="1" variant="soft" color="gray" onClick={() => auth.signoutRedirect()}>
          Se déconnecter
        </Button>
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
              Envoi et analyse en cours - {progress}%
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
