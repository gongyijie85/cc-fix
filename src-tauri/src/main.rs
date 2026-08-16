#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod logging;

use logging::DiagnosticLog;
use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, mpsc};
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

struct Sidecar {
    child: Mutex<Option<Child>>,
    #[cfg(windows)]
    job: isize,
}

#[cfg(windows)]
impl Drop for Sidecar {
    fn drop(&mut self) {
        if !self.job.eq(&0) {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.job as *mut _);
            }
            self.job = 0;
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyMessage {
    r#type: String,
    session_id: String,
    url: String,
}

fn configured_path(variable: &str, fallback: PathBuf) -> PathBuf {
    std::env::var_os(variable)
        .map(PathBuf::from)
        .unwrap_or(fallback)
}

fn spawn_sidecar() -> Result<(Child, ReadyMessage), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let install_root = executable
        .parent()
        .ok_or("desktop executable has no parent")?;
    let node = configured_path(
        "CC_FIX_NODE_EXE",
        install_root.join("runtime").join("node.exe"),
    );
    let script = configured_path(
        "CC_FIX_GUI_SIDECAR",
        install_root.join("core").join("sidecar.js"),
    );
    let helper = configured_path(
        "CC_FIX_NATIVE_HELPER",
        install_root.join("native").join("cc-fix-native-helper.exe"),
    );
    let bootstrap = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let session_id = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let mut child = Command::new(&node)
        .arg(&script)
        .env("CC_FIX_GUI_TOKEN", &bootstrap)
        .env("CC_FIX_GUI_SESSION_ID", &session_id)
        .env("CC_FIX_NATIVE_HELPER", &helper)
        .env("CC_FIX_DESKTOP", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|error| format!("unable to start private Node runtime: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("sidecar stdout was not captured")?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
        let _ = sender.send(result);
    });
    let line = receiver
        .recv_timeout(Duration::from_secs(20))
        .map_err(|_| "sidecar readiness timed out".to_string())?
        .map_err(|error| format!("sidecar readiness failed: {error}"))?;
    let ready: ReadyMessage = serde_json::from_str(&line)
        .map_err(|error| format!("invalid sidecar readiness: {error}"))?;
    if ready.r#type != "ready"
        || ready.session_id != session_id
        || !ready.url.starts_with("http://127.0.0.1:")
        || !ready.url.contains(&bootstrap)
    {
        let _ = child.kill();
        return Err("sidecar readiness identity did not match this desktop session".into());
    }
    Ok((child, ready))
}

#[cfg(windows)]
fn assign_kill_on_close_job(child: &Child) -> Result<isize, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(format!(
            "unable to create sidecar job: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    let assigned = configured != 0
        && unsafe { AssignProcessToJobObject(job, child.as_raw_handle() as *mut _) } != 0;
    if !assigned {
        let error = std::io::Error::last_os_error();
        unsafe {
            CloseHandle(job);
        }
        return Err(format!("unable to assign sidecar job: {error}"));
    }
    Ok(job as isize)
}

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(not(windows))]
trait CommandFlags {
    fn creation_flags(&mut self, _: u32) -> &mut Self;
}
#[cfg(not(windows))]
impl CommandFlags for Command {
    fn creation_flags(&mut self, _: u32) -> &mut Self {
        self
    }
}

#[cfg(windows)]
fn show_native_error(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    let title: Vec<u16> = "CC-Fix 启动失败\0".encode_utf16().collect();
    let text: Vec<u16> = format!("{message}\0").encode_utf16().collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(not(windows))]
fn show_native_error(message: &str) {
    eprintln!("CC-Fix startup failed: {message}");
}

fn main() {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            // T21：脱敏滚动诊断日志（%APPDATA%\cc-fix\logs\desktop.log）
            let log_directory = configured_path(
                "CC_FIX_DIAGNOSTIC_DIR",
                std::env::var_os("APPDATA")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join("cc-fix")
                    .join("logs"),
            );
            let diagnostic_log = DiagnosticLog::new(log_directory);
            app.manage(diagnostic_log);
            let diagnostic_log = app.state::<DiagnosticLog>();
            diagnostic_log.record("INFO", "desktop shell starting");

            let (mut child, ready) = match spawn_sidecar() {
                Ok(result) => result,
                Err(error) => {
                    diagnostic_log.record("ERROR", &format!("sidecar spawn failed: {error}"));
                    show_native_error(&error);
                    return Err(std::io::Error::other(error).into());
                }
            };
            diagnostic_log.record("INFO", "sidecar ready; session established");
            #[cfg(windows)]
            let job = match assign_kill_on_close_job(&child) {
                Ok(job) => job,
                Err(error) => {
                    let _ = child.kill();
                    diagnostic_log.record("ERROR", &format!("sidecar job assignment failed: {error}"));
                    show_native_error(&error);
                    return Err(std::io::Error::other(error).into());
                }
            };
            app.manage(Sidecar {
                child: Mutex::new(Some(child)),
                #[cfg(windows)]
                job,
            });
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(ready.url.parse()?))
                .title("CC-Fix")
                .inner_size(1120.0, 760.0)
                .min_inner_size(840.0, 620.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!());
    let application = match application {
        Ok(application) => application,
        Err(error) => {
            show_native_error(&format!("桌面窗口初始化失败：{error}"));
            return;
        }
    };
    application.run(|app, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            if let Some(log) = app.try_state::<DiagnosticLog>() {
                log.record("INFO", "desktop shell exiting; sidecar termination follows");
            }
            if let Some(state) = app.try_state::<Sidecar>() {
                if let Ok(mut child) = state.child.lock() {
                    if let Some(mut process) = child.take() {
                        let _ = process.kill();
                        let _ = process.wait();
                    }
                }
            }
        }
    });
}
