#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct Sidecar(Mutex<Option<Child>>);

fn local_data_dir() -> PathBuf {
    env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(env::temp_dir)
        .join("CC-Fix")
        .join("prototype")
}

fn log_line(message: &str) {
    let log_dir = local_data_dir().join("logs");
    let _ = fs::create_dir_all(&log_dir);
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("desktop-shell.log"))
    {
        let _ = writeln!(file, "{message}");
    }
}

fn choose_port() -> Result<u16, String> {
    if let Ok(raw) = env::var("CC_FIX_PROTOTYPE_PORT") {
        if let Ok(port) = raw.parse::<u16>() {
            if TcpListener::bind(("127.0.0.1", port)).is_ok() {
                return Ok(port);
            }
            log_line(&format!("requested port {port} occupied; selecting an ephemeral port"));
        }
    }

    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    Ok(port)
}

fn wait_for_server(child: &mut Child, port: u16) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!("local service exited early: {status}"));
        }
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(80));
    }
    Err("local service did not become ready in 12 seconds".into())
}

fn spawn_sidecar(base: &Path) -> Result<(Child, u16), String> {
    let node = base.join("runtime").join("node.exe");
    let server = base.join("app").join("desktop-server.prototype.mjs");
    if !node.is_file() || !server.is_file() {
        return Err(format!("prototype resources missing under {}", base.display()));
    }

    for _ in 0..3 {
        let port = choose_port()?;
        let log_dir = local_data_dir().join("logs");
        fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
        let stdout = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("node-service.log"))
            .map_err(|e| e.to_string())?;
        let stderr = stdout.try_clone().map_err(|e| e.to_string())?;
        let mut child = Command::new(&node)
            .arg(&server)
            .arg("--port")
            .arg(port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .spawn()
            .map_err(|e| e.to_string())?;

        match wait_for_server(&mut child, port) {
            Ok(()) => return Ok((child, port)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                log_line(&format!("sidecar attempt failed on port {port}: {error}"));
            }
        }
    }
    Err("failed to start local service after three port attempts".into())
}

#[cfg(windows)]
fn request_elevation() -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::{
        Shell::ShellExecuteW,
        WindowsAndMessaging::SW_SHOWNORMAL,
    };

    let exe = env::current_exe().map_err(|e| e.to_string())?;
    let operation: Vec<u16> = std::ffi::OsStr::new("runas").encode_wide().chain(Some(0)).collect();
    let executable: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
    let params: Vec<u16> = std::ffi::OsStr::new("--elevated").encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            executable.as_ptr(),
            params.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        return Err(format!("ShellExecuteW failed with code {}", result as isize));
    }
    Ok(())
}

fn main() {
    if env::args().any(|arg| arg == "--request-elevation") {
        if let Err(error) = request_elevation() {
            log_line(&format!("elevation request failed: {error}"));
            std::process::exit(1);
        }
        return;
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let exe = env::current_exe().map_err(|e| e.to_string())?;
            let base = exe.parent().ok_or("executable has no parent directory")?;
            let (child, port) = spawn_sidecar(base)?;
            *app.state::<Sidecar>().0.lock().map_err(|e| e.to_string())? = Some(child);

            let url = format!("http://127.0.0.1:{port}").parse().map_err(|e| format!("{e}"))?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("CC-Fix")
                .inner_size(1120.0, 760.0)
                .min_inner_size(860.0, 620.0)
                .build()?;
            log_line(&format!("desktop ready on loopback port {port}"));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build desktop prototype");

    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }) {
            if let Ok(mut guard) = app.state::<Sidecar>().0.lock() {
                if let Some(mut child) = guard.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                    log_line("desktop exited; local service stopped");
                }
            }
        }
    });
}
