use tauri::{
    Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

// Includes the transparent gutters in reminder-window.css around the 410 × 84 card.
const WIDTH: f64 = 458.0;
const HEIGHT: f64 = 188.0;

#[tauri::command]
pub async fn show_reminder_window(
    window: WebviewWindow,
    title: String,
    delivery_token: String,
) -> Result<bool, String> {
    if window.label() != "main" || title.trim().is_empty() || title.chars().count() > 500 {
        return Ok(false);
    }
    if window.is_focused().unwrap_or(false) {
        return Ok(false);
    }
    let app = window.app_handle();
    let monitor = window
        .cursor_position()
        .ok()
        .and_then(|cursor| window.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
        .ok_or("No display for Iris reminder")?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let width = (WIDTH * scale).round() as u32;
    let height = (HEIGHT * scale).round() as u32;
    let Some((slot, label)) = (0..3)
        .map(|slot| (slot, format!("iris-reminder-{slot}")))
        .find(|(_, label)| app.get_webview_window(label).is_none())
    else {
        return Ok(false);
    };
    let left = area.position.x + (area.size.width as i32 - width as i32).max(0);
    let top = area.position.y + (area.size.height as i32 - (slot + 1) * height as i32).max(0);
    let script = format!(
        "window.__IRIS_REMINDER__ = {};",
        serde_json::json!({ "title": title, "deliveryToken": delivery_token })
    );
    let popup = WebviewWindowBuilder::new(app, label, WebviewUrl::App("reminder.html".into()))
        .title("Iris · Напоминание")
        .initialization_script(script)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build()
        .map_err(|error| error.to_string())?;
    if let Err(error) = popup
        .set_position(PhysicalPosition::new(left, top))
        .and_then(|_| popup.set_size(PhysicalSize::new(width, height)))
        .and_then(|_| popup.show())
    {
        let _ = popup.close();
        return Err(error.to_string());
    }
    Ok(true)
}
