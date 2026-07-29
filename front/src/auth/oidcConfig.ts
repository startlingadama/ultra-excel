import type { AuthProviderProps } from "react-oidc-context";
import { WebStorageStateStore } from "oidc-client-ts";

/**
 * OIDC configuration for react-oidc-context (which wraps oidc-client-ts).
 *
 * response_type: "code" on a public client with no client_secret makes
 * oidc-client-ts use the Authorization Code flow WITH PKCE automatically
 * - it generates a code_verifier, derives the code_challenge with S256,
 * sends code_challenge_method=S256 in the authorize request, and later
 * presents the original code_verifier on the token exchange. There is no
 * separate "enable PKCE" flag to set here; it's implied by this client
 * configuration matching the Keycloak client (public, standard flow,
 * pkce.code.challenge.method=S256 - see infra/keycloak/realm-export.json).
 */
export const oidcConfig: AuthProviderProps = {
  authority: import.meta.env.VITE_OIDC_AUTHORITY || "http://localhost:8081/realms/ultra-excel",
  client_id: import.meta.env.VITE_OIDC_CLIENT_ID || "ultra-excel-front",
  redirect_uri: import.meta.env.VITE_OIDC_REDIRECT_URI || window.location.origin,
  post_logout_redirect_uri: import.meta.env.VITE_OIDC_REDIRECT_URI || window.location.origin,
  response_type: "code",
  scope: "openid profile email",

  // Keep tokens in sessionStorage rather than the (default) localStorage:
  // scoped to the tab, cleared when it closes, smaller blast radius if
  // an XSS bug ever leaks storage contents.
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),

  // After Keycloak redirects back with ?code=...&state=..., oidc-client-ts
  // exchanges the code (+ code_verifier) for tokens, then this callback
  // strips the query string so the URL is clean and a page refresh
  // doesn't try to replay a used authorization code.
  onSigninCallback: () => {
    window.history.replaceState({}, document.title, window.location.pathname);
  },

  automaticSilentRenew: true,
};
