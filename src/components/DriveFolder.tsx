"use client";

import { useEffect, useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { setDriveToken, clearDriveToken, findAppFolder } from "@/lib/googleDrive";

const DRIVE_HOME = "https://drive.google.com";

export function useDriveShortcut() {
  const { providerToken, user } = useAuth();

  useEffect(() => {
    if (providerToken) {
      setDriveToken(providerToken);
    }
  }, [providerToken]);

  useEffect(() => {
    if (!user) {
      clearDriveToken();
    }
  }, [user]);

  const openDrive = useCallback(async () => {
    try {
      const folderId = await findAppFolder();
      const url = folderId
        ? `https://drive.google.com/drive/folders/${folderId}`
        : DRIVE_HOME;
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      window.open(DRIVE_HOME, "_blank", "noopener,noreferrer");
    }
  }, []);

  return { visible: !!user, openDrive };
}
