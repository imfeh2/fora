use std::{
    fmt::Write as _,
    path::Path,
    sync::{Arc, Mutex},
};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

mod kernel;
mod logging;

use kernel::{KernelProcess, monitor_kernel, shutdown_kernel, spawn_kernel};
pub use kernel::{Launcher, Ready, launcher, parse_ready};
use logging::AppLog;

pub fn window_url(outcome: Result<&Ready, &str>) -> String {
    match outcome {
        Ok(ready) => format!("index.html?ws=ws://127.0.0.1:{}/ws", ready.port),
        Err(message) => format!("index.html?error={}", url_encode(message)),
    }
}

fn url_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

struct Kernel(Arc<Mutex<Option<KernelProcess>>>);

pub fn run() {
    let log = AppLog::start();
    let instance_log = log.clone();
    let setup_log = log.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            move |app, _args, _cwd| {
                instance_log.record("app.second_instance", "focusing the existing main window");
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            },
        ))
        .setup(move |app| {
            let project = Path::new(env!("CARGO_MANIFEST_DIR")).join("../core");
            let resources = app.path().resource_dir().inspect_err(|error| {
                setup_log.record("app.resources.failed", error.to_string());
            })?;
            setup_log.record(
                "app.resources",
                format!("directory={resources:?} development={}", tauri::is_dev()),
            );
            let launcher = launcher(tauri::is_dev(), &project, &resources);
            let (child, url) = match spawn_kernel(launcher, setup_log.clone()) {
                Ok((child, ready)) => (Some(child), window_url(Ok(&ready))),
                Err(error) => (None, window_url(Err(&error))),
            };
            let child = Arc::new(Mutex::new(child));
            monitor_kernel(child.clone(), setup_log.clone());
            app.manage(Kernel(child.clone()));
            setup_log.window_url(&url);
            match WebviewWindowBuilder::new(app, "main", WebviewUrl::App(url.into()))
                .disable_drag_drop_handler()
                .title("Fora")
                .build()
            {
                Ok(_) => setup_log.record("window.created", "label=main"),
                Err(error) => {
                    setup_log.record("window.failed", error.to_string());
                    if let Some(mut child) = child.lock().unwrap().take() {
                        shutdown_kernel(&mut child, &setup_log);
                    }
                    return Err(error.into());
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app, event| match event {
            RunEvent::ExitRequested { code, .. } => {
                log.record("app.exit_requested", format!("code={code:?}"))
            }
            RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { .. },
                ..
            } => log.record("window.close_requested", label),
            RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } => log.record("window.destroyed", label),
            RunEvent::Exit => {
                log.record("app.exit", "closing sidecar");
                let kernel = app.state::<Kernel>();
                if let Some(mut child) = kernel.0.lock().unwrap().take() {
                    shutdown_kernel(&mut child, &log);
                }
                log.record("app.exit.finished", "sidecar cleanup finished");
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_launcher_runs_the_core_project_with_uv() {
        let launcher = launcher(true, Path::new("repo/core"), Path::new("resources"));
        assert_eq!(launcher.program, Path::new("uv"));
        assert_eq!(
            launcher.args[..7],
            [
                "run",
                "--project",
                "repo/core",
                "python",
                "-m",
                "fora",
                "--webui-dir"
            ]
        );
        assert_eq!(
            Path::new(&launcher.args[7]),
            Path::new("repo").join("webui/dist")
        );
    }

    #[test]
    fn bundled_launcher_runs_the_packaged_kernel() {
        let launcher = launcher(false, Path::new("repo/core"), Path::new("resources"));
        let expected = if cfg!(windows) {
            "core/fora.exe"
        } else {
            "core/fora"
        };
        assert_eq!(launcher.program, Path::new("resources").join(expected));
        assert!(launcher.args.is_empty());
    }

    #[test]
    fn every_launcher_uses_a_free_port_and_loopback() {
        for development in [true, false] {
            let launcher = launcher(development, Path::new("repo/core"), Path::new("resources"));
            assert_eq!(
                launcher.env,
                [
                    ("FORA_PORT".to_string(), "0".to_string()),
                    ("FORA_HOST".to_string(), "127.0.0.1".to_string()),
                ]
            );
            let mut command = std::process::Command::new(&launcher.program);
            command.env("FORA_HOST", "0.0.0.0").envs(launcher.env);
            assert_eq!(
                command
                    .get_envs()
                    .find(|(name, _)| *name == "FORA_HOST")
                    .unwrap()
                    .1,
                Some(std::ffi::OsStr::new("127.0.0.1"))
            );
        }
    }

    #[test]
    fn parses_a_valid_ready_line() {
        let ready = parse_ready(r#"{"type":"ready","port":4567}"#).unwrap();
        assert_eq!(ready, Ready { port: 4567 });
    }

    #[test]
    fn ignores_a_legacy_token_field() {
        let ready =
            parse_ready(r#"{"type":"ready","port":4567,"token":"abc-_","url":"http://127.0.0.1:4567/?token=abc-_"}"#)
                .unwrap();
        assert_eq!(ready, Ready { port: 4567 });
    }

    #[test]
    fn rejects_ready_lines_with_missing_fields() {
        assert_eq!(
            parse_ready(r#"{"type":"ready"}"#).unwrap_err(),
            "Invalid ready line: missing port"
        );
        assert_eq!(
            parse_ready(r#"{"type":"log","port":1}"#).unwrap_err(),
            "Invalid ready line: type is not ready"
        );
    }

    #[test]
    fn rejects_non_json_ready_lines() {
        assert!(
            parse_ready("Traceback (most recent call last)")
                .unwrap_err()
                .starts_with("Invalid ready line:")
        );
    }

    #[test]
    fn builds_the_window_url_from_the_ready_line() {
        let ready = Ready { port: 4567 };
        assert_eq!(
            window_url(Ok(&ready)),
            "index.html?ws=ws://127.0.0.1:4567/ws"
        );
    }

    #[test]
    fn builds_an_encoded_error_url_on_failure() {
        assert_eq!(
            window_url(Err("Failed to start Fora: No such file (os error 2) &x=1")),
            "index.html?error=Failed%20to%20start%20Fora%3A%20No%20such%20file%20%28os%20error%202%29%20%26x%3D1"
        );
    }

    #[test]
    fn app_url_with_query_resolves_under_both_base_urls() {
        let path = window_url(Err("boom"));
        let dev = tauri::Url::parse("http://localhost:1420")
            .unwrap()
            .join(&path)
            .unwrap();
        let bundled = tauri::Url::parse("tauri://localhost")
            .unwrap()
            .join(&path)
            .unwrap();
        assert_eq!(dev.as_str(), "http://localhost:1420/index.html?error=boom");
        assert_eq!(bundled.as_str(), "tauri://localhost/index.html?error=boom");
    }
}
