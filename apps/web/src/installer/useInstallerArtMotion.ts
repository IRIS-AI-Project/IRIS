import { useLayoutEffect, type RefObject } from "react";
import { createTimer, type Timer } from "animejs";
import { animate, prefersReducedMotion, type Animation } from "../animations/core";

type ArtRefs = {
  stage: RefObject<HTMLElement | null>;
  foreground: RefObject<HTMLDivElement | null>;
  image: RefObject<HTMLImageElement | null>;
  backdrop: RefObject<HTMLImageElement | null>;
};
type Axis = { position: number; velocity: number };

/** Exact critically damped spring: retargeting preserves velocity at any frame rate. */
export function advanceArtAxis(axis: Axis, target: number, frequency: number, seconds: number) {
  const offset = axis.position - target;
  const momentum = axis.velocity + frequency * offset;
  const decay = Math.exp(-frequency * seconds);
  axis.position = target + (offset + momentum * seconds) * decay;
  axis.velocity = (axis.velocity - frequency * momentum * seconds) * decay;
}

/** One Anime.js clock and one transform per layer, including its ambient drift. */
export function useInstallerArtMotion({ stage, foreground, image, backdrop }: ArtRefs, visualKey: string) {
  useLayoutEffect(() => {
    const host = stage.current, face = foreground.current;
    const picture = image.current, poster = backdrop.current;
    if (!host) return;

    let disposed = false, ready = false, suspended = false;
    let bounds: DOMRect | null = null;
    let targetX = 0, targetY = 0, elapsed = 0;
    let clock: Timer | null = null;
    let entrances: Animation[] = [];
    const faceX: Axis = { position: 0, velocity: 0 }, faceY: Axis = { position: 0, velocity: 0 };
    const backX: Axis = { position: 0, velocity: 0 }, backY: Axis = { position: 0, velocity: 0 };
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const clearStyles = () => {
      for (const element of [face, picture, poster]) {
        element?.style.removeProperty("transform");
        element?.style.removeProperty("opacity");
      }
    };
    const reset = () => { targetX = targetY = 0; bounds = null; };
    const configure = () => {
      clock?.cancel();
      clock = null;
      if (disposed || !ready) return;
      if (prefersReducedMotion()) {
        entrances.forEach(animation => animation.cancel());
        entrances = [];
        clearStyles();
        for (const axis of [faceX, faceY, backX, backY]) axis.position = axis.velocity = 0;
        return;
      }
      clock = createTimer({ duration: Infinity, autoplay: false, onUpdate: timer => {
        const dt = Math.min(Math.max(timer.deltaTime / 1000, 0), .04);
        elapsed += dt;
        advanceArtAxis(faceX, targetX * 7, 11, dt);
        advanceArtAxis(faceY, targetY * 5, 11, dt);
        advanceArtAxis(backX, -targetX * 2.2, 7, dt);
        advanceArtAxis(backY, -targetY * 1.8, 7, dt);
        // Continuous, asymmetric idle motion, without a loop seam or a second raster transform.
        const driftX = Math.sin(elapsed * .46) * .65;
        const driftY = Math.sin(elapsed * .7) * .9 + Math.sin(elapsed * .31) * .35;
        if (face) face.style.transform = `translate3d(${faceX.position + driftX}px, ${faceY.position + driftY}px, 0)`;
        if (poster) poster.style.transform = `translate3d(${backX.position}px, ${backY.position}px, 0)`;
      } });
      if (!document.hidden && !suspended) clock.resume();
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch" || prefersReducedMotion() || document.hidden || suspended) return;
      if (event.target instanceof Element && event.target.closest("button, [data-tauri-drag-region]")) {
        reset();
        return;
      }
      bounds ??= host.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      targetX = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / bounds.width * 2 - 1));
      targetY = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / bounds.height * 2 - 1));
    };
    const resize = () => { bounds = null; };
    const visibility = () => {
      reset();
      if (document.hidden || suspended) clock?.pause();
      else clock?.resume();
    };
    const blur = () => { suspended = true; reset(); clock?.pause(); };
    const focus = () => { suspended = false; visibility(); };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerleave", reset);
    host.addEventListener("pointercancel", reset);
    window.addEventListener("resize", resize);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    media?.addEventListener("change", configure);

    if (prefersReducedMotion()) ready = true;
    else {
      for (const element of [face, poster]) if (element) element.style.opacity = "0";
      void Promise.all([picture, poster].map(element => element?.decode?.().catch(() => {}))).then(() => {
        if (disposed) return;
        ready = true;
        clearStyles();
        if (!prefersReducedMotion()) for (const element of [face, poster]) {
          if (element) entrances.push(animate(element, {
            opacity: [0, Number(getComputedStyle(element).opacity)], duration: 420, ease: "outCubic",
          }));
        }
        configure();
      });
    }

    return () => {
      disposed = true;
      clock?.cancel();
      entrances.forEach(animation => animation.cancel());
      clearStyles();
      observer.disconnect();
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", reset);
      host.removeEventListener("pointercancel", reset);
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
      media?.removeEventListener("change", configure);
    };
  }, [stage, foreground, image, backdrop, visualKey]);
}
