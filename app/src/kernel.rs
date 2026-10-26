use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};

use serde_json::Value;

use crate::logging::AppLog;

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);

pub struct Launcher {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

pub fn launcher(development: bool, project: &Path, resources: &Path) -> Launcher {
    let env = vec![
        ("FORA_PORT".to_string(), "0".to_string()),
        ("FORA_HOST".to_string(), "127.0.0.1".to_string()),
    ];
    if development {
        let parent = project.parent().expect("the core project has a parent");
        Launcher {
            program: "uv".into(),
            args: vec![
                "run".into(),
                "--project".into(),
                project.to_string_lossy().into_owned(),
                "python".into(),
                "-m".into(),
                "fora".into(),
                "--webui-dir".into(),
                parent.join("webui/dist").to_string_lossy().into_owned(),
            ],
            env,
        }
    } else {
        Launcher {
            program: resources.join(if cfg!(windows) {
                "core/fora.exe"
            } else {
                "core/fora"
            }),
            args: Vec::new(),
            env,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Ready {
    pub port: u16,
}

pub fn parse_ready(line: &str) -> Result<Ready, String> {
    let message: Value =
        serde_json::from_str(line).map_err(|error| format!("Invalid ready line: {error}"))?;
    if message.get("type").and_then(Value::as_str) != Some("ready") {
        return Err("Invalid ready line: type is not ready".to_string());
    }
    let port = message
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .ok_or("Invalid ready line: missing port")?;
    Ok(Ready { port })
}

#[derive(Debug)]
pub(crate) struct KernelProcess {
    pub(crate) child: Child,
    readers: Vec<thread::JoinHandle<()>>,
}

pub(crate) fn spawn_kernel(
    launcher: Launcher,
    log: Arc<AppLog>,
) -> Result<(KernelProcess, Ready), String> {
    spawn_with_timeout(launcher, log, READY_TIMEOUT)
}

fn spawn_with_timeout(
    launcher: Launcher,
    log: Arc<AppLog>,
    timeout: Duration,
) -> Result<(KernelProcess, Ready), String> {
    let started = Instant::now();
    log.record(
        "kernel.spawn",
        format!(
            "program={:?} args={:?} environment_keys={:?}",
            launcher.program,
            launcher.args,
            launcher.env.iter().map(|(key, _)| key).collect::<Vec<_>>()
        ),
    );
    log.record(
        "kernel.executable",
        format!(
            "path={:?} absolute={} exists={} metadata={:?} executable={}",
            launcher.program,
            launcher.program.is_absolute(),
            launcher.program.exists(),
            launcher.program.metadata(),
            executable_status(&launcher.program)
        ),
    );
    let mut command = Command::new(&launcher.program);
    command
        .args(&launcher.args)
        .envs(launcher.env.iter().map(|(key, value)| (key, value)))
        .env("FORA_DATA_DIR", log.directory())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|error| {
        let message = format!("Failed to start Fora: {error}");
        log.record(
            "kernel.spawn.failed",
            format!(
                "elapsed_ms={} os_error={:?} error={message}",
                started.elapsed().as_millis(),
                error.raw_os_error()
            ),
        );
        message
    })?;
    log.record(
        "kernel.spawned",
        format!(
            "pid={} elapsed_ms={}",
            child.id(),
            started.elapsed().as_millis()
        ),
    );
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    let stderr_log = log.clone();
    let stderr_reader = thread::spawn(move || {
        for line in BufReader::new(stderr).split(b'\n') {
            match line {
                Ok(line) => stderr_log.record("kernel.stderr", String::from_utf8_lossy(&line)),
                Err(error) => {
                    stderr_log.record("kernel.stderr.failed", error.to_string());
                    return;
                }
            }
        }
        stderr_log.record("kernel.stderr.eof", "stream closed");
    });
    let (sender, receiver) = mpsc::channel();
    let stdout_log = log.clone();
    let stdout_reader =
        thread::spawn(move || read_stdout(BufReader::new(stdout), sender, stdout_log));
    let readers = vec![stdout_reader, stderr_reader];
    let ready = match receiver.recv_timeout(timeout.saturating_sub(started.elapsed())) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            log.record(
                "kernel.ready.timeout",
                format!("elapsed_ms={}", started.elapsed().as_millis()),
            );
            Err(format!(
                "Fora did not start within {} seconds",
                timeout.as_secs()
            ))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("Fora output reader stopped before it was ready".to_string())
        }
    };
    match ready {
        Ok(ready) => {
            log.record(
                "kernel.ready",
                format!(
                    "pid={} port={} elapsed_ms={}",
                    child.id(),
                    ready.port,
                    started.elapsed().as_millis()
                ),
            );
            Ok((KernelProcess { child, readers }, ready))
        }
        Err(error) => {
            log.record(
                "kernel.ready.failed",
                format!(
                    "elapsed_ms={} status={:?} error={error}",
                    started.elapsed().as_millis(),
                    child.try_wait()
                ),
            );
            terminate_kernel(&mut child, &log, "ready failed");
            finish_readers(readers, &log);
            Err(error)
        }
    }
}

fn read_stdout(
    reader: impl BufRead,
    sender: mpsc::Sender<Result<Ready, String>>,
    log: Arc<AppLog>,
) {
    let mut sender = Some(sender);
    for line in reader.split(b'\n') {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                log.record("kernel.stdout.failed", error.to_string());
                if let Some(sender) = sender.take() {
                    let _ = sender.send(Err(format!("Could not read Fora output: {error}")));
                }
                return;
            }
        };
        let line = String::from_utf8_lossy(&line);
        log.record("kernel.stdout", line.as_ref());
        if sender.is_some() {
            let message = serde_json::from_str::<Value>(&line);
            if matches!(&message, Ok(value) if value.get("type").and_then(Value::as_str) == Some("ready"))
            {
                let ready = parse_ready(&line);
                log.record("kernel.ready.parsed", format!("result={ready:?}"));
                let _ = sender.take().unwrap().send(ready);
            } else {
                log.record(
                    "kernel.ready.skipped",
                    "line does not contain a ready event",
                );
            }
        }
    }
    log.record("kernel.stdout.eof", "stream closed");
    if let Some(sender) = sender {
        let _ = sender.send(Err("Fora exited before it was ready".to_string()));
    }
}

#[cfg(unix)]
fn executable_status(path: &Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    format!(
        "{:?}",
        path.metadata()
            .map(|value| value.is_file() && value.permissions().mode() & 0o111 != 0)
    )
}

#[cfg(windows)]
fn executable_status(path: &Path) -> String {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetBinaryTypeW;
    let path = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut kind = 0;
    if unsafe { GetBinaryTypeW(path.as_ptr(), &mut kind) } != 0 {
        format!("binary_type={kind}; CreateProcess checks execute access")
    } else {
        format!("binary_check_error={}", std::io::Error::last_os_error())
    }
}

pub(crate) fn monitor_kernel(child: Arc<Mutex<Option<KernelProcess>>>, log: Arc<AppLog>) {
    thread::spawn(move || {
        loop {
            {
                let mut guard = child.lock().unwrap();
                let Some(child) = guard.as_mut() else {
                    return;
                };
                match child.child.try_wait() {
                    Ok(None) => {}
                    status => {
                        log.record(
                            "kernel.exited",
                            format!("pid={} result={status:?}", child.child.id()),
                        );
                        return;
                    }
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
    });
}

fn terminate_kernel(child: &mut Child, log: &AppLog, reason: &str) {
    log.record(
        "kernel.kill",
        format!(
            "pid={} reason={reason} result={:?}",
            child.id(),
            child.kill()
        ),
    );
    log.record(
        "kernel.wait",
        format!("pid={} result={:?}", child.id(), child.wait()),
    );
}

pub(crate) fn shutdown_kernel(process: &mut KernelProcess, log: &AppLog) {
    shutdown_child(&mut process.child, log);
    finish_readers(std::mem::take(&mut process.readers), log);
}

fn finish_readers(readers: Vec<thread::JoinHandle<()>>, log: &AppLog) {
    let deadline = Instant::now() + Duration::from_secs(1);
    for reader in readers {
        while !reader.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if reader.is_finished() {
            log.record(
                "kernel.output.finished",
                format!("result={:?}", reader.join()),
            );
        } else {
            log.record(
                "kernel.output.open",
                "output stream remains open after the child exited",
            );
        }
    }
}

fn shutdown_child(child: &mut Child, log: &AppLog) {
    let started = Instant::now();
    if let Some(mut stdin) = child.stdin.take() {
        log.record(
            "kernel.shutdown",
            format!(
                "pid={} write={:?}",
                child.id(),
                stdin.write_all(b"{\"method\":\"system.shutdown\"}\n")
            ),
        );
    } else {
        log.record(
            "kernel.shutdown",
            format!("pid={} stdin unavailable", child.id()),
        );
    }
    let deadline = started + SHUTDOWN_TIMEOUT;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            result => {
                log.record(
                    "kernel.shutdown.finished",
                    format!(
                        "pid={} elapsed_ms={} result={result:?}",
                        child.id(),
                        started.elapsed().as_millis()
                    ),
                );
                return;
            }
        }
    }
    terminate_kernel(child, log, "shutdown timeout");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(
        mode: &str,
        log: Arc<AppLog>,
        timeout: Duration,
    ) -> Result<(KernelProcess, Ready), String> {
        spawn_with_timeout(
            Launcher {
                program: std::env::current_exe().unwrap(),
                args: vec![
                    "--exact".into(),
                    "kernel::tests::sidecar_fixture".into(),
                    "--nocapture".into(),
                ],
                env: vec![("FORA_APP_TEST_MODE".into(), mode.into())],
            },
            log,
            timeout,
        )
    }

    fn contents(directory: &Path) -> String {
        std::fs::read_to_string(
            directory
                .join("logs")
                .join(chrono::Local::now().format("app-%Y-%m-%d.log").to_string()),
        )
        .unwrap()
    }

    #[test]
    fn noise_before_ready_and_output_after_ready_are_recorded_until_shutdown() {
        let directory = tempfile::tempdir().unwrap();
        let log = AppLog::open(directory.path(), []);
        let (mut child, ready) = fixture("noise", log.clone(), Duration::from_secs(5)).unwrap();
        assert_eq!(ready.port, 4567);
        shutdown_kernel(&mut child, &log);
        let deadline = Instant::now() + Duration::from_secs(2);
        while !contents(directory.path()).contains("kernel.stderr.eof") {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        let output = contents(directory.path());
        for expected in [
            "bootloader notice",
            "not json",
            "kernel.ready.skipped",
            "kernel.ready.parsed",
            "after ready",
            "stderr notice",
            "shutdown received",
            "kernel.shutdown.finished",
        ] {
            assert!(output.contains(expected), "missing {expected}: {output}");
        }
        assert!(child.child.try_wait().unwrap().unwrap().success());
    }

    #[test]
    fn eof_invalid_ready_and_missing_executable_have_distinct_logs() {
        for (mode, expected) in [
            ("eof", "Fora exited before it was ready"),
            ("invalid", "Invalid ready line: missing port"),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let log = AppLog::open(directory.path(), []);
            let error = fixture(mode, log, Duration::from_secs(5)).unwrap_err();
            assert_eq!(error, expected);
            let output = contents(directory.path());
            assert!(output.contains(expected));
            assert!(output.contains("kernel.wait"));
        }
        let directory = tempfile::tempdir().unwrap();
        let log = AppLog::open(directory.path(), []);
        let error = spawn_kernel(
            Launcher {
                program: directory.path().join("absent-executable"),
                args: vec![],
                env: vec![],
            },
            log,
        )
        .unwrap_err();
        assert!(error.starts_with("Failed to start Fora:"));
        assert!(contents(directory.path()).contains("kernel.spawn.failed"));
    }

    #[test]
    fn continuous_noise_does_not_extend_the_ready_deadline() {
        let directory = tempfile::tempdir().unwrap();
        let log = AppLog::open(directory.path(), []);
        let started = Instant::now();
        let error = fixture("timeout", log, Duration::from_millis(200)).unwrap_err();
        assert!(error.starts_with("Fora did not start within"));
        assert!(started.elapsed() < Duration::from_secs(2));
        let output = contents(directory.path());
        assert!(output.contains("kernel.ready.timeout"));
        assert!(output.contains("reason=ready failed"));
        assert!(output.contains("kernel.wait"));
    }

    #[test]
    fn monitor_records_a_child_that_exits_after_ready() {
        let directory = tempfile::tempdir().unwrap();
        let log = AppLog::open(directory.path(), []);
        let (child, _) = fixture("exit", log.clone(), Duration::from_secs(5)).unwrap();
        let child = Arc::new(Mutex::new(Some(child)));
        monitor_kernel(child.clone(), log.clone());
        let deadline = Instant::now() + Duration::from_secs(3);
        while !contents(directory.path()).contains("kernel.exited") {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        assert!(
            child
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .child
                .try_wait()
                .unwrap()
                .unwrap()
                .success()
        );
    }

    #[test]
    fn stdout_decodes_non_utf8_noise_without_losing_the_ready_event() {
        let directory = tempfile::tempdir().unwrap();
        let log = AppLog::open(directory.path(), []);
        let (sender, receiver) = mpsc::channel();
        read_stdout(
            std::io::Cursor::new(b"warning: \xff\r\n{\"type\":\"ready\",\"port\":1234}\r\n"),
            sender,
            log,
        );
        assert_eq!(receiver.recv().unwrap().unwrap().port, 1234);
    }

    #[test]
    fn renamed_bundled_executable_matches_the_error_url_and_spawn_log() {
        let directory = tempfile::tempdir().unwrap();
        let resources = directory.path().join("resources");
        std::fs::create_dir_all(resources.join("core")).unwrap();
        let launcher = launcher(false, Path::new("unused"), &resources);
        std::fs::copy(std::env::current_exe().unwrap(), &launcher.program).unwrap();
        std::fs::rename(
            &launcher.program,
            launcher.program.with_extension("disabled"),
        )
        .unwrap();
        let log = AppLog::open(directory.path(), []);
        let error = spawn_kernel(launcher, log.clone()).unwrap_err();
        let url = crate::window_url(Err(&error));
        log.window_url(&url);
        let url = tauri::Url::parse("http://tauri.localhost")
            .unwrap()
            .join(&url)
            .unwrap();
        assert_eq!(
            url.query_pairs().find(|(key, _)| key == "error").unwrap().1,
            error
        );
        assert!(error.starts_with("Failed to start Fora:"));
        let output = contents(directory.path());
        assert!(output.contains("exists=false"));
        assert!(output.contains("kernel.spawn.failed"));
        assert!(output.contains("os_error=Some("));
        assert!(output.contains("Failed to start Fora:"));
        assert!(!output.contains("kernel.spawned"));
        assert!(!output.contains("kernel.shutdown"));
    }

    #[test]
    fn unresponsive_shutdown_is_killed_and_its_output_is_drained() {
        let directory = tempfile::tempdir().unwrap();
        let log = AppLog::open(directory.path(), []);
        let (mut child, _) =
            fixture("ignore-shutdown", log.clone(), Duration::from_secs(5)).unwrap();
        shutdown_kernel(&mut child, &log);
        let output = contents(directory.path());
        assert!(output.contains("reason=shutdown timeout"));
        assert!(output.contains("kernel.wait"));
        assert!(output.contains("kernel.output.finished"));
        assert!(!child.child.try_wait().unwrap().unwrap().success());
    }

    #[test]
    fn sidecar_fixture() {
        let Ok(mode) = std::env::var("FORA_APP_TEST_MODE") else {
            return;
        };
        println!("bootloader notice\nnot json\n{{\"type\":\"log\"}}");
        eprintln!("stderr notice");
        if mode == "eof" {
            return;
        }
        if mode == "timeout" {
            loop {
                println!("waiting for ready");
                std::io::stdout().flush().unwrap();
                thread::sleep(Duration::from_millis(10));
            }
        }
        if mode == "invalid" {
            println!("{{\"type\":\"ready\"}}");
            return;
        }
        println!("{{\"type\":\"ready\",\"port\":4567}}\nafter ready");
        std::io::stdout().flush().unwrap();
        if mode == "exit" {
            return;
        }
        let mut input = String::new();
        std::io::stdin().read_line(&mut input).unwrap();
        let message: Value = serde_json::from_str(&input).unwrap();
        assert_eq!(message["method"], "system.shutdown");
        println!("shutdown received");
        if mode == "ignore-shutdown" {
            thread::sleep(Duration::from_secs(30));
        }
    }
}
