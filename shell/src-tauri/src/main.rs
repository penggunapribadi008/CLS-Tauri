// ChatStream Labs - cangkang Tauri (pengganti src/main.js Electron).
// Server + konektor tetap kode lama (src/server.js) yang jalan sebagai proses pendamping (node + sidecar.js).
// Berkas ini mengurus: splash, Dashboard, jendela chat (pin/klik-tembus), tray, hotkey global, sembunyikan dari tangkapan layar.
// Protokol dengan sidecar: lihat src/sidecar.js (JSON per baris lewat stdin/stdout).
//
// Belum ada di tahap ini (lihat shell/README.md): Browser Dock, jendela tombol (ctl) & alert hadiah, area klik di dalam jendela
// ter-pin, simpan CSS, fallback Kick (netFetch), auto-update.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// ---------------------------------------------------------------- state
struct DockSt {
    id: String,
    locked: bool,
    url: String,
}

struct Shell {
    ctrl_pos: Mutex<String>,               // posisi kotak tombol chat: top-right, bottom-left, dst.
    docks: Mutex<HashMap<String, DockSt>>, // Browser Dock yang sedang terbuka (kunci = label jendela)
    child: Mutex<Option<CommandChild>>,
    port: AtomicU16,
    app_ready: AtomicBool, // false selama splash (tidak ada jendela aplikasi yang boleh tampil)
    locked: AtomicBool,    // chat dock di-PIN (klik tembus)
    protect: AtomicBool,   // sembunyikan dari tangkapan layar / OBS
    quitting: AtomicBool,
    asking: AtomicBool,
    dash_loaded: AtomicBool,
    dash_suspended: AtomicBool,
    bounds_dirty: AtomicBool,
    restarts: AtomicU16,
}

impl Shell {
    fn new() -> Self {
        Shell {
            ctrl_pos: Mutex::new("top-right".to_string()),
            docks: Mutex::new(HashMap::new()),
            child: Mutex::new(None),
            port: AtomicU16::new(0),
            app_ready: AtomicBool::new(false),
            locked: AtomicBool::new(false),
            protect: AtomicBool::new(true),
            quitting: AtomicBool::new(false),
            asking: AtomicBool::new(false),
            dash_loaded: AtomicBool::new(false),
            dash_suspended: AtomicBool::new(false),
            bounds_dirty: AtomicBool::new(false),
            restarts: AtomicU16::new(0),
        }
    }
}

fn sh(app: &AppHandle) -> tauri::State<'_, Shell> {
    app.state::<Shell>()
}

// ---------------------------------------------------------------- util
// Folder data SAMA dengan versi Electron (%APPDATA%\ChatStream Labs): pengaturan lama otomatis terbawa.
fn data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .data_dir()
        .map(|d| d.join("ChatStream Labs"))
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn log(app: &AppHandle, msg: &str) {
    use std::io::Write;
    let p = data_dir(app).join("shell-log.txt");
    if let Ok(m) = std::fs::metadata(&p) {
        if m.len() > 1_000_000 {
            let _ = std::fs::remove_file(&p);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "{} {}", t, msg);
    }
}

fn read_global(app: &AppHandle) -> Value {
    let p = data_dir(app).join("settings.json");
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("global").cloned())
        .unwrap_or_else(|| json!({}))
}

fn page_url(app: &AppHandle, path: &str) -> tauri::Url {
    let mut port = sh(app).port.load(Ordering::SeqCst);
    if port == 0 {
        port = 3000;
    }
    format!("http://localhost:{}{}", port, path).parse().expect("url tidak sah")
}

fn send(app: &AppHandle, v: Value) {
    if let Ok(mut g) = sh(app).child.lock() {
        if let Some(c) = g.as_mut() {
            let _ = c.write(format!("{}\n", v).as_bytes());
        }
    }
}

fn push_state(app: &AppHandle, open: Option<bool>) {
    let open = open.unwrap_or_else(|| app.get_webview_window("chat").is_some());
    let locked = sh(app).locked.load(Ordering::SeqCst);
    let docks: serde_json::Map<String, Value> = {
        let s = sh(app);
        let m = s.docks.lock().unwrap_or_else(|e| e.into_inner());
        m.values()
            .map(|d| (d.id.clone(), json!({"open": true, "locked": d.locked})))
            .collect()
    };
    send(
        app,
        json!({"t":"state","dash":{"chat":{"open":open,"locked":locked},"docks":Value::Object(docks)}}),
    );
}

fn apply_protect(app: &AppHandle) {
    let on = sh(app).protect.load(Ordering::SeqCst);
    for (label, w) in app.webview_windows() {
        let _ = w.set_content_protected(on);
        if label.starts_with("ctl-") {
            let _ = w.eval(&format!("window.__st&&window.__st({{prot:{}}})", on));
        }
    }
}

// ---------------------------------------------------------------- posisi jendela
fn bounds_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("shell-state.json")
}

fn load_bounds(app: &AppHandle, key: &str) -> Option<(i32, i32, u32, u32)> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(bounds_path(app)).ok()?).ok()?;
    let b = v.get(key)?;
    Some((
        b.get("x")?.as_i64()? as i32,
        b.get("y")?.as_i64()? as i32,
        b.get("w")?.as_u64()? as u32,
        b.get("h")?.as_u64()? as u32,
    ))
}

fn save_bounds(app: &AppHandle) {
    let mut v: Value = std::fs::read_to_string(bounds_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    if !v.is_object() {
        v = json!({});
    }
    let mut keys: Vec<String> = vec!["chat".to_string(), "dash".to_string()];
    for (l, _) in app.webview_windows() {
        if l.starts_with("dock-") {
            keys.push(l);
        }
    }
    for key in keys.iter() {
        // Browser Dock yang di-pin tidak menyimpan posisi (sama seperti versi lama)
        let pinned = sh(app)
            .docks
            .lock()
            .map(|m| m.get(key.as_str()).map(|d| d.locked).unwrap_or(false))
            .unwrap_or(false);
        if pinned {
            continue;
        }
        if let Some(w) = app.get_webview_window(key) {
            if w.is_minimized().unwrap_or(false) || w.is_maximized().unwrap_or(false) {
                continue;
            }
            if let (Ok(p), Ok(s)) = (w.outer_position(), w.inner_size()) {
                v[key.as_str()] = json!({"x": p.x, "y": p.y, "w": s.width, "h": s.height});
            }
        }
    }
    let _ = std::fs::write(bounds_path(app), v.to_string());
}

fn on_screen(app: &AppHandle, x: i32, y: i32) -> bool {
    app.available_monitors()
        .map(|ms| {
            ms.iter().any(|m| {
                let p = m.position();
                let s = m.size();
                x >= p.x - 50 && y >= p.y - 50 && x < p.x + s.width as i32 && y < p.y + s.height as i32
            })
        })
        .unwrap_or(true)
}

fn restore_bounds(app: &AppHandle, w: &WebviewWindow, key: &str) {
    if let Some((x, y, wd, ht)) = load_bounds(app, key) {
        if on_screen(app, x, y) && wd >= 200 && ht >= 150 {
            let _ = w.set_position(PhysicalPosition::new(x, y));
            let _ = w.set_size(PhysicalSize::new(wd, ht));
        }
    }
}

// ---------------------------------------------------------------- Dashboard
fn make_dash(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let w = WebviewWindowBuilder::new(app, "dash", WebviewUrl::External(page_url(app, "/?view=dashboard")))
        .title("ChatStream Labs - Dashboard")
        .inner_size(1100.0, 700.0)
        .min_inner_size(860.0, 540.0)
        .decorations(false)
        .visible(false)
        .center()
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                webview.app_handle().state::<Shell>().dash_loaded.store(true, Ordering::SeqCst);
            }
        })
        .build()?;
    restore_bounds(app, &w, "dash");
    let _ = w.set_content_protected(sh(app).protect.load(Ordering::SeqCst));
    let a = app.clone();
    w.on_window_event(move |ev| match ev {
        WindowEvent::CloseRequested { api, .. } => {
            if !a.state::<Shell>().quitting.load(Ordering::SeqCst) {
                api.prevent_close();
                let b = a.clone();
                std::thread::spawn(move || ask_quit(&b));
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            a.state::<Shell>().bounds_dirty.store(true, Ordering::SeqCst);
        }
        _ => {}
    });
    Ok(w)
}

fn show_dash(app: &AppHandle) {
    if !sh(app).app_ready.load(Ordering::SeqCst) {
        return;
    }
    if let Some(w) = app.get_webview_window("dash") {
        if sh(app).dash_suspended.swap(false, Ordering::SeqCst) {
            let _ = w.eval(&format!("location.replace('{}')", page_url(app, "/?view=dashboard")));
        }
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// Hemat RAM: Dashboard yang disembunyikan ke tray > 30 dtk dikosongkan halamannya, dimuat lagi saat dibuka (seperti versi Electron).
fn schedule_suspend(app: &AppHandle) {
    let a = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(30));
        if let Some(w) = a.get_webview_window("dash") {
            let s = a.state::<Shell>();
            if !w.is_visible().unwrap_or(true) && !s.quitting.load(Ordering::SeqCst) {
                s.dash_suspended.store(true, Ordering::SeqCst);
                let _ = w.eval("location.replace('about:blank')");
            }
        }
    });
}

fn open_report(app: &AppHandle) {
    let was_suspended = sh(app).dash_suspended.load(Ordering::SeqCst);
    show_dash(app);
    if was_suspended {
        std::thread::sleep(Duration::from_millis(2500));
    }
    if let Some(w) = app.get_webview_window("dash") {
        let _ = w.eval("window.__goTab&&window.__goTab('r')");
    }
}

// ---------------------------------------------------------------- jendela chat (dock)
fn open_chat(app: &AppHandle) {
    let s = sh(app);
    if !s.app_ready.load(Ordering::SeqCst) {
        return;
    }
    if let Some(w) = app.get_webview_window("chat") {
        let _ = w.unminimize();
        if !w.is_visible().unwrap_or(false) {
            let _ = w.show();
        }
        if !s.locked.load(Ordering::SeqCst) {
            let _ = w.set_focus();
        }
        return;
    }
    s.locked.store(true, Ordering::SeqCst); // dibuka dalam keadaan di-pin; lepas pin lewat tray / hotkey
    make_chat(app);
}

fn make_chat(app: &AppHandle) {
    let locked = sh(app).locked.load(Ordering::SeqCst);
    let path = format!("/?view=dock&locked=1{}", if locked { "&pin=1" } else { "" });
    let built = WebviewWindowBuilder::new(app, "chat", WebviewUrl::External(page_url(app, &path)))
        .title("ChatStream Labs")
        .inner_size(460.0, 800.0)
        .min_inner_size(300.0, 300.0)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(true)
        .focused(false)
        .visible(false)
        .build();
    match built {
        Ok(w) => {
            restore_bounds(app, &w, "chat");
            let _ = w.set_content_protected(sh(app).protect.load(Ordering::SeqCst));
            if locked {
                let _ = w.set_ignore_cursor_events(true);
            }
            set_noactivate(&w, locked);
            let a = app.clone();
            w.on_window_event(move |ev| match ev {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    a.state::<Shell>().bounds_dirty.store(true, Ordering::SeqCst);
                    pos_ctl(&a, "chat");
                }
                WindowEvent::Destroyed => {
                    a.state::<Shell>().locked.store(false, Ordering::SeqCst);
                    let b = a.clone();
                    std::thread::spawn(move || {
                        if let Some(c) = b.get_webview_window("ctl-chat") {
                            let _ = c.destroy();
                        }
                        push_state(&b, Some(false));
                    });
                }
                _ => {}
            });
            let _ = w.show();
            make_ctl(app, "chat");
            push_state(app, Some(true));
        }
        Err(e) => log(app, &format!("gagal membuat jendela chat: {}", e)),
    }
}

// Pin = klik tembus (tidak bisa diklik/difokus). Lepas pin = jendela menerima klik, bisa digeser dan di-resize.
fn set_lock(app: &AppHandle, on: bool) {
    let s = sh(app);
    if !s.app_ready.load(Ordering::SeqCst) {
        return;
    }
    let Some(w) = app.get_webview_window("chat") else {
        if on {
            open_chat(app);
        }
        return;
    };
    if s.locked.swap(on, Ordering::SeqCst) == on {
        return;
    }
    let _ = w.unminimize();
    if on {
        let _ = w.set_ignore_cursor_events(true);
        set_noactivate(&w, true);
        let _ = w.eval("window.__pin&&window.__pin(true)");
    } else {
        let _ = w.set_ignore_cursor_events(false);
        set_noactivate(&w, false);
        let _ = w.set_focus();
        let _ = w.eval("window.__pin&&window.__pin(false)");
    }
    js(app, "ctl-chat", &format!("window.__st&&window.__st({{lk:{}}})", on));
    save_bounds(app);
    push_state(app, None);
}

fn toggle_lock(app: &AppHandle) {
    let on = !sh(app).locked.load(Ordering::SeqCst);
    set_lock(app, on);
}

// Tauri 2.12 tidak punya start_resize_dragging, jadi meniru yang dilakukan Windows sendiri saat tepi jendela ditarik:
// kirim WM_NCLBUTTONDOWN dengan kode area tepi (HTLEFT dst). Resize berjalan oleh Windows selama tombol mouse masih ditekan.
fn resize_ht(edge: &str) -> Option<usize> {
    Some(match edge {
        "w" => 10,  // HTLEFT
        "e" => 11,  // HTRIGHT
        "n" => 12,  // HTTOP
        "nw" => 13, // HTTOPLEFT
        "ne" => 14, // HTTOPRIGHT
        "s" => 15,  // HTBOTTOM
        "sw" => 16, // HTBOTTOMLEFT
        "se" => 17, // HTBOTTOMRIGHT
        _ => return None,
    })
}

#[repr(C)]
struct Pt {
    x: i32,
    y: i32,
}

#[link(name = "user32")]
extern "system" {
    fn ReleaseCapture() -> i32;
    fn GetCursorPos(p: *mut Pt) -> i32;
    fn PostMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> i32;
    fn GetWindowLongPtrW(hwnd: isize, idx: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: isize, idx: i32, val: isize) -> isize;
}

const GWL_EXSTYLE: i32 = -20;
const GWLP_HWNDPARENT: i32 = -8; // pemilik jendela (owner): jendela milik selalu tampil di atas pemiliknya
const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
const WS_EX_NOACTIVATE: isize = 0x0800_0000;

fn hwnd_of(w: &WebviewWindow) -> Option<isize> {
    w.hwnd().ok().map(|h| h.0 as isize)
}

// Jendela yang tidak boleh merebut fokus keyboard (pin, kotak tombol).
fn set_noactivate(w: &WebviewWindow, on: bool) {
    if let Some(h) = hwnd_of(w) {
        unsafe {
            let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
            let n = if on { ex | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW } else { ex & !WS_EX_NOACTIVATE };
            if n != ex {
                SetWindowLongPtrW(h, GWL_EXSTYLE, n);
            }
        }
    }
}

fn set_owner(child: &WebviewWindow, parent: &WebviewWindow) {
    if let (Some(c), Some(p)) = (hwnd_of(child), hwnd_of(parent)) {
        unsafe {
            SetWindowLongPtrW(c, GWLP_HWNDPARENT, p);
        }
    }
}

fn start_resize(w: &WebviewWindow, ht: usize) {
    if let Ok(h) = w.hwnd() {
        let hwnd = h.0 as isize;
        unsafe {
            let mut p = Pt { x: 0, y: 0 };
            GetCursorPos(&mut p);
            let lp = (((p.y as isize) & 0xFFFF) << 16) | ((p.x as isize) & 0xFFFF);
            ReleaseCapture();
            PostMessageW(hwnd, 0x00A1, ht, lp); // 0x00A1 = WM_NCLBUTTONDOWN
        }
    }
}

// ---------------------------------------------------------------- kotak tombol (mata, pin, pindah, tutup)
// Jendela kecil tanpa bingkai di LUAR jendela chat (di DALAM pojok kanan atas untuk Browser Dock), memuat /?view=ctl&t=<chat|id dock>.
// Tidak merebut fokus, jadi di atas game tetap bisa diklik. Dimiliki jendela induknya (selalu di atasnya), ikut bergerak/sembunyi/tutup.
const CW: i32 = 162;
const CH: i32 = 36;
const CM: i32 = 4;

fn san(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect()
}

fn parent_label(t: &str) -> String {
    if t == "chat" { "chat".to_string() } else { format!("dock-{}", san(t)) }
}

fn ctl_label(t: &str) -> String {
    format!("ctl-{}", san(t))
}

fn urlenc(s: &str) -> String {
    let mut o = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{:02X}", b));
        }
    }
    o
}

fn js(app: &AppHandle, label: &str, code: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.eval(code);
    }
}

fn lock_of(app: &AppHandle, t: &str) -> bool {
    if t == "chat" {
        sh(app).locked.load(Ordering::SeqCst)
    } else {
        sh(app)
            .docks
            .lock()
            .ok()
            .and_then(|m| m.get(&parent_label(t)).map(|d| d.locked))
            .unwrap_or(false)
    }
}

fn pos_ctl(app: &AppHandle, t: &str) {
    let (Some(p), Some(c)) = (app.get_webview_window(&parent_label(t)), app.get_webview_window(&ctl_label(t))) else {
        return;
    };
    let (Ok(pp), Ok(ps)) = (p.outer_position(), p.outer_size()) else { return };
    let sf = p.scale_factor().unwrap_or(1.0);
    let cw = (CW as f64 * sf).round() as i32;
    let ch = (CH as f64 * sf).round() as i32;
    let cm = (CM as f64 * sf).round() as i32;
    let pw = ps.width as i32;
    let ph = ps.height as i32;
    let (mut x, mut y) = if t == "chat" {
        let pos = sh(app).ctrl_pos.lock().map(|s| s.clone()).unwrap_or_else(|_| "top-right".to_string());
        let top = pos.starts_with("top");
        let x = if pos.ends_with("left") {
            pp.x
        } else if pos.ends_with("right") {
            pp.x + pw - cw
        } else {
            pp.x + (pw - cw) / 2
        };
        (x, if top { pp.y - ch - cm } else { pp.y + ph + cm })
    } else {
        ((pp.x + pw - cw - cm).max(pp.x), pp.y + cm)
    };
    if let Ok(Some(m)) = p.current_monitor() {
        let mp = m.position();
        let ms = m.size();
        x = x.max(mp.x).min(mp.x + ms.width as i32 - cw);
        y = y.max(mp.y).min(mp.y + ms.height as i32 - ch);
    }
    let _ = c.set_position(PhysicalPosition::new(x, y));
    let _ = c.set_size(PhysicalSize::new(cw as u32, ch as u32));
}

fn sync_ctl_vis(app: &AppHandle, t: &str) {
    let (Some(p), Some(c)) = (app.get_webview_window(&parent_label(t)), app.get_webview_window(&ctl_label(t))) else {
        return;
    };
    if p.is_visible().unwrap_or(false) && !p.is_minimized().unwrap_or(false) {
        pos_ctl(app, t);
        let _ = c.show();
    } else {
        let _ = c.hide();
    }
}

fn make_ctl(app: &AppHandle, t: &str) {
    let label = ctl_label(t);
    if app.get_webview_window(&label).is_some() {
        return;
    }
    let Some(parent) = app.get_webview_window(&parent_label(t)) else { return };
    let prot = sh(app).protect.load(Ordering::SeqCst);
    let lk = lock_of(app, t);
    let path = format!("/?view=ctl&t={}&prot={}&lk={}", urlenc(t), if prot { 1 } else { 0 }, if lk { 1 } else { 0 });
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(page_url(app, &path)))
        .title("ChatStream Labs - kontrol")
        .inner_size(CW as f64, CH as f64)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build();
    match built {
        Ok(c) => {
            set_noactivate(&c, true);
            set_owner(&c, &parent);
            let _ = c.set_content_protected(prot);
            pos_ctl(app, t);
            sync_ctl_vis(app, t);
        }
        Err(e) => log(app, &format!("gagal membuat kotak tombol {}: {}", label, e)),
    }
}

// ---------------------------------------------------------------- Browser Dock (widget donasi: alert / media share)
// Satu jendela per dock (transparan, tanpa bingkai, selalu di atas) memuat URL widget. Pengaturan (daftar dock) dibaca dari settings.json
// (global.donateDocks). Pin = klik tembus + tidak bisa difokus + isi tidak bisa diklik; lepas pin = bisa digeser (tombol pindah) dan di-resize (tepi).
// Isi widget diskalakan otomatis supaya muat di jendela (zoom = min(lebar/refW, tinggi/refH)).
// Belum ada: tombol Bisu, "Ukuran otomatis" (mengukur isi halaman), coba-muat-ulang otomatis kalau halaman gagal.
fn don_cfg(app: &AppHandle) -> Vec<Value> {
    read_global(app).get("donateDocks").and_then(|v| v.as_array().cloned()).unwrap_or_default()
}

fn don_find(app: &AppHandle, id: &str) -> Option<Value> {
    don_cfg(app).into_iter().find(|d| d.get("id").and_then(|v| v.as_str()) == Some(id))
}

fn don_url(cfg: &Value) -> Result<tauri::Url, String> {
    let raw = cfg.get("url").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if raw.is_empty() {
        return Err("Isi URL dulu, lalu klik Simpan.".to_string());
    }
    match raw.parse::<tauri::Url>() {
        Ok(u) if u.scheme() == "http" || u.scheme() == "https" => Ok(u),
        _ => Err("URL tidak valid. Awali dengan http:// atau https://.".to_string()),
    }
}

fn num(v: Option<&Value>) -> Option<f64> {
    let v = v?;
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
}

fn state_get(app: &AppHandle) -> Value {
    let v: Value = std::fs::read_to_string(bounds_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    if v.is_object() { v } else { json!({}) }
}

fn don_locked_saved(app: &AppHandle, id: &str) -> bool {
    state_get(app)
        .get("donLocked")
        .and_then(|m| m.get(id))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn don_save_lock(app: &AppHandle, id: &str, on: bool) {
    let mut v = state_get(app);
    if !v["donLocked"].is_object() {
        v["donLocked"] = json!({});
    }
    v["donLocked"][id] = json!(on);
    let _ = std::fs::write(bounds_path(app), v.to_string());
}

fn dock_mode(w: &WebviewWindow, locked: bool) {
    let _ = w.set_ignore_cursor_events(locked);
    let _ = w.set_resizable(!locked);
    set_noactivate(w, locked);
}

fn dock_is_locked(app: &AppHandle, label: &str) -> bool {
    sh(app)
        .docks
        .lock()
        .ok()
        .and_then(|m| m.get(label).map(|d| d.locked))
        .unwrap_or(false)
}

// Skala isi widget supaya muat di jendela.
fn dock_fit(app: &AppHandle, id: &str) {
    let label = parent_label(id);
    let (Some(w), Some(cfg)) = (app.get_webview_window(&label), don_find(app, id)) else { return };
    let sf = w.scale_factor().unwrap_or(1.0);
    let Ok(sz) = w.inner_size() else { return };
    let cw = sz.width as f64 / sf;
    let ch = sz.height as f64 / sf;
    let rw = num(cfg.get("refW")).filter(|v| *v >= 1.0).unwrap_or(1280.0);
    let rh = num(cfg.get("refH")).filter(|v| *v >= 1.0).unwrap_or(720.0);
    let z = if cfg.get("fit").and_then(|v| v.as_bool()) == Some(false) {
        1.0
    } else {
        (cw / rw).min(ch / rh).max(0.1).min(10.0)
    };
    let _ = w.set_zoom(z);
}

// CSS yang disuntik ke halaman widget: latar transparan, opacity isi, isi tidak bisa diklik saat di-pin, bingkai tipis saat tidak di-pin.
fn dock_css_js(cfg: &Value, locked: bool) -> String {
    let op = num(cfg.get("opacity")).map(|v| v.round()).filter(|v| *v > 0.0).unwrap_or(100.0).max(10.0).min(100.0);
    let dock_op = num(cfg.get("dockOp")).map(|v| v.round()).unwrap_or(100.0).max(0.0).min(100.0);
    let mut css = String::from("html,body{background:transparent!important}");
    if locked {
        css.push_str("*{pointer-events:none!important}");
    }
    if op < 100.0 {
        css.push_str(&format!("html{{opacity:{}!important}}", op / 100.0));
    }
    if !locked && dock_op > 0.0 {
        css.push_str(&format!("html{{background:rgba(14,18,20,{})!important}}", dock_op / 100.0));
    }
    let tpl = "(function(){var s=document.getElementById('__cs_css');if(!s){s=document.createElement('style');s.id='__cs_css';(document.head||document.documentElement).appendChild(s);}s.textContent=__CSS__;var f=document.getElementById('__cs_fr');if(__FRAME__){if(!f){f=document.createElement('div');f.id='__cs_fr';f.style.cssText='position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;box-sizing:border-box;z-index:2147483647;box-shadow:inset 0 0 0 2px rgba(255,255,255,.4)';(document.body||document.documentElement).appendChild(f);}}else if(f){f.remove();}})()";
    tpl.replace("__CSS__", &serde_json::to_string(&css).unwrap_or_else(|_| "\"\"".to_string()))
        .replace("__FRAME__", if locked { "false" } else { "true" })
}

fn dock_apply(app: &AppHandle, id: &str) {
    let label = parent_label(id);
    let locked = dock_is_locked(app, &label);
    let Some(cfg) = don_find(app, id) else { return };
    dock_fit(app, id);
    js(app, &label, &dock_css_js(&cfg, locked));
}

fn make_dock(app: &AppHandle, id: &str, locked: bool) -> Result<(), String> {
    let cfg = don_find(app, id).ok_or_else(|| "Browser Dock tidak ditemukan.".to_string())?;
    let url = don_url(&cfg)?;
    let label = parent_label(id);
    if app.get_webview_window(&label).is_some() {
        return Ok(());
    }
    let title = cfg.get("name").and_then(|v| v.as_str()).unwrap_or("Browser Dock").to_string();
    let idc = id.to_string();
    let w = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.clone()))
        .title(title)
        .inner_size(420.0, 520.0)
        .min_inner_size(160.0, 100.0)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(!locked)
        .focused(false)
        .visible(false)
        .on_page_load(move |wv, p| {
            if matches!(p.event(), tauri::webview::PageLoadEvent::Finished) {
                let a = wv.app_handle().clone();
                let i = idc.clone();
                std::thread::spawn(move || dock_apply(&a, &i));
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    if let Ok(mut m) = sh(app).docks.lock() {
        m.insert(label.clone(), DockSt { id: id.to_string(), locked, url: url.to_string() });
    }
    restore_bounds(app, &w, &label);
    let _ = w.set_content_protected(sh(app).protect.load(Ordering::SeqCst));
    dock_mode(&w, locked);
    let a = app.clone();
    let i2 = id.to_string();
    w.on_window_event(move |ev| match ev {
        WindowEvent::Moved(_) => {
            a.state::<Shell>().bounds_dirty.store(true, Ordering::SeqCst);
            pos_ctl(&a, &i2);
        }
        WindowEvent::Resized(_) => {
            a.state::<Shell>().bounds_dirty.store(true, Ordering::SeqCst);
            pos_ctl(&a, &i2);
            dock_fit(&a, &i2);
        }
        WindowEvent::Destroyed => {
            let b = a.clone();
            let i3 = i2.clone();
            std::thread::spawn(move || {
                if let Ok(mut m) = b.state::<Shell>().docks.lock() {
                    m.remove(&parent_label(&i3));
                }
                if let Some(c) = b.get_webview_window(&ctl_label(&i3)) {
                    let _ = c.destroy();
                }
                push_state(&b, None);
            });
        }
        _ => {}
    });
    let _ = w.show();
    make_ctl(app, id);
    push_state(app, None);
    Ok(())
}

// Pin / lepas pin satu dock pada jendela YANG SAMA (halaman widget tidak dimuat ulang, jadi media share tidak terputus).
fn dock_set_lock(app: &AppHandle, id: &str, on: bool) {
    don_save_lock(app, id, on);
    let label = parent_label(id);
    let Some(w) = app.get_webview_window(&label) else { return };
    let changed = {
        let s = sh(app);
        let mut m = s.docks.lock().unwrap_or_else(|e| e.into_inner());
        match m.get_mut(&label) {
            Some(d) if d.locked != on => {
                d.locked = on;
                true
            }
            _ => false,
        }
    };
    if !changed {
        return;
    }
    let _ = w.unminimize();
    dock_mode(&w, on);
    dock_apply(app, id);
    js(app, &ctl_label(id), &format!("window.__st&&window.__st({{lk:{}}})", on));
    save_bounds(app);
    push_state(app, None);
}

// Dipanggil tiap pengaturan berubah: dock yang dihapus / URL-nya kosong ditutup; nama, ukuran acuan, opacity, URL diterapkan.
fn don_sync(app: &AppHandle) {
    let items: Vec<(String, String, String)> = {
        let s = sh(app);
        let m = s.docks.lock().unwrap_or_else(|e| e.into_inner());
        m.iter().map(|(l, d)| (l.clone(), d.id.clone(), d.url.clone())).collect()
    };
    for (label, id, loaded) in items {
        let Some(w) = app.get_webview_window(&label) else { continue };
        let cfg = don_find(app, &id);
        let url = cfg.as_ref().and_then(|c| don_url(c).ok());
        match (cfg, url) {
            (Some(cfg), Some(u)) => {
                if let Some(n) = cfg.get("name").and_then(|v| v.as_str()) {
                    let _ = w.set_title(n);
                }
                if u.to_string() != loaded {
                    if let Ok(mut m) = sh(app).docks.lock() {
                        if let Some(d) = m.get_mut(&label) {
                            d.url = u.to_string();
                        }
                    }
                    let code = format!("location.replace({})", serde_json::to_string(u.as_str()).unwrap_or_default());
                    let _ = w.eval(&code);
                }
                dock_apply(app, &id);
            }
            _ => {
                let _ = w.close();
            }
        }
    }
}

// act: open | close | reload | toggle. id kosong = semua dock
fn donate_act(app: &AppHandle, act: &str, id: &str) -> Value {
    if !sh(app).app_ready.load(Ordering::SeqCst) {
        return json!({"ok": true});
    }
    if act == "toggle" {
        let any = sh(app)
            .docks
            .lock()
            .map(|m| m.keys().any(|l| app.get_webview_window(l).map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false)))
            .unwrap_or(false);
        return donate_act(app, if any { "close" } else { "open" }, id);
    }
    if !["open", "close", "reload"].contains(&act) {
        return json!({"error": "Perintah tidak dikenal."});
    }
    let ids: Vec<String> = if id.is_empty() {
        don_cfg(app)
            .iter()
            .filter_map(|d| d.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .collect()
    } else {
        vec![id.to_string()]
    };
    if ids.is_empty() {
        return json!({"error": "Belum ada Browser Dock. Tambahkan dulu di menu Browser Dock."});
    }
    let mut err: Option<String> = None;
    for i in ids {
        let label = parent_label(&i);
        let w = app.get_webview_window(&label);
        match act {
            "close" => {
                if let Some(w) = w {
                    let _ = w.close();
                }
            }
            "reload" => {
                if let Some(w) = w {
                    match don_find(app, &i).map(|c| don_url(&c)) {
                        Some(Ok(u)) => {
                            let code = format!("location.replace({})", serde_json::to_string(u.as_str()).unwrap_or_default());
                            let _ = w.eval(&code);
                        }
                        Some(Err(e)) => err = Some(e),
                        None => {}
                    }
                } else if !id.is_empty() {
                    err = Some("Browser Dock belum dibuka.".to_string());
                }
            }
            _ => match don_find(app, &i) {
                None => err = Some("Browser Dock tidak ditemukan.".to_string()),
                Some(cfg) => match don_url(&cfg) {
                    Err(e) => err = Some(e),
                    Ok(_) => {
                        if let Some(w) = w {
                            if !w.is_visible().unwrap_or(false) {
                                let _ = w.show();
                                sync_ctl_vis(app, &i);
                            }
                        } else if let Err(e) = make_dock(app, &i, don_locked_saved(app, &i)) {
                            err = Some(e);
                        }
                    }
                },
            },
        }
    }
    match err {
        Some(e) => json!({"error": e}),
        None => json!({"ok": true}),
    }
}

// ---------------------------------------------------------------- jendela lain (laporan, gaya, pratinjau, ...)
fn open_win(app: &AppHandle, url_s: &str, opt: &Value) {
    let is_prev = url_s.contains("preview=1");
    let key: String = url_s
        .split("view=")
        .nth(1)
        .map(|r| r.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect())
        .filter(|k: &String| !k.is_empty())
        .unwrap_or_else(|| "win".to_string());
    let label = format!("win-{}", key);
    if let Some(old) = app.get_webview_window(&label) {
        let _ = old.destroy();
        std::thread::sleep(Duration::from_millis(250)); // beri waktu label dilepas
    }
    let full: tauri::Url = if url_s.starts_with("http") {
        match url_s.parse() {
            Ok(u) => u,
            Err(_) => return,
        }
    } else {
        page_url(app, url_s)
    };
    let width = opt.get("width").and_then(|v| v.as_f64()).unwrap_or(520.0);
    let height = opt.get("height").and_then(|v| v.as_f64()).unwrap_or(820.0);
    let title = opt.get("title").and_then(|v| v.as_str()).unwrap_or("ChatStream Labs").to_string();
    match WebviewWindowBuilder::new(app, &label, WebviewUrl::External(full))
        .title(title)
        .inner_size(width, height)
        .decorations(is_prev)
        .center()
        .build()
    {
        Ok(w) => {
            let _ = w.set_content_protected(sh(app).protect.load(Ordering::SeqCst));
        }
        Err(e) => log(app, &format!("gagal membuka jendela {}: {}", label, e)),
    }
}

fn win_ctl(app: &AppHandle, which: &str, act: &str) {
    let dock_id = which.strip_prefix("donate:");
    let label = match which {
        "main" => "chat".to_string(),
        "dash" => "dash".to_string(),
        o => match dock_id {
            Some(id) => parent_label(id),
            None => format!("win-{}", o),
        },
    };
    let Some(w) = app.get_webview_window(&label) else { return };
    match act {
        "min" => {
            if which == "dash" || which == "main" || dock_id.is_some() {
                let _ = w.hide();
                if which == "dash" {
                    schedule_suspend(app);
                } else if which == "main" {
                    sync_ctl_vis(app, "chat");
                } else if let Some(id) = dock_id {
                    sync_ctl_vis(app, id);
                }
            } else {
                let _ = w.minimize();
            }
        }
        "max" => {
            if dock_id.is_none() {
                if w.is_maximized().unwrap_or(false) {
                    let _ = w.unmaximize();
                } else {
                    let _ = w.maximize();
                }
            }
        }
        "close" => {
            if which == "dash" {
                let a = app.clone();
                std::thread::spawn(move || ask_quit(&a));
            } else {
                let _ = w.close();
            }
        }
        "reload" => {
            let _ = w.eval("location.reload()");
        }
        _ => {}
    }
}

// ---------------------------------------------------------------- keluar / mulai ulang
fn stop_sidecar(app: &AppHandle) {
    let has = sh(app).child.lock().map(|g| g.is_some()).unwrap_or(false);
    if !has {
        return;
    }
    send(app, json!({"t":"quit"})); // sidecar menyimpan data dulu
    std::thread::sleep(Duration::from_millis(400));
    if let Ok(mut g) = sh(app).child.lock() {
        if let Some(c) = g.take() {
            let _ = c.kill();
        }
    }
}

fn quit_app(app: &AppHandle) {
    sh(app).quitting.store(true, Ordering::SeqCst);
    save_bounds(app);
    stop_sidecar(app);
    app.exit(0);
}

fn ask_quit(app: &AppHandle) {
    let s = sh(app);
    if s.quitting.load(Ordering::SeqCst) || s.asking.swap(true, Ordering::SeqCst) {
        return;
    }
    let a = app.clone();
    app.dialog()
        .message("Keluar dari ChatStream Labs?")
        .title("Keluar")
        .buttons(MessageDialogButtons::OkCancelCustom("Keluar".into(), "Batal".into()))
        .show(move |yes| {
            a.state::<Shell>().asking.store(false, Ordering::SeqCst);
            if yes {
                quit_app(&a);
            }
        });
}

fn relaunch(app: &AppHandle) -> ! {
    sh(app).quitting.store(true, Ordering::SeqCst);
    save_bounds(app);
    stop_sidecar(app);
    app.restart()
}

// ---------------------------------------------------------------- hotkey global
const HK_DEF: [(&str, &str); 16] = [
    ("lock", "Ctrl+Alt+L"),
    ("hide", "Ctrl+Alt+H"),
    ("obs", "Ctrl+Alt+O"),
    ("up", "Ctrl+Alt+PageUp"),
    ("down", "Ctrl+Alt+PageDown"),
    ("clear", "Ctrl+Alt+C"),
    ("filter", "Ctrl+Alt+F"),
    ("settings", "Ctrl+Alt+S"),
    ("report", "Ctrl+Alt+R"),
    ("donate", "Ctrl+Alt+D"),
    ("chat", ""),
    ("lockscroll", ""),
    ("send", ""),
    ("alertgift", ""),
    ("donatereload", ""),
    ("newsession", ""),
];

fn run_action(app: &AppHandle, name: &str) {
    if !sh(app).app_ready.load(Ordering::SeqCst) {
        return;
    }
    match name {
        "lock" => toggle_lock(app),
        "hide" => {
            if let Some(w) = app.get_webview_window("chat") {
                if w.is_visible().unwrap_or(false) {
                    let _ = w.hide();
                } else {
                    let _ = w.show();
                }
            }
            sync_ctl_vis(app, "chat");
        }
        "donate" => {
            donate_act(app, "toggle", "");
        }
        "donatereload" => {
            donate_act(app, "reload", "");
        }
        "obs" => {
            let p = !sh(app).protect.load(Ordering::SeqCst);
            send(app, json!({"t":"setGlobal","obj":{"protect":p}}));
        }
        "up" | "down" | "clear" | "filter" | "alertgift" => send(app, json!({"t":"cmd","name":name})),
        "settings" => show_dash(app),
        "report" => open_report(app),
        "chat" => open_chat(app),
        "lockscroll" => {
            let cur = read_global(app).get("lockScroll").and_then(|v| v.as_bool()) == Some(true);
            send(app, json!({"t":"setGlobal","obj":{"lockScroll": !cur}}));
        }
        "send" => {
            let cur = read_global(app).get("sendOn").and_then(|v| v.as_bool()) == Some(true);
            send(app, json!({"t":"setGlobal","obj":{"sendOn": !cur}}));
        }
        "newsession" => send(app, json!({"t":"endSession"})),
        _ => {} // donate / donatereload: Browser Dock belum ada di tahap ini
    }
}

fn set_hotkeys(app: &AppHandle, map: &Value) -> Value {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut res = serde_json::Map::new();
    for (name, def) in HK_DEF.iter() {
        let acc = map
            .get(*name)
            .and_then(|v| v.as_str())
            .unwrap_or(def)
            .trim()
            .to_string();
        if acc.is_empty() {
            res.insert(name.to_string(), json!(true));
            continue;
        }
        let n = name.to_string();
        let ok = gs
            .on_shortcut(acc.as_str(), move |app, _sc, ev| {
                if ev.state() == ShortcutState::Pressed {
                    let a = app.clone();
                    let n2 = n.clone();
                    std::thread::spawn(move || run_action(&a, &n2));
                }
            })
            .is_ok();
        res.insert(name.to_string(), json!(ok));
    }
    Value::Object(res)
}

// ---------------------------------------------------------------- hook dari server (sidecar)
fn handle_hook(app: &AppHandle, name: &str, a: &[Value]) -> Value {
    let arg_b = |i: usize| a.get(i).and_then(|v| v.as_bool()).unwrap_or(false);
    let arg_s = |i: usize| a.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string();
    match name {
        "protect" => {
            sh(app).protect.store(arg_b(0), Ordering::SeqCst);
            apply_protect(app);
            Value::Null
        }
        "open" => {
            let w = arg_s(0);
            if w == "ext" {
                let _ = app
                    .opener()
                    .open_path(data_dir(app).join("extension").to_string_lossy().to_string(), None::<&str>);
            } else if w.starts_with("http://") || w.starts_with("https://") {
                let _ = app.opener().open_url(w, None::<&str>);
            }
            Value::Null
        }
        "window" => {
            open_win(app, &arg_s(0), a.get(1).unwrap_or(&Value::Null));
            Value::Null
        }
        "lock" => {
            let id = arg_s(1);
            if id.is_empty() || id == "chat" {
                set_lock(app, arg_b(0));
            } else {
                dock_set_lock(app, &id, arg_b(0));
            }
            Value::Null
        }
        "drag" => {
            let id = arg_s(1);
            let t = if id.is_empty() { "chat".to_string() } else { id };
            if arg_b(0) && !lock_of(app, &t) {
                if let Some(w) = app.get_webview_window(&parent_label(&t)) {
                    let _ = w.start_dragging();
                }
            }
            Value::Null
        }
        "resize" => {
            let id = arg_s(2);
            let t = if id.is_empty() { "chat".to_string() } else { id };
            if arg_b(0) && !lock_of(app, &t) {
                if let (Some(w), Some(ht)) = (app.get_webview_window(&parent_label(&t)), resize_ht(&arg_s(1))) {
                    start_resize(&w, ht);
                }
            }
            Value::Null
        }
        "global" => {
            let pos = a
                .get(0)
                .and_then(|g| g.get("ctrlPos"))
                .and_then(|v| v.as_str())
                .unwrap_or("top-right")
                .to_string();
            if let Ok(mut g) = sh(app).ctrl_pos.lock() {
                *g = pos;
            }
            pos_ctl(app, "chat");
            don_sync(app);
            Value::Null
        }
        "donate" => donate_act(app, &arg_s(0), &arg_s(1)),
        "openSettings" => {
            show_dash(app);
            Value::Null
        }
        "openReport" => {
            open_report(app);
            Value::Null
        }
        "openChat" => {
            open_chat(app);
            Value::Null
        }
        "winCtl" => {
            win_ctl(app, &arg_s(0), &arg_s(1));
            Value::Null
        }
        "relaunch" => relaunch(app),
        "setHotkeys" => set_hotkeys(app, a.get(0).unwrap_or(&Value::Null)),
        // ---- belum tersedia di tahap ini (jawaban jujur supaya UI tidak menggantung)
        "saveCss" => json!({"canceled": true}),
        "netFetch" => json!({"status": 0, "text": ""}),
        "checkUpdate" => json!("dev"),
        _ => Value::Null, // shape, galert, chatFocus, global: belum ada
    }
}

fn handle_line(app: &AppHandle, line: &str) {
    if line.is_empty() {
        return;
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        log(app, &format!("[server?] {}", line));
        return;
    };
    match v.get("t").and_then(|t| t.as_str()) {
        Some("ready") => {
            let p = v.get("port").and_then(|p| p.as_u64()).unwrap_or(3000) as u16;
            sh(app).port.store(p, Ordering::SeqCst);
            send(app, json!({"t":"ver","v":env!("CARGO_PKG_VERSION")}));
            push_state(app, None);
        }
        Some("hook") => {
            let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            // hook yang belum dipakai dan sering dipanggil: tidak perlu thread
            if matches!(name.as_str(), "shape" | "galert" | "chatFocus") {
                return;
            }
            let args = v.get("args").and_then(|a| a.as_array()).cloned().unwrap_or_default();
            let id = v.get("id").and_then(|i| i.as_u64());
            let a = app.clone();
            std::thread::spawn(move || {
                let r = handle_hook(&a, &name, &args);
                if let Some(id) = id {
                    send(&a, json!({"t":"reply","id":id,"value":r}));
                }
            });
        }
        _ => {}
    }
}

// ---------------------------------------------------------------- sidecar (node + sidecar.js)
fn spawn_sidecar(app: &AppHandle) -> Result<(), String> {
    let res = app.path().resource_dir().map_err(|e| e.to_string())?;
    let res = dunce::simplified(&res).to_path_buf(); // buang awalan \\?\ yang tidak disukai node
    let script = res.join("app").join("sidecar.js");
    let ext = res.join("app").join("extension");
    let (mut rx, child) = app
        .shell()
        .sidecar("node")
        .map_err(|e| e.to_string())?
        .args([script.to_string_lossy().to_string()])
        .env("CG_DATA", data_dir(app).to_string_lossy().to_string())
        .env("CSL_EXT_SRC", ext.to_string_lossy().to_string())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Ok(mut g) = sh(app).child.lock() {
        *g = Some(child);
    }
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(b) => handle_line(&a, String::from_utf8_lossy(&b).trim()),
                CommandEvent::Stderr(b) => log(&a, &format!("[server] {}", String::from_utf8_lossy(&b).trim_end())),
                CommandEvent::Terminated(p) => {
                    log(&a, &format!("[server] berhenti, kode {:?}", p.code));
                    if let Ok(mut g) = sh(&a).child.lock() {
                        *g = None;
                    }
                    let s = sh(&a);
                    if !s.quitting.load(Ordering::SeqCst) && s.restarts.fetch_add(1, Ordering::SeqCst) < 3 {
                        let b = a.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(Duration::from_millis(1000));
                            if let Err(e) = spawn_sidecar(&b) {
                                log(&b, &format!("[server] gagal dijalankan ulang: {}", e));
                            }
                        });
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

// ---------------------------------------------------------------- start-up (di balik splash)
fn startup(app: AppHandle) {
    let t0 = Instant::now();
    if let Err(e) = spawn_sidecar(&app) {
        log(&app, &format!("[server] gagal dijalankan: {}", e));
        app.dialog()
            .message(format!("Server lokal gagal dijalankan:\n{}", e))
            .title("ChatStream Labs")
            .blocking_show();
        app.exit(1);
        return;
    }
    while sh(&app).port.load(Ordering::SeqCst) == 0 {
        if t0.elapsed() > Duration::from_secs(40) {
            log(&app, "[server] tidak siap dalam 40 detik");
            app.dialog()
                .message("Server lokal tidak siap dalam 40 detik. Lihat shell-log.txt di folder data.")
                .title("ChatStream Labs")
                .blocking_show();
            app.exit(1);
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let splash = app.get_webview_window("splash");
    if let Some(s) = &splash {
        let _ = s.eval("window.toConnect&&window.toConnect()");
    }
    if let Err(e) = make_dash(&app) {
        log(&app, &format!("gagal membuat Dashboard: {}", e));
    }
    let hk = read_global(&app).get("hotkeys").cloned().unwrap_or_else(|| json!({}));
    set_hotkeys(&app, &hk);
    // splash tampil minimal 3 dtk, dan menunggu halaman Dashboard selesai dimuat (maks 30 dtk)
    loop {
        let loaded = sh(&app).dash_loaded.load(Ordering::SeqCst);
        if (loaded && t0.elapsed() >= Duration::from_secs(3)) || t0.elapsed() > Duration::from_secs(30) {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    if let Some(s) = &splash {
        let _ = s.eval("window.finish&&window.finish()");
    }
    std::thread::sleep(Duration::from_millis(700));
    if let Some(s) = splash {
        let _ = s.destroy();
    }
    sh(&app).app_ready.store(true, Ordering::SeqCst);
    show_dash(&app);
    push_state(&app, None);
    // simpan posisi jendela tiap ada perubahan (maks sekali per 2 dtk)
    loop {
        std::thread::sleep(Duration::from_secs(2));
        if sh(&app).bounds_dirty.swap(false, Ordering::SeqCst) {
            save_bounds(&app);
        }
    }
}

// ---------------------------------------------------------------- tray
fn tray_action(app: &AppHandle, id: &str) {
    match id {
        "dash" | "settings" => show_dash(app),
        "chat" => open_chat(app),
        "pin" => toggle_lock(app),
        "donate" => {
            donate_act(app, "toggle", "");
        }
        "report" => open_report(app),
        "quit" => ask_quit(app),
        _ => {}
    }
}

fn build_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let h = app.handle();
    let menu = MenuBuilder::new(h)
        .text("dash", "Buka Dashboard")
        .text("chat", "Buka Chat")
        .text("pin", "Pin / lepas pin jendela chat")
        .text("donate", "Browser Dock (buka / tutup)")
        .text("report", "Laporan penonton")
        .text("settings", "Pengaturan")
        .separator()
        .text("quit", "Keluar")
        .build()?;
    let mut tb = TrayIconBuilder::new().tooltip("ChatStream Labs").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = h.default_window_icon() {
        tb = tb.icon(icon.clone());
    }
    tb.on_menu_event(|app, event| {
        let id = event.id().as_ref().to_string();
        let a = app.clone();
        std::thread::spawn(move || tray_action(&a, &id));
    })
    .on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            let a = tray.app_handle().clone();
            std::thread::spawn(move || show_dash(&a));
        }
    })
    .build(app)?;
    Ok(())
}

// ---------------------------------------------------------------- main
fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let a = app.clone();
            std::thread::spawn(move || show_dash(&a));
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Shell::new())
        .setup(|app| {
            let h = app.handle().clone();
            let _ = std::fs::create_dir_all(data_dir(&h));
            let protect = read_global(&h).get("protect").and_then(|v| v.as_bool()) != Some(false);
            sh(&h).protect.store(protect, Ordering::SeqCst);
            if let Some(p) = read_global(&h).get("ctrlPos").and_then(|v| v.as_str()) {
                if let Ok(mut g) = sh(&h).ctrl_pos.lock() {
                    *g = p.to_string();
                }
            }
            // splash: halaman splash.html lama (ditanam di exe), tidak bisa ditutup pengguna
            WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("splash.html".into()))
                .title("ChatStream Labs")
                .inner_size(640.0, 480.0)
                .decorations(false)
                .resizable(false)
                .minimizable(false)
                .maximizable(false)
                .closable(false)
                .center()
                .build()?;
            build_tray(app)?;
            let h2 = h.clone();
            std::thread::spawn(move || startup(h2));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("gagal membangun aplikasi");
    app.run(|app, event| match event {
        // aplikasi tray: menutup jendela terakhir tidak mengakhiri aplikasi; hanya app.exit() (menu Keluar) yang mengakhiri
        RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => stop_sidecar(app),
        _ => {}
    });
}
