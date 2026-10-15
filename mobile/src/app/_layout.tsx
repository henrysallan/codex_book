import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";

import { AuthProvider, useAuth } from "@/lib/auth";
import { useAppStore } from "@/lib/store";
import { useScheme } from "@/lib/theme";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const scheme = useScheme();
  return (
    <AuthProvider>
      <ThemeProvider value={scheme === "dark" ? DarkTheme : DefaultTheme}>
        <Gate />
      </ThemeProvider>
    </AuthProvider>
  );
}

function Gate() {
  const { session, loading } = useAuth();
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (!loading) SplashScreen.hideAsync();
  }, [loading]);

  // Per-account state: restore on sign-in, clear on sign-out.
  useEffect(() => {
    if (loading) return;
    if (userId) void useAppStore.getState().hydrate();
    else useAppStore.getState().reset();
  }, [userId, loading]);

  if (loading) return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!!session}>
        <Stack.Screen name="(tabs)" />
      </Stack.Protected>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected guard={__DEV__}>
        <Stack.Screen
          name="playground"
          options={{ headerShown: true, title: "Editor Playground" }}
        />
      </Stack.Protected>
    </Stack>
  );
}
