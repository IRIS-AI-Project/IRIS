use crate::{desktop_avatar, desktop_data_root, DesktopState};
use serde::{Deserialize, Serialize};
use std::sync::{atomic::{AtomicU64, Ordering}, Mutex};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const LABEL: &str = "text_editor";
const AVATAR: &str = "desktop_avatar";
const CLOSED: &str = "Сессия редактора закрыта.";
const CHANGED: &str = "Не удалось подтвердить исходное поле и выделение. Скопируйте черновик вручную.";

#[derive(Default)]
pub struct EditorState {
    session: Mutex<Session>,
    opening: Mutex<()>,
    focus_epoch: AtomicU64,
}

#[derive(Default)]
struct Session {
    id: u64,
    revision: Option<u64>,
    host: Option<&'static str>,
    updates: Vec<Update>,
    selection_id: u64,
    #[cfg(windows)]
    target: Option<(u64, selection::Target)>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Selection,
    Draft,
    Clarify,
}

#[derive(Deserialize, Serialize)]
pub struct VoiceIntent {
    source: Source,
    instruction: String,
    example: String,
}

#[derive(Default, Serialize)]
pub struct Selection {
    id: u64,
    text: String,
    application: String,
    replaceable: bool,
    clipboard: bool,
}

#[derive(Serialize)]
struct Update {
    selection: Option<Selection>,
    voice: Option<VoiceIntent>,
}

#[derive(Serialize)]
pub struct Updates {
    id: u64,
    revision: u64,
    updates: Vec<Update>,
}

fn enabled(app: &AppHandle, revision: u64) -> bool {
    let desktop = app.state::<DesktopState>();
    let path = desktop_data_root(&desktop.root).join("settings.json");
    std::fs::read(path).ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .is_some_and(|value| {
            value["schema_version"].as_u64() == Some(1)
                && value["settings"]["text_editor_enabled"].as_bool() == Some(true)
                && value["settings"]["text_editor_revision"].as_u64() == Some(revision)
        })
}

pub fn remember_avatar_source(_host: &WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        // The avatar is created by the background player launcher. Windows
        // subclass helpers must run on the thread owning the native window.
        let watched = _host.clone();
        _host.app_handle().run_on_main_thread(move || {
            if let Err(error) = selection::watch_avatar(&watched) {
                eprintln!("Cannot watch editor source window: {error}");
            }
        }).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn poll_avatar_source(app: &AppHandle) {
    #[cfg(windows)]
    if let Some(host) = app.get_webview_window(AVATAR) { selection::poll_source(&host); }
}

pub fn window_event(window: &tauri::Window, event: &WindowEvent) {
    match event {
        WindowEvent::Focused(false) => {
            window.state::<EditorState>().focus_epoch.fetch_add(1, Ordering::SeqCst);
        }
        WindowEvent::CloseRequested { api, .. } if window.label() == LABEL => {
            api.prevent_close();
            let _ = window.emit("text-editor-close-requested", ());
        }
        _ => {}
    }
}

#[tauri::command]
pub async fn open_text_editor(
    app: AppHandle, window: WebviewWindow, revision: u64, voice: Option<VoiceIntent>,
) -> Result<u64, String> {
    let from_avatar = window.label() == AVATAR && voice.is_none();
    let from_voice = window.label() == "main" && voice.is_some();
    if !(from_avatar || from_voice) {
        return Err(CLOSED.into());
    }
    if voice.as_ref().is_some_and(|v| v.instruction.len() > 12000 || v.example.len() > 12000) {
        return Err("Указание для редактора слишком длинное.".into());
    }
    #[cfg(windows)]
    let focus = selection::source(&window, from_avatar);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<EditorState>();
        let _opening = state.opening.lock().map_err(|_| CLOSED)?;
        if !enabled(&app, revision) {
            return Err(CLOSED.into());
        }
        let host = if from_avatar || desktop_avatar::visible_geometry(&app).is_some() { AVATAR } else { LABEL };
        let existing = app.get_webview_window(host);
        let (id, is_new, previous_host) = {
            let mut session = state.session.lock().map_err(|_| CLOSED)?;
            let previous_host = session.host;
            let is_new = from_avatar || existing.is_none() || previous_host != Some(host) || session.revision != Some(revision);
            if is_new {
                *session = Session {
                    id: session.id.wrapping_add(1), revision: Some(revision), host: Some(host), ..Session::default()
                };
            }
            (session.id, is_new, previous_host)
        };
        if previous_host == Some(LABEL) && host == AVATAR {
            if let Some(editor) = app.get_webview_window(LABEL) {
                let _ = editor.destroy();
            }
        } else if previous_host == Some(AVATAR) && host == LABEL {
            let _ = app.emit_to(AVATAR, "text-editor-close-requested", ());
        }
        let capture = match &voice {
            Some(intent) => matches!(intent.source, Source::Selection),
            None => is_new,
        };
        let update = if capture {
            let selection = record_selection(&state, #[cfg(windows)] focus, from_avatar)?;
            Update { selection: Some(selection), voice }
        } else {
            Update { selection: None, voice }
        };
        if !enabled(&app, revision) {
            return Err(CLOSED.into());
        }
        if is_new || update.voice.is_some() {
            let mut session = state.session.lock().map_err(|_| CLOSED)?;
            if session.updates.len() >= 8 {
                session.updates.remove(0);
            }
            session.updates.push(update);
        }
        if host == AVATAR {
            let avatar = existing.ok_or(CLOSED)?;
            if from_voice {
                let _ = avatar.set_focus();
                let _ = app.emit_to(AVATAR, "text-editor-reveal", id);
            }
            let _ = app.emit_to(AVATAR, "text-editor-update", ());
            return Ok(id);
        }
        let editor = match existing {
            Some(editor) => editor,
            None => build_window(&app)?,
        };
        if is_new {
            place_window(&app, &editor);
        }
        editor.show().map_err(|err| err.to_string())?;
        let _ = editor.set_focus();
        let _ = app.emit_to(LABEL, "text-editor-update", ());
        Ok(id)
    }).await.map_err(|_| CLOSED)?
}

fn build_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let bootstrap = format!(
        "window.__NEUROASIST_DESKTOP_CONFIG__ = {}; window.__IRIS_VIEW__ = 'text-editor';",
        serde_json::to_string(&app.state::<DesktopState>().runtime()).map_err(|_| CLOSED)?,
    );
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Редактор текста · Iris")
        .inner_size(380.0, 448.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .initialization_script(bootstrap)
        .build()
        .map_err(|err| err.to_string())?;
    remember_avatar_source(&window)?;
    Ok(window)
}

fn place_window(app: &AppHandle, window: &WebviewWindow) {
    let anchor = desktop_avatar::visible_geometry(app);
    let cursor = app.cursor_position().ok();
    let monitor = anchor.as_ref().map(|g| g.monitor.clone()).or_else(|| {
        let monitors = desktop_avatar::monitors(app).ok()?;
        monitors.iter().find(|m| cursor.is_some_and(|p| {
            p.x >= m.area.x && p.x < m.area.x + m.area.width &&
            p.y >= m.area.y && p.y < m.area.y + m.area.height
        })).or_else(|| monitors.iter().find(|m| m.primary)).cloned()
    });
    let Some(monitor) = monitor else { return };
    let area = monitor.area;
    let margin = 12.0 * monitor.scale;
    let width = (380.0 * monitor.scale).min((area.width - 2.0 * margin).max(1.0));
    let height = (448.0 * monitor.scale).min((area.height - 2.0 * margin).max(1.0));
    let (x, y) = anchor.map_or((area.x + area.width - width - margin, area.y + margin), |g| {
        let right = g.rect.x + g.rect.width + margin;
        let left = g.rect.x - width - margin;
        let x = if right + width <= area.x + area.width - margin || left < area.x + margin { right } else { left };
        (x, g.rect.y + g.rect.height - height)
    });
    let _ = window.set_position(PhysicalPosition::new(
        x.max(area.x + margin).min(area.x + area.width - width - margin).round() as i32,
        y.max(area.y + margin).min(area.y + area.height - height - margin).round() as i32,
    ));
    let _ = window.set_size(PhysicalSize::new(width.round() as u32, height.round() as u32));
}

#[tauri::command]
pub fn take_text_editor_updates(app: AppHandle, window: WebviewWindow, id: Option<u64>) -> Result<Updates, String> {
    let state = app.state::<EditorState>();
    let mut session = state.session.lock().map_err(|_| CLOSED)?;
    if session.host != Some(window.label()) || id.is_some_and(|id| id != session.id) {
        return Err(CLOSED.into());
    }
    let revision = session.revision.filter(|rev| enabled(&app, *rev)).ok_or(CLOSED)?;
    Ok(Updates { id: session.id, revision, updates: std::mem::take(&mut session.updates) })
}

#[tauri::command]
pub async fn capture_editor_selection(app: AppHandle, window: WebviewWindow, id: u64) -> Result<Selection, String> {
    #[cfg(windows)]
    let focus = selection::source(&window, true);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<EditorState>();
        let _opening = state.opening.lock().map_err(|_| CLOSED)?;
        {
            let session = state.session.lock().map_err(|_| CLOSED)?;
            if session.host != Some(window.label()) || id != session.id
                || !session.revision.is_some_and(|rev| enabled(&app, rev)) {
                return Err(CLOSED.into());
            }
        }
        record_selection(&state, #[cfg(windows)] focus, true)
    }).await.map_err(|_| CLOSED)?
}

fn record_selection(state: &EditorState, #[cfg(windows)] focus: Option<selection::Focus>, _clipboard_fallback: bool) -> Result<Selection, String> {
    #[cfg(windows)]
    let epoch = state.focus_epoch.load(Ordering::SeqCst);
    #[cfg(windows)]
    let (mut selection, target) = focus.and_then(selection::capture).unwrap_or_default();
    #[cfg(windows)]
    if selection.text.is_empty() && _clipboard_fallback {
        if let Some(text) = selection::clipboard_text() {
            selection = Selection { text, clipboard: true, ..Selection::default() };
        }
    }
    #[cfg(not(windows))]
    let mut selection = Selection::default();
    let mut session = state.session.lock().map_err(|_| CLOSED)?;
    session.selection_id = session.selection_id.wrapping_add(1);
    selection.id = session.selection_id;
    #[cfg(windows)]
    {
        session.target = target.map(|target| (epoch, target));
    }
    Ok(selection)
}

#[tauri::command]
pub async fn replace_editor_selection(app: AppHandle, window: WebviewWindow, id: u64, selection_id: u64, text: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|_| CHANGED)?.0 as usize;
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<EditorState>();
            let mut session = state.session.lock().map_err(|_| CLOSED)?;
            if session.host != Some(window.label()) || id != session.id || selection_id != session.selection_id
                || !session.revision.is_some_and(|rev| enabled(&app, rev)) {
                return Err(CLOSED.into());
            }
            let (epoch, target) = session.target.take().ok_or(CHANGED)?;
            selection::replace(target, &text, || {
                state.focus_epoch.load(Ordering::SeqCst) == epoch && selection::is_foreground(hwnd)
                    && session.revision.is_some_and(|rev| enabled(&app, rev))
            })
        }).await.map_err(|_| CHANGED)?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, window, id, selection_id, text);
        Err(CHANGED.into())
    }
}

#[tauri::command]
pub async fn close_text_editor(app: AppHandle, window: WebviewWindow, id: Option<u64>) -> Result<(), String> {
    if !matches!(window.label(), "main" | LABEL | AVATAR) {
        return Err(CLOSED.into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<EditorState>();
        let _opening = state.opening.lock().map_err(|_| CLOSED)?;
        let mut session = state.session.lock().map_err(|_| CLOSED)?;
        if id.is_some_and(|id| id != session.id)
            || (window.label() != "main" && session.host != Some(window.label())) {
            return Ok(());
        }
        let host = session.host;
        if host == Some(LABEL) {
            // Hiding keeps the WebView's draft and editing options for reopening.
            #[cfg(windows)]
            { session.target = None; }
            drop(session);
            if let Some(editor) = app.get_webview_window(LABEL) {
                editor.hide().map_err(|err| err.to_string())?;
            }
            return Ok(());
        }
        *session = Session { id: session.id, ..Session::default() };
        drop(session);
        if host == Some(LABEL) {
            if let Some(editor) = app.get_webview_window(LABEL) {
                editor.destroy().map_err(|err| err.to_string())?;
            }
        } else if host == Some(AVATAR) && window.label() == "main" {
            let _ = app.emit_to(AVATAR, "text-editor-close-requested", ());
        }
        Ok(())
    }).await.map_err(|_| CLOSED)?
}

#[cfg(windows)]
mod selection;
