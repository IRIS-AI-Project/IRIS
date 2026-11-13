import type { SkillsCatalog } from "./api";

/** Decorative spot illustrations. A card can supply its own image instead. */
export function SkillArtwork({ id }: { id: keyof SkillsCatalog }) {
  if (id === "reminders") {
    return (
      <svg viewBox="0 0 112 112" fill="none" focusable="false">
        <rect x="13" y="13" width="86" height="86" rx="27" fill="var(--skill-art-back)" />
        <path d="M56 32a17 17 0 0 0-17 17v6c0 5-2 8-6 12a3 3 0 0 0 2 5h42a3 3 0 0 0 2-5c-4-4-6-7-6-12v-6a17 17 0 0 0-17-17Z" fill="var(--skill-art-accent)" />
        <path d="M49 77a7 7 0 0 0 14 0Z" fill="var(--skill-art-accent)" />
        <path d="M34 34a27 27 0 0 0-6 15m50-15a27 27 0 0 1 6 15" stroke="var(--skill-art-face)" strokeWidth="4" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 168 112" fill="none" focusable="false">
      {id === "web_search" ? <>
        <rect x="15" y="15" width="112" height="76" rx="19" fill="var(--skill-art-back)" />
        <rect x="29" y="29" width="61" height="10" rx="5" fill="var(--skill-art-face)" />
        <path d="M32 54h43M32 68h29" stroke="var(--skill-art-face)" strokeWidth="4" strokeLinecap="round" />
        <circle cx="114" cy="65" r="22" fill="var(--skill-art-back)" stroke="var(--skill-art-accent)" strokeWidth="8" />
        <path d="m130 81 17 17" stroke="var(--skill-art-accent)" strokeWidth="9" strokeLinecap="round" />
      </> : <>
        <rect x="36" y="12" width="89" height="88" rx="16" fill="var(--skill-art-back)" />
        <path d="M54 34h51M54 49h42M54 64h29" stroke="var(--skill-art-face)" strokeWidth="5" strokeLinecap="round" />
        <path d="m102 83 34-34a4 4 0 0 1 6 0l9 9a4 4 0 0 1 0 6l-34 34-20 5Z" fill="var(--skill-art-accent)" />
        <path d="m102 83 15 15-20 5Z" fill="var(--skill-art-tip)" />
        <path d="m131 54 15 15" stroke="var(--skill-art-back)" strokeWidth="3" />
      </>}
    </svg>
  );
}
