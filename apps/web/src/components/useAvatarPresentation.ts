import { useEffect } from "react";
import { requestJson } from "../api";
import { isDesktopApp } from "../desktop";

let lastPresentationRevision = 0;

/** Keep the native conversation avatar in portrait framing, including after a renderer restart. */
export function useAvatarPresentation(enabled: boolean, rendererPhase?: string) {
  useEffect(() => {
    if (!enabled || !isDesktopApp()) return;
    lastPresentationRevision = Math.max(lastPresentationRevision + 1, Date.now() * 1000);
    void requestJson("/avatar/presentation", {
      method: "POST",
      body: JSON.stringify({ mode: "portrait", revision: lastPresentationRevision }),
    }).catch(error => console.warn("Avatar presentation could not be updated", error));
  }, [enabled, rendererPhase]);
}
