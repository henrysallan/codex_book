import type { Session } from "@supabase/supabase-js";
import { makeRedirectUri } from "expo-auth-session";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { supabase } from "./supabase";

WebBrowser.maybeCompleteAuthSession();

/**
 * Must be listed under Supabase → Authentication → URL Configuration →
 * Redirect URLs, or Supabase falls back to the web app's Site URL.
 */
export const AUTH_REDIRECT = makeRedirectUri({
  scheme: "cortex",
  path: "auth-callback",
});

type AuthState = { session: Session | null; loading: boolean };

const AuthContext = createContext<AuthState>({ session: null, loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    session: null,
    loading: true,
  });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setState({ session: data.session, loading: false });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ session, loading: false });
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

/**
 * Google OAuth through Supabase, in an in-app auth session. PKCE: Supabase
 * redirects back with `?code=`, exchanged here for a session. No Drive scope —
 * the app has no Drive features, and the web client owns `user_google_tokens`.
 */
export async function signInWithGoogle(): Promise<void> {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: AUTH_REDIRECT, skipBrowserRedirect: true },
  });
  if (error) throw error;

  const result = await WebBrowser.openAuthSessionAsync(data.url, AUTH_REDIRECT);
  if (result.type !== "success") return;

  const { queryParams } = Linking.parse(result.url);
  const code = typeof queryParams?.code === "string" ? queryParams.code : null;
  if (!code) {
    const message =
      queryParams?.error_description ??
      queryParams?.error ??
      "No auth code returned";
    throw new Error(String(message));
  }
  const { error: exchangeError } =
    await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) throw exchangeError;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}
