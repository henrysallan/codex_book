import { Link } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { signInWithGoogle } from "@/lib/auth";
import { usePalette } from "@/lib/theme";

export default function SignInScreen() {
  const palette = usePalette();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView
      style={[styles.fill, { backgroundColor: palette.background }]}
    >
      <View style={styles.center}>
        <Text style={[styles.title, { color: palette.text }]}>Cortex</Text>
        <Text style={[styles.subtitle, { color: palette.muted }]}>
          Your notes, on your phone.
        </Text>
      </View>
      <View style={styles.footer}>
        {error && <Text style={styles.error}>{error}</Text>}
        <Pressable
          onPress={onSignIn}
          disabled={busy}
          style={({ pressed }) => [
            styles.button,
            {
              backgroundColor: palette.text,
              opacity: pressed || busy ? 0.7 : 1,
            },
          ]}
        >
          {busy ? (
            <ActivityIndicator color={palette.background} />
          ) : (
            <Text style={[styles.buttonText, { color: palette.background }]}>
              Continue with Google
            </Text>
          )}
        </Pressable>
        {__DEV__ && (
          <Link
            href="/playground"
            style={[styles.devLink, { color: palette.muted }]}
          >
            Editor playground (dev)
          </Link>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 },
  title: { fontSize: 40, fontWeight: "700", letterSpacing: -0.5 },
  subtitle: { fontSize: 17 },
  footer: { paddingHorizontal: 24, paddingBottom: 16, gap: 14 },
  button: {
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontSize: 17, fontWeight: "600" },
  error: { color: "#ff453a", textAlign: "center" },
  devLink: { textAlign: "center", fontSize: 15, padding: 6 },
});
