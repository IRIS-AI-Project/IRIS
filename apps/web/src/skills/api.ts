import { invoke } from "@tauri-apps/api/core";
import { requestJson } from "../api";
import type { QuickAction } from "./quickActions";

export interface EditorAvailability {
  enabled: boolean;
  revision: number;
  model_available: boolean;
  quick_actions?: QuickAction[];
}

export interface SkillsCatalog {
  web_search: boolean;
  reminders: boolean;
  text_editor: EditorAvailability;
}

export interface VoiceEditIntent {
  source: "selection" | "draft" | "clarify";
  instruction: string;
  example: string;
}

export interface EditorSelection {
  id: number;
  text: string;
  application: string;
  replaceable: boolean;
  clipboard?: boolean;
}

export interface EditorUpdates {
  id: number;
  revision: number;
  updates: { selection: EditorSelection | null; voice: VoiceEditIntent | null }[];
}

export const EDITOR_SETTING_EVENT = "text-editor-setting";

export const getSkills = (signal?: AbortSignal) => requestJson<SkillsCatalog>("/skills", { signal });

export const patchEditor = (patch: Partial<Pick<EditorAvailability, "enabled" | "quick_actions">>) =>
  requestJson<EditorAvailability>("/skills/text-editor", {
  method: "PATCH", body: JSON.stringify(patch),
});

export const toggleEditor = (enabled: boolean) => patchEditor({ enabled });

export const openEditor = (revision: number, voice: VoiceEditIntent | null = null) =>
  invoke<number>("open_text_editor", { revision, voice });

export const closeEditor = (id: number | null) => invoke("close_text_editor", { id });

export const editorPresence = (editorId: string, presence: {
  revision: number; has_draft: boolean; pending_source: boolean;
} | null, signal?: AbortSignal) => requestJson(`/skills/text-editor/presence/${editorId}`, {
  method: presence ? "PUT" : "DELETE",
  body: presence ? JSON.stringify(presence) : undefined,
  signal,
});

export const generateEdit = (payload: {
  revision: number; text: string; instruction: string; example: string;
}, signal: AbortSignal) => requestJson<{ text: string }>("/skills/text-editor/edit", {
  method: "POST", signal, body: JSON.stringify({ ...payload, cloud_consent: true }),
});
