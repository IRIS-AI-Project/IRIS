import { AlignLeft, CheckCheck, Languages, List, Scissors } from "lucide-react";

export const QUICK_ACTIONS = {
  fix: { label: "Исправить", icon: CheckCheck, instruction: "Исправь орфографию, грамматику, пунктуацию и опечатки." },
  simplify: { label: "Упростить", icon: AlignLeft, instruction: "Упрости формулировки и структуру предложений." },
  translate: { label: "Перевести", icon: Languages, instruction: "" },
  shorten: { label: "Сократить", icon: Scissors, instruction: "Сократи текст, убери повторы и сохрани важные детали." },
  format: { label: "Оформить", icon: List, instruction: "Оформи текст с помощью абзацев, списков и заголовков там, где это уместно." },
};
export type QuickAction = keyof typeof QUICK_ACTIONS;
export const DEFAULT_QUICK_ACTIONS: QuickAction[] = ["fix", "simplify", "translate"];
export const QUICK_ACTION_ORDER = Object.keys(QUICK_ACTIONS) as QuickAction[];

export function quickInstruction(action: QuickAction, text: string) {
  if (action !== "translate") return QUICK_ACTIONS[action].instruction;
  const cyrillic = text.match(/[а-яё]/gi)?.length ?? 0;
  const latin = text.match(/[a-z]/gi)?.length ?? 0;
  return `Переведи текст на ${cyrillic > latin ? "английский" : "русский"} язык.`;
}
