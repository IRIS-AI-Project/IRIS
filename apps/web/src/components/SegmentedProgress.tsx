import { useLayoutEffect, useRef } from "react";
import { animate, isTestEnvironment, prefersReducedMotion } from "../animations/core";
import "./StartupProgress.css";

/** Shared startup material with progress semantics supplied by each operation. */
export function SegmentedProgress({ value, label, detail, max = 100, now, failed = false, complete = value === 1,
  className = "", gradual = false }: {
  value: number | null;
  label: string;
  detail?: string;
  max?: number;
  now?: number;
  failed?: boolean;
  complete?: boolean;
  className?: string;
  gradual?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const previousValue = useRef(0);
  const paintedValue = useRef(0);
  const fraction = failed ? previousValue.current : value === null ? null : Math.max(0, Math.min(1, value));

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const segments = [...root.querySelectorAll<HTMLElement>(".startup-progress-segment")];
    const confirmedTarget = complete && !failed ? 1 : fraction;
    // The initial fill is decorative while there is no confirmed progress.
    const target = confirmedTarget ?? (gradual ? 0.15 : 0);
    previousValue.current = confirmedTarget ?? 0;
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let motion: ReturnType<typeof animate> | undefined;
    const paint = (position: number) => {
      paintedValue.current = position;
      segments.forEach((segment, index) => {
        const portion = Math.max(0, Math.min(1, position * segments.length - index));
        segment.dataset.fill = portion === 0 ? "empty" : portion === 1 ? "full" : "partial";
        segment.style.setProperty("--startup-segment-portion", String(portion));
        segment.querySelector<HTMLElement>(".startup-progress-fill")!.style.width = `${portion * 100}%`;
        segment.querySelector<HTMLElement>(".startup-progress-remainder")!.style.left = `${portion * 100}%`;
      });
    };
    const start = () => {
      motion?.cancel();
      if (prefersReducedMotion() || isTestEnvironment() || failed) { paint(confirmedTarget ?? 0); return; }
      const position = { fraction: paintedValue.current };
      if ((!gradual && fraction === null) || position.fraction === target) { paint(target); return; }
      const duration = gradual && !complete
        ? fraction === null ? 3200 : 300 + 1900 * Math.abs(target - position.fraction)
        : 620;
      motion = animate(position, { fraction: target, duration, ease: gradual ? "outQuad" : "outCubic",
        onUpdate: () => paint(position.fraction), onComplete: () => paint(target) });
    };
    start();
    media?.addEventListener("change", start);
    return () => { motion?.cancel(); media?.removeEventListener("change", start); };
  }, [fraction, failed, complete, gradual]);

  // Percentage ticks must not restart the light sweep.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let motion: ReturnType<typeof animate> | undefined;
    const start = () => {
      motion?.cancel();
      root.style.setProperty("--startup-sweep-progress", "0");
      if (prefersReducedMotion() || isTestEnvironment() || failed || complete) return;
      const sweep = { progress: -0.34 };
      root.style.setProperty("--startup-sweep-progress", String(sweep.progress));
      motion = animate(sweep, { progress: 1.19, duration: 2400, ease: "inOutSine", loop: true,
        onUpdate: () => root.style.setProperty("--startup-sweep-progress", String(sweep.progress)) });
    };
    start();
    media?.addEventListener("change", start);
    return () => { motion?.cancel(); media?.removeEventListener("change", start); };
  }, [failed, complete]);

  return <div ref={rootRef} className={`startup-progress ${className}`.trim()} data-mode={failed ? "failed" : complete ? "complete" : fraction === null ? "indeterminate" : "loading"}
    role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max}
    aria-valuenow={fraction === null || failed ? undefined : complete ? max : now ?? Math.round(fraction * max)}
    aria-valuetext={detail}>
    {[0, 1, 2].map(index => <div key={index} className="startup-progress-segment" aria-hidden="true">
      <div className="startup-progress-remainder"><span className="startup-progress-sweep" /></div>
      <div className="startup-progress-fill"><span className="startup-progress-texture" /><span className="startup-progress-sweep" /></div>
    </div>)}
  </div>;
}
