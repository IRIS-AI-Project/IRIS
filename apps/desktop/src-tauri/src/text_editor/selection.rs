use super::{Selection, CHANGED};
use std::{
    hash::{DefaultHasher, Hash, Hasher},
    ops::Range,
    sync::Mutex,
};
use tauri::WebviewWindow;
use windows::Win32::{
    Foundation::{HGLOBAL, HWND, LPARAM, LRESULT, RPC_E_CHANGED_MODE, WPARAM},
    System::{
        Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_MULTITHREADED,
        },
        DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard},
        Memory::{GlobalLock, GlobalSize, GlobalUnlock},
        Ole::{
            SafeArrayDestroy, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound,
            CF_UNICODETEXT,
        },
    },
    UI::{
        Accessibility::{
            CUIAutomation8, IUIAutomation2, IUIAutomationElement, IUIAutomationTextPattern,
            IUIAutomationValuePattern, TextPatternRangeEndpoint_End,
            TextPatternRangeEndpoint_Start, UIA_TextPatternId, UIA_ValuePatternId,
        },
        Controls::{EM_GETLIMITTEXT, EM_GETPASSWORDCHAR, EM_GETSEL, EM_REPLACESEL},
        Input::KeyboardAndMouse::IsWindowEnabled,
        Shell::{DefSubclassProc, SetWindowSubclass},
        WindowsAndMessaging::*,
    },
};

const MAX_SELECTED: usize = 12000;
const MAX_FIELD: usize = 1_000_000;
const AVATAR_SUBCLASS: usize = 0x49524953;
static BOOKMARK: Mutex<Option<(usize, Focus)>> = Mutex::new(None);
static LAST_SOURCE_POLL: Mutex<Option<std::time::Instant>> = Mutex::new(None);

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Focus {
    window: usize,
    field: usize,
    thread: u32,
    process: u32,
    window_process: u32,
    automation_id: Option<RuntimeId>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct RuntimeId {
    values: [i32; 64],
    length: usize,
}

pub struct Target {
    focus: Focus,
    range: Range<usize>,
    original: Vec<u16>,
    field_hash: u64,
    automation: Option<AutomationTarget>,
}

struct AutomationTarget {
    runtime_id: Vec<i32>,
    full: String,
    prefix: String,
    suffix: String,
}

struct Apartment(bool);
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            if self.0 {
                CoUninitialize();
            }
        }
    }
}

fn automation() -> Option<(Apartment, IUIAutomation2)> {
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED);
        if initialized.is_err() && initialized != RPC_E_CHANGED_MODE {
            return None;
        }
        let apartment = Apartment(initialized.is_ok());
        let automation: IUIAutomation2 =
            CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER).ok()?;
        automation.SetConnectionTimeout(350).ok()?;
        automation.SetTransactionTimeout(350).ok()?;
        Some((apartment, automation))
    }
}

fn runtime_id(element: &IUIAutomationElement) -> Option<Vec<i32>> {
    unsafe {
        let array = element.GetRuntimeId().ok()?;
        let read = || {
            let first = SafeArrayGetLBound(array, 1).ok()?;
            let last = SafeArrayGetUBound(array, 1).ok()?;
            if last < first || last - first > 64 {
                return None;
            }
            (first..=last)
                .map(|index| {
                    let mut value = 0i32;
                    SafeArrayGetElement(array, &index, (&mut value as *mut i32).cast()).ok()?;
                    Some(value)
                })
                .collect()
        };
        let result = read();
        let _ = SafeArrayDestroy(array);
        result
    }
}

// Resolve inside the original HWND, then verify the provider's runtime identity.
// Never keep apartment-bound COM interfaces across Tauri worker threads.
fn find_element<T>(
    automation: &IUIAutomation2,
    focus: Focus,
    mut accept: impl FnMut(&IUIAutomationElement) -> Option<T>,
) -> Option<T> {
    unsafe {
        // Chromium's native focused HWND is a render-host child, while its
        // accessibility document lives under the top-level browser provider.
        // Resolve the saved runtime identity from that provider, not the HWND
        // hierarchy of the render host.
        let root_hwnd = if focus.automation_id.is_some() && !is_edit(handle(focus.field)) {
            focus.window
        } else {
            focus.field
        };
        let root = automation.ElementFromHandle(handle(root_hwnd)).ok()?;
        let walker = automation.ControlViewWalker().ok()?;
        let mut pending = vec![root];
        let started = std::time::Instant::now();
        let mut visited = 0;
        while let Some(element) = pending.pop() {
            if visited >= 256 || started.elapsed().as_millis() > 1200 {
                break;
            }
            visited += 1;
            // A browser's first child can be a system-owned title bar. Skipping
            // that node must not skip the document in its following siblings.
            if visited > 1 {
                if let Ok(sibling) = walker.GetNextSiblingElement(&element) {
                    pending.push(sibling);
                }
            }
            let owner = element.CurrentProcessId().ok().map(|pid| pid as u32);
            if owner != Some(focus.process) && owner != Some(focus.window_process) {
                continue;
            }
            if element
                .CurrentIsPassword()
                .ok()
                .is_some_and(|password| !password.as_bool())
            {
                if let Some(result) = accept(&element) {
                    return Some(result);
                }
                if let Ok(child) = walker.GetFirstChildElement(&element) {
                    pending.push(child);
                }
            }
        }
        None
    }
}

fn handle(raw: usize) -> HWND {
    HWND(raw as *mut _)
}

fn gui_info(thread: u32) -> Option<GUITHREADINFO> {
    let mut gui = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    unsafe { GetGUIThreadInfo(thread, &mut gui).ok()? };
    Some(gui)
}

fn external_focus(window: HWND) -> Option<Focus> {
    let mut window_process = 0;
    let window_thread = unsafe { GetWindowThreadProcessId(window, Some(&mut window_process)) };
    if window_thread == 0 || window_process == std::process::id() {
        return None;
    }
    let field = gui_info(window_thread)?.hwndFocus;
    if field.0.is_null() || unsafe { GetAncestor(field, GA_ROOT) } != window {
        return None;
    }
    // WebView2/Electron/Qt can put the focused native field on a different
    // thread or in a renderer process. Verify that field's own identity.
    let mut process = 0;
    let thread = unsafe { GetWindowThreadProcessId(field, Some(&mut process)) };
    if thread == 0 || process == std::process::id() {
        return None;
    }
    Some(Focus {
        window: window.0 as usize,
        field: field.0 as usize,
        thread,
        process,
        window_process,
        automation_id: (|| unsafe {
            let (_apartment, automation) = automation()?;
            let mut element = automation.GetFocusedElement().ok()?;
            if element.CurrentProcessId().ok()? as u32 != process
                || element.CurrentIsPassword().ok()?.as_bool()
            {
                return None;
            }
            // In browser pages and Qt views keyboard focus can be on a text
            // leaf, while TextPattern belongs to its document or edit ancestor.
            let walker = automation.ControlViewWalker().ok()?;
            let focused = element.clone();
            for _ in 0..16 {
                if element
                    .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                    .is_ok()
                {
                    break;
                }
                let Ok(parent) = walker.GetParentElement(&element) else {
                    element = focused;
                    break;
                };
                if parent.CurrentProcessId().ok()? as u32 != process
                    || parent.CurrentIsPassword().ok()?.as_bool()
                {
                    element = focused;
                    break;
                }
                element = parent;
            }
            let id = runtime_id(&element)?;
            if id.len() > 64 {
                return None;
            }
            let mut values = [0; 64];
            values[..id.len()].copy_from_slice(&id);
            Some(RuntimeId {
                values,
                length: id.len(),
            })
        })(),
    })
}

pub fn is_foreground(hwnd: usize) -> bool {
    unsafe { GetForegroundWindow() == handle(hwnd) }
}

pub fn source(host: &WebviewWindow, allow_bookmark: bool) -> Option<Focus> {
    let foreground = unsafe { GetForegroundWindow() };
    if allow_bookmark
        && host
            .hwnd()
            .ok()
            .is_some_and(|hwnd| hwnd.0 as usize == foreground.0 as usize)
    {
        // The WebView activates before the menu click reaches React.
        BOOKMARK
            .lock()
            .ok()
            .and_then(|bookmark| *bookmark)
            .filter(|(window, _)| *window == foreground.0 as usize)
            .map(|(_, focus)| focus)
    } else {
        external_focus(foreground)
    }
}

// Remember the external field while its thread still has keyboard focus. A
// WebView may activate programmatically before WM_MOUSEACTIVATE reaches us.
pub fn poll_source(host: &WebviewWindow) {
    let Ok(hwnd) = host.hwnd() else { return };
    let foreground = unsafe { GetForegroundWindow() };
    if foreground.0.is_null() || foreground.0 as usize == hwnd.0 as usize {
        return;
    }
    {
        let Ok(mut last) = LAST_SOURCE_POLL.lock() else {
            return;
        };
        if last.is_some_and(|time| time.elapsed() < std::time::Duration::from_millis(400)) {
            return;
        }
        *last = Some(std::time::Instant::now());
    }
    if let Some(focus) = external_focus(foreground) {
        // Discard a result obtained while the user switched to a different app.
        if unsafe { GetForegroundWindow() } != foreground {
            return;
        }
        if let Ok(mut bookmark) = BOOKMARK.lock() {
            *bookmark = Some((hwnd.0 as usize, focus));
        }
    }
}

pub fn watch_avatar(host: &WebviewWindow) -> Result<(), String> {
    let hwnd = host.hwnd().map_err(|error| error.to_string())?;
    install_watcher(handle(hwnd.0 as usize))
}

fn install_watcher(hwnd: HWND) -> Result<(), String> {
    if unsafe { SetWindowSubclass(hwnd, Some(avatar_proc), AVATAR_SUBCLASS, 0) }.as_bool() {
        Ok(())
    } else {
        Err("Windows did not install the selection source watcher".into())
    }
}

unsafe extern "system" fn avatar_proc(
    hwnd: HWND,
    msg: u32,
    wp: WPARAM,
    lp: LPARAM,
    _: usize,
    _: usize,
) -> LRESULT {
    match msg {
        WM_MOUSEACTIVATE => {
            let previous = unsafe { GetForegroundWindow() };
            if previous != hwnd {
                let captured = external_focus(previous).map(|focus| (hwnd.0 as usize, focus));
                if let Ok(mut bookmark) = BOOKMARK.lock() {
                    if captured.is_some()
                        || !bookmark.is_some_and(|(host, focus)| {
                            host == hwnd.0 as usize && focus.window == previous.0 as usize
                        })
                    {
                        *bookmark = captured;
                    }
                }
            }
        }
        WM_ACTIVATE => {
            if (wp.0 & 0xffff) as u32 == WA_INACTIVE {
                if let Ok(mut bookmark) = BOOKMARK.lock() {
                    if bookmark.is_some_and(|(window, _)| window == hwnd.0 as usize) {
                        *bookmark = None;
                    }
                }
            } else if lp.0 != 0 {
                // COM providers can pump messages. Never hold BOOKMARK while
                // querying another process's accessibility tree.
                let previous = lp.0 as usize;
                let already_captured = BOOKMARK.lock().ok().is_some_and(|bookmark| {
                    bookmark.is_some_and(|(window, focus)| {
                        window == hwnd.0 as usize && focus.window == previous
                    })
                });
                if !already_captured {
                    let captured =
                        external_focus(handle(previous)).map(|focus| (hwnd.0 as usize, focus));
                    if let Ok(mut bookmark) = BOOKMARK.lock() {
                        *bookmark = captured;
                    }
                }
            }
        }
        _ => {}
    }
    unsafe { DefSubclassProc(hwnd, msg, wp, lp) }
}

fn same_field(focus: Focus) -> bool {
    let field = handle(focus.field);
    let window = handle(focus.window);
    let mut process = 0;
    let mut window_process = 0;
    unsafe {
        GetWindowThreadProcessId(window, Some(&mut window_process));
    }
    let thread = unsafe { GetWindowThreadProcessId(field, Some(&mut process)) };
    if window_process != focus.window_process
        || thread != focus.thread
        || process != focus.process
        || unsafe { GetAncestor(field, GA_ROOT) } != window
        || unsafe { IsIconic(window).as_bool() }
    {
        return false;
    }
    gui_info(thread).is_some_and(|gui| gui.hwndFocus.0.is_null() || gui.hwndFocus == field)
}

fn send(field: HWND, msg: u32, w: usize, l: isize) -> Option<usize> {
    let mut result = 0;
    let sent = unsafe {
        SendMessageTimeoutW(
            field,
            msg,
            WPARAM(w),
            LPARAM(l),
            SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT,
            160,
            Some(&mut result),
        )
    };
    (sent.0 != 0).then_some(result)
}

fn is_edit(field: HWND) -> bool {
    let mut class = [0u16; 32];
    let length = unsafe { GetClassNameW(field, &mut class) };
    length > 0 && String::from_utf16_lossy(&class[..length as usize]).eq_ignore_ascii_case("Edit")
}

fn edit_style(field: HWND) -> Option<i32> {
    if !is_edit(field) || !unsafe { IsWindowUnicode(field).as_bool() } {
        return None;
    }
    let style = unsafe { GetWindowLongW(field, GWL_STYLE) };
    if style & ES_PASSWORD != 0 || send(field, EM_GETPASSWORDCHAR, 0, 0)? != 0 {
        return None;
    }
    Some(style)
}

fn range(field: HWND) -> Option<Range<usize>> {
    let mut start = 0u32;
    let mut end = 0u32;
    send(
        field,
        EM_GETSEL,
        (&mut start as *mut u32) as usize,
        (&mut end as *mut u32) as isize,
    )?;
    let selection = start as usize..end as usize;
    (!selection.is_empty() && selection.len() <= MAX_SELECTED).then_some(selection)
}

fn value(field: HWND) -> Option<Vec<u16>> {
    let length = send(field, WM_GETTEXTLENGTH, 0, 0)?;
    if length > MAX_FIELD {
        return None;
    }
    let mut value = vec![0u16; length + 2];
    let read = send(field, WM_GETTEXT, value.len(), value.as_mut_ptr() as isize)?;
    if read != length {
        return None;
    }
    value.truncate(read);
    Some(value)
}

fn fingerprint(text: &[u16]) -> u64 {
    let mut hash = DefaultHasher::new();
    text.hash(&mut hash);
    hash.finish()
}

fn application(focus: Focus) -> String {
    let mut title = [0u16; 160];
    let len = unsafe { GetWindowTextW(handle(focus.window), &mut title) };
    if len > 0 {
        String::from_utf16_lossy(&title[..len as usize])
    } else {
        "Окно Windows".into()
    }
}

pub fn capture(focus: Focus) -> Option<(Selection, Option<Target>)> {
    if !same_field(focus) {
        return None;
    }
    let field = handle(focus.field);
    if is_edit(field) {
        let style = edit_style(field)?;
        let selected = range(field)?;
        let full = value(field)?;
        if !same_field(focus) || range(field)? != selected {
            return None;
        }
        let original = full.get(selected.clone())?.to_vec();
        let text = String::from_utf16(&original).ok()?;
        if text.trim().is_empty() {
            return None;
        }
        let replaceable = style & ES_READONLY == 0 && unsafe { IsWindowEnabled(field).as_bool() };
        let target = replaceable.then(|| Target {
            focus,
            range: selected,
            original,
            field_hash: fingerprint(&full),
            automation: None,
        });
        return Some((
            Selection {
                text,
                application: application(focus),
                replaceable,
                ..Selection::default()
            },
            target,
        ));
    }

    let (text, automation) = automation_selection(focus)?;
    let replaceable = automation.is_some();
    let target = automation.map(|automation| Target {
        focus,
        range: 0..0,
        original: text.encode_utf16().collect(),
        field_hash: 0,
        automation: Some(automation),
    });
    same_field(focus).then(|| {
        (
            Selection {
                text,
                application: application(focus),
                replaceable,
                ..Selection::default()
            },
            target,
        )
    })
}

pub fn clipboard_text() -> Option<String> {
    struct Clipboard;
    impl Drop for Clipboard {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    for _ in 0..2 {
        if unsafe { OpenClipboard(None) }.is_ok() {
            let _clipboard = Clipboard;
            let memory = HGLOBAL(unsafe { GetClipboardData(u32::from(CF_UNICODETEXT.0)).ok()? }.0);
            let len =
                (unsafe { GlobalSize(memory) } / std::mem::size_of::<u16>()).min(MAX_SELECTED + 1);
            let ptr = unsafe { GlobalLock(memory) }.cast::<u16>();
            if ptr.is_null() {
                return None;
            }
            // The clipboard stays open and the handle stays locked while reading.
            let units = unsafe { std::slice::from_raw_parts(ptr, len) };
            let text = units
                .iter()
                .position(|&unit| unit == 0)
                .and_then(|end| String::from_utf16(&units[..end]).ok())
                .filter(|text| !text.trim().is_empty());
            unsafe {
                let _ = GlobalUnlock(memory);
            }
            return text;
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
    None
}

fn automation_selection(focus: Focus) -> Option<(String, Option<AutomationTarget>)> {
    let (_apartment, automation) = automation()?;
    find_element(&automation, focus, |element| unsafe {
        if let Some(id) = focus.automation_id {
            if runtime_id(element)?.as_slice() != &id.values[..id.length] {
                return None;
            }
        } else {
            // A HWND can host many browser fields. Without a pre-activation
            // identity, only accept a provider attached to the exact native field.
            if element.CurrentNativeWindowHandle().ok()? != handle(focus.field) {
                return None;
            }
        }
        let pattern: IUIAutomationTextPattern =
            element.GetCurrentPatternAs(UIA_TextPatternId).ok()?;
        let selected = pattern.GetSelection().ok()?;
        if selected.Length().ok()? != 1 {
            return None;
        }
        let range = selected.GetElement(0).ok()?;
        let text = String::from_utf16(&range.GetText(MAX_SELECTED as i32 + 1).ok()?).ok()?;
        if text.trim().is_empty() || text.encode_utf16().count() > MAX_SELECTED {
            return None;
        }
        let target = (|| {
            // Browser selection often belongs to the document's TextPattern,
            // while ValuePattern belongs to the enclosing input or textarea.
            let walker = automation.ControlViewWalker().ok()?;
            let provider_id = runtime_id(element)?;
            let mut field = range.GetEnclosingElement().ok()?;
            let mut value = None;
            for _ in 0..16 {
                if field.CurrentIsPassword().ok()?.as_bool() {
                    return None;
                }
                if let Ok(pattern) =
                    field.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                {
                    value = Some(pattern);
                    break;
                }
                if runtime_id(&field)? == provider_id {
                    break;
                }
                field = walker.GetParentElement(&field).ok()?;
            }
            let value = value?;
            if value.CurrentIsReadOnly().ok()?.as_bool()
                || !field.CurrentIsEnabled().ok()?.as_bool()
            {
                return None;
            }
            let full = String::from_utf16(&value.CurrentValue().ok()?).ok()?;
            if full.encode_utf16().count() > MAX_FIELD {
                return None;
            }
            let scope = if runtime_id(&field)? == provider_id {
                pattern.DocumentRange().ok()?
            } else {
                pattern.RangeFromChild(&field).ok()?
            };
            let prefix = scope.Clone().ok()?;
            prefix
                .MoveEndpointByRange(
                    TextPatternRangeEndpoint_End,
                    &range,
                    TextPatternRangeEndpoint_Start,
                )
                .ok()?;
            let prefix = String::from_utf16(&prefix.GetText(MAX_FIELD as i32 + 1).ok()?).ok()?;
            let suffix = scope.Clone().ok()?;
            suffix
                .MoveEndpointByRange(
                    TextPatternRangeEndpoint_Start,
                    &range,
                    TextPatternRangeEndpoint_End,
                )
                .ok()?;
            let suffix = String::from_utf16(&suffix.GetText(MAX_FIELD as i32 + 1).ok()?).ok()?;
            if full != format!("{prefix}{text}{suffix}") {
                return None;
            }
            Some(AutomationTarget {
                runtime_id: runtime_id(&field)?,
                full,
                prefix,
                suffix,
            })
        })();
        Some((text, target))
    })
}

fn replace_automation(
    target: &Target,
    saved: &AutomationTarget,
    text: &str,
    still_authorized: impl Fn() -> bool,
) -> Result<(), String> {
    if text.contains('\0') || text.encode_utf16().count() > MAX_SELECTED {
        return Err(CHANGED.into());
    }
    let (_apartment, automation) = automation().ok_or(CHANGED)?;
    let element = find_element(&automation, target.focus, |element| {
        (runtime_id(element).as_ref() == Some(&saved.runtime_id)).then(|| element.clone())
    })
    .ok_or(CHANGED)?;
    unsafe {
        let value: IUIAutomationValuePattern = element
            .GetCurrentPatternAs(UIA_ValuePatternId)
            .map_err(|_| CHANGED)?;
        // Recheck both the whole field and selection immediately before writing.
        let current = automation_selection(target.focus).ok_or(CHANGED)?;
        if !same_field(target.focus)
            || !still_authorized()
            || value.CurrentIsReadOnly().map_err(|_| CHANGED)?.as_bool()
            || !element.CurrentIsEnabled().map_err(|_| CHANGED)?.as_bool()
            || current.0.encode_utf16().collect::<Vec<_>>() != target.original
            || !current.1.is_some_and(|now| {
                now.runtime_id == saved.runtime_id
                    && now.full == saved.full
                    && now.prefix == saved.prefix
                    && now.suffix == saved.suffix
            })
        {
            return Err(CHANGED.into());
        }
        let replacement = format!("{}{text}{}", saved.prefix, saved.suffix);
        if replacement.encode_utf16().count() > MAX_FIELD {
            return Err(CHANGED.into());
        }
        value
            .SetValue(&windows::core::BSTR::from(replacement.as_str()))
            .map_err(|_| CHANGED)?;
        // WebView providers may acknowledge SetValue before their renderer
        // publishes the new accessible value. Observe completion without retrying
        // the write, so a delayed response cannot apply the edit twice.
        let started = std::time::Instant::now();
        loop {
            if value
                .CurrentValue()
                .ok()
                .and_then(|text| String::from_utf16(&text).ok())
                .as_ref()
                == Some(&replacement)
            {
                break;
            }
            if started.elapsed() >= std::time::Duration::from_millis(600) {
                return Err(
                    "Поле не подтвердило результат замены. Проверьте его содержимое.".into(),
                );
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    Ok(())
}

pub fn replace(
    target: Target,
    text: &str,
    still_authorized: impl Fn() -> bool,
) -> Result<(), String> {
    if let Some(saved) = &target.automation {
        return replace_automation(&target, saved, text, still_authorized);
    }
    let field = handle(target.focus.field);
    let style = edit_style(field)
        .filter(|style| style & ES_READONLY == 0)
        .ok_or(CHANGED)?;
    if !still_authorized()
        || !same_field(target.focus)
        || !unsafe { IsWindowEnabled(field).as_bool() }
    {
        return Err(CHANGED.into());
    }
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    if normalized.contains('\0') || (style & ES_MULTILINE == 0 && normalized.contains('\n')) {
        return Err("Поле не поддерживает такой текст. Скопируйте черновик вручную.".into());
    }
    let replacement: Vec<u16> = normalized.replace('\n', "\r\n").encode_utf16().collect();
    let full = value(field).ok_or(CHANGED)?;
    let limit = send(field, EM_GETLIMITTEXT, 0, 0).ok_or(CHANGED)?;
    if fingerprint(&full) != target.field_hash
        || full.get(target.range.clone()) != Some(&target.original)
        || replacement.len() > MAX_SELECTED
        || full.len() - target.range.len() + replacement.len() > limit.min(MAX_FIELD)
    {
        return Err(CHANGED.into());
    }
    let mut expected = full;
    expected.splice(target.range.clone(), replacement.iter().copied());
    let terminated: Vec<u16> = replacement.into_iter().chain([0]).collect();
    if !same_field(target.focus)
        || range(field).as_ref() != Some(&target.range)
        || !still_authorized()
    {
        return Err(CHANGED.into());
    }
    if send(field, EM_REPLACESEL, 1, terminated.as_ptr() as isize).is_none()
        || value(field).as_ref() != Some(&expected)
    {
        return Err("Поле не подтвердило результат замены. Проверьте его содержимое.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        process::{Child, Command, Stdio},
    };
    use windows::{core::w, Win32::UI::Controls::EM_SETSEL};

    #[test]
    #[ignore = "Window fixture launched by the cross-process selection test"]
    fn editor_fixture() {
        unsafe {
            let root = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!("Iris editor test"),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                320,
                200,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            let create = |style| {
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("Edit"),
                    w!("До Срок 18 мая После"),
                    WS_CHILD | WS_VISIBLE | WINDOW_STYLE(style as u32),
                    0,
                    0,
                    300,
                    40,
                    Some(root),
                    None,
                    None,
                    None,
                )
                .unwrap()
            };
            let writable = create(0);
            let readonly = create(ES_READONLY);
            let password = create(ES_PASSWORD);
            for field in [writable, readonly, password] {
                assert!(send(field, EM_SETSEL, 3, 14).is_some());
            }
            println!(
                "fixture:{}:{}:{}:{}",
                root.0 as usize, writable.0 as usize, readonly.0 as usize, password.0 as usize
            );
            std::io::stdout().flush().unwrap();
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                DispatchMessageW(&message);
            }
        }
    }

    struct Fixture(Child);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    #[ignore = "Requires an active embedded WebView browser with the test text selected"]
    fn captures_selection_in_embedded_webview_renderer() {
        let raw: usize = std::env::var("IRIS_SELECTION_FIXTURE_HWND")
            .unwrap()
            .parse()
            .unwrap();
        let expected = std::env::var("IRIS_SELECTION_FIXTURE_TEXT").unwrap();
        let focus = external_focus(handle(raw)).expect("Focused embedded renderer field");
        assert_ne!(
            focus.window_process, focus.process,
            "Fixture must exercise a child renderer process"
        );
        assert!(
            same_field(focus),
            "Renderer thread and owning application remain valid"
        );
        let selected = capture(focus).expect("Embedded WebView selection").0;
        assert_eq!(selected.text, expected);
        assert!(
            !selected.clipboard,
            "Selection must be read directly without a clipboard fallback"
        );
    }

    #[test]
    fn source_watcher_is_installed_on_the_window_thread() {
        unsafe {
            let host = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!("Iris watcher fixture"),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                100,
                100,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            let raw = host.0 as usize;
            assert!(std::thread::spawn(move || install_watcher(handle(raw)))
                .join()
                .unwrap()
                .is_err());
            install_watcher(host).unwrap();
            assert!(windows::Win32::UI::Shell::GetWindowSubclass(
                host,
                Some(avatar_proc),
                AVATAR_SUBCLASS,
                None
            )
            .as_bool());
            DestroyWindow(host).unwrap();
        }
    }

    #[test]
    #[ignore = "Requires the dedicated browser selection fixture HWND"]
    fn captures_browser_document_selection_without_native_child_hwnd() {
        let raw: usize = std::env::var("IRIS_SELECTION_FIXTURE_HWND")
            .unwrap()
            .parse()
            .unwrap();
        let mut focus = external_focus(handle(raw)).unwrap_or_else(|| {
            let mut process = 0;
            let thread = unsafe { GetWindowThreadProcessId(handle(raw), Some(&mut process)) };
            Focus {
                window: raw,
                field: raw,
                process,
                thread,
                window_process: process,
                automation_id: None,
            }
        });
        let (_apartment, client) = automation().unwrap();
        // This fixture intentionally exposes the document below a browser root
        // rather than directly on the HWND returned by GetGUIThreadInfo.
        focus.automation_id = Some(RuntimeId {
            values: [0; 64],
            length: 1,
        });
        let id = find_element(&client, focus, |element| unsafe {
            let pattern: IUIAutomationTextPattern =
                element.GetCurrentPatternAs(UIA_TextPatternId).ok()?;
            let ranges = pattern.GetSelection().ok()?;
            if ranges.Length().ok()? != 1 {
                return None;
            }
            let text = String::from_utf16(&ranges.GetElement(0).ok()?.GetText(100).ok()?).ok()?;
            (text == "выбранного текст")
                .then(|| runtime_id(element))
                .flatten()
        })
        .expect("Selected browser document below system-owned siblings");
        let mut values = [0; 64];
        values[..id.len()].copy_from_slice(&id);
        focus.automation_id = Some(RuntimeId {
            values,
            length: id.len(),
        });
        let (selected, target) = capture(focus).expect("Browser selection");
        assert_eq!(selected.text, "выбранного текст");
        if let Ok(replacement) = std::env::var("IRIS_SELECTION_FIXTURE_REPLACEMENT") {
            assert!(
                selected.replaceable,
                "Selected input must offer replacement"
            );
            replace(
                target.expect("Verified browser field"),
                &replacement,
                || true,
            )
            .unwrap();
        }
    }

    #[test]
    fn captures_and_replaces_only_verified_windows_edit_fields() {
        let mut fixture = Fixture(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "text_editor::selection::tests::editor_fixture",
                    "--nocapture",
                ])
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut lines = BufReader::new(fixture.0.stdout.take().unwrap()).lines();
        let handles: Vec<usize> = lines
            .find_map(|line| {
                let line = line.ok()?;
                let (_, values) = line.split_once("fixture:")?;
                Some(
                    values
                        .split(':')
                        .map(|value| value.parse().unwrap())
                        .collect(),
                )
            })
            .expect("Fixture did not expose its fields");
        let focus = |field: usize| {
            let mut process = 0;
            let thread = unsafe { GetWindowThreadProcessId(handle(field), Some(&mut process)) };
            Focus {
                window: handles[0],
                field,
                thread,
                process,
                window_process: process,
                automation_id: None,
            }
        };
        let (selected, target) = capture(focus(handles[2])).expect("Read-only selection");
        assert!(!selected.replaceable && target.is_none());
        assert!(capture(focus(handles[3])).is_none());

        let mut writable = focus(handles[1]);
        writable.automation_id = Some(RuntimeId {
            values: [-1; 64],
            length: 1,
        });
        assert!(automation_selection(writable).is_none());
        writable.automation_id = None;
        // Exercise the UI Automation path even though this fixture also exposes
        // the classic Edit messages used by the fast path.
        let (text, automation) = automation_selection(writable).expect("UI Automation selection");
        assert_eq!(text, "Срок 18 мая");
        let saved = automation.expect("Writable UI Automation value");
        let mut values = [0; 64];
        values[..saved.runtime_id.len()].copy_from_slice(&saved.runtime_id);
        writable.automation_id = Some(RuntimeId {
            values,
            length: saved.runtime_id.len(),
        });
        let target = Target {
            focus: writable,
            range: 0..0,
            original: text.encode_utf16().collect(),
            field_hash: 0,
            automation: Some(saved),
        };
        replace(target, "Дедлайн 18 мая", || true).unwrap();
        assert_eq!(
            String::from_utf16(&value(handle(writable.field)).unwrap()).unwrap(),
            "До Дедлайн 18 мая После"
        );
        send(handle(writable.field), EM_SETSEL, 3, 16).unwrap();
        let (text, saved) = automation_selection(writable).unwrap();
        let stale = Target {
            focus: writable,
            range: 0..0,
            original: text.encode_utf16().collect(),
            field_hash: 0,
            automation: saved,
        };
        send(handle(writable.field), EM_SETSEL, 3, 6).unwrap();
        assert!(replace(stale, "Другое", || true).is_err());
        assert_eq!(
            String::from_utf16(&value(handle(writable.field)).unwrap()).unwrap(),
            "До Дедлайн 18 мая После"
        );
        let reset: Vec<u16> = "До Срок 18 мая После".encode_utf16().chain([0]).collect();
        send(
            handle(writable.field),
            WM_SETTEXT,
            0,
            reset.as_ptr() as isize,
        )
        .unwrap();
        send(handle(writable.field), EM_SETSEL, 3, 14).unwrap();
        let (selected, target) = capture(writable).expect("Selection from a different process");
        assert_eq!(selected.text, "Срок 18 мая");
        assert!(selected.replaceable);
        replace(target.unwrap(), "Дедлайн 18 мая", || true).unwrap();
        assert_eq!(
            String::from_utf16(&value(handle(writable.field)).unwrap()).unwrap(),
            "До Дедлайн 18 мая После"
        );

        send(handle(writable.field), EM_SETSEL, 3, 10).unwrap();
        let target = capture(writable).unwrap().1.unwrap();
        send(handle(writable.field), EM_SETSEL, 3, 6).unwrap();
        assert!(replace(target, "Другое", || true).is_err());
        assert_eq!(
            String::from_utf16(&value(handle(writable.field)).unwrap()).unwrap(),
            "До Дедлайн 18 мая После"
        );
    }
}
