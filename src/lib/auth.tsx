"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "./supabase";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  providerToken: string | null;
  isLoading: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  providerToken: null,
  isLoading: true,
  signInWithGoogle: async () => {},
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(() => isSupabaseConfigured());

  useEffect(() => {
    if (!isSupabaseConfigured() || !supabase) {
      return;
    }

    // Get the current session on mount
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setUser(s?.user ?? null);
      setIsLoading(false);
    });

    // Listen for auth state changes (sign in, sign out, token refresh)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      setUser(s?.user ?? null);
      setIsLoading(false);

      if (event === "TOKEN_REFRESHED") return;

      // Persist Google refresh token server-side — the table is not
      // client-writable (service role only).
      if (s?.provider_refresh_token && s.access_token) {
        fetch("/api/google/store-token", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${s.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ refresh_token: s.provider_refresh_token }),
        }).catch((err: unknown) => {
          console.warn(
            "Could not persist Google refresh token:",
            err instanceof Error ? err.message : err
          );
        });
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const signInWithGoogle = useCallback(async () => {
    if (!supabase) return;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/`,
        // Both scopes are requested here so one consent covers the web Drive
        // browser and trac3's Google Calendar writes. Google only grants new
        // scopes on fresh consent, so adding one requires signing out and back in.
        scopes: [
          "https://www.googleapis.com/auth/drive.readonly",
          "https://www.googleapis.com/auth/calendar.events",
        ].join(" "),
        queryParams: { access_type: "offline", prompt: "consent" },
      },
    });
    if (error) console.error("Google sign-in error:", error.message);
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) console.error("Sign-out error:", error.message);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, session, providerToken: session?.provider_token ?? null, isLoading, signInWithGoogle, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
