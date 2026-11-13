import { useEffect, useRef, type ReactNode } from "react";
import { animate, prefersReducedMotion } from "../animations/core";
import { ButtonMaterialLayers } from "../components/MaterialButton";
import { buttonSeed, materialStyle } from "../components/buttonMaterial";
import { useMaterialFeedback } from "../components/useMaterialFeedback";

export function InstallerFeatureCard({ materialKey, image, width, height, title, children }: {
  materialKey: string;
  image: string;
  width: number;
  height: number;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const accentRef = useRef<HTMLSpanElement>(null);
  const seed = buttonSeed(materialKey);
  useMaterialFeedback(ref, { seed, pressScale: false });

  useEffect(() => {
    const card = ref.current;
    const accent = accentRef.current;
    if (!card || !accent) return;
    let animation: ReturnType<typeof animate> | undefined;
    const change = (opacity: number) => {
      animation?.cancel();
      if (prefersReducedMotion()) accent.style.opacity = String(opacity);
      else animation = animate(accent, { opacity, duration: 220, ease: "outCubic" });
    };
    const enter = (event: PointerEvent) => { if (event.pointerType !== "touch") change(1); };
    const leave = () => change(0);
    card.addEventListener("pointerenter", enter);
    card.addEventListener("pointerleave", leave);
    card.addEventListener("pointercancel", leave);
    if (card.matches(":hover")) change(1);
    return () => {
      animation?.cancel();
      card.removeEventListener("pointerenter", enter);
      card.removeEventListener("pointerleave", leave);
      card.removeEventListener("pointercancel", leave);
    };
  }, []);

  return <div ref={ref} className="installer-feature-chip dp-lens dp-graphite" style={materialStyle(seed, 0.35)} role="listitem">
    <span className="installer-feature-face dp-hover-surface" aria-hidden="true">
      <span className="dp-hover-light installer-feature-light"><span className="dp-hover-spot" /></span>
      <ButtonMaterialLayers />
      <span ref={accentRef} className="installer-feature-accent dp-lens dp-accent"><ButtonMaterialLayers /></span>
    </span>
    <img className="installer-feature-art" src={image} alt="" width={width} height={height} draggable={false} />
    <div className="installer-chip-text"><strong>{title}</strong><span>{children}</span></div>
  </div>;
}
