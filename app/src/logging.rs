use std::{
    ffi::OsString,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use flexi_logger::{
    Age, Cleanup, Criterion, DeferredNow, FileSpec, Naming,
    writers::{ArcFileLogWriter, FileLogWriter, FileLogWriterHandle},
};
use regex::Regex;

const LOG_SIZE_LIMIT: u64 = 8 * 1024 * 1024;

pub(crate) struct AppLog {
    directory: Option<PathBuf>,
    writer: Option<(ArcFileLogWriter, FileLogWriterHandle)>,
    disabled: AtomicBool,
    redactor: Redactor,
}

impl AppLog {
    pub(crate) fn start() -> Arc<Self> {
        let directory = data_directory(
            std::env::var_os("FORA_DATA_DIR"),
            dirs::home_dir().as_deref(),
            std::env::current_dir().ok().as_deref(),
        );
        let logger = match directory.as_deref() {
            Some(directory) => Self::open(directory, std::env::vars_os()),
            None => {
                let logger = Arc::new(Self {
                    directory: None,
                    writer: None,
                    disabled: AtomicBool::new(false),
                    redactor: Redactor::new(std::env::vars_os()),
                });
                logger.disable("the app data directory could not be resolved");
                logger
            }
        };
        logger.record(
            "app.start",
            format!(
                "version={} pid={} os={} arch={} executable={:?} cwd={:?} data_directory={:?}",
                env!("CARGO_PKG_VERSION"),
                std::process::id(),
                std::env::consts::OS,
                std::env::consts::ARCH,
                std::env::current_exe(),
                std::env::current_dir(),
                directory,
            ),
        );
        let mut keys = std::env::vars_os().map(|(key, _)| key).collect::<Vec<_>>();
        keys.sort();
        logger.record("app.environment", format!("keys={keys:?}"));
        let previous = std::panic::take_hook();
        let panic_logger = logger.clone();
        std::panic::set_hook(Box::new(move |info| {
            panic_logger.record("app.panic", info.to_string());
            previous(info);
        }));
        logger
    }

    pub(crate) fn open(
        directory: &Path,
        environment: impl IntoIterator<Item = (OsString, OsString)>,
    ) -> Arc<Self> {
        let writer = FileLogWriter::builder(
            FileSpec::default()
                .directory(directory.join("logs"))
                .basename("app")
                .suppress_timestamp(),
        )
        .append()
        .rotate(
            Criterion::AgeOrSize(Age::Day, LOG_SIZE_LIMIT),
            Naming::TimestampsDirect,
            Cleanup::KeepLogFiles(7),
        )
        .cleanup_in_background_thread(false)
        .try_build_with_handle();
        let error = writer.as_ref().err().map(ToString::to_string);
        let logger = Arc::new(Self {
            directory: Some(directory.to_path_buf()),
            writer: writer.ok(),
            disabled: AtomicBool::new(false),
            redactor: Redactor::new(environment),
        });
        if let Some(error) = error {
            logger.disable(error);
        }
        logger
    }

    pub(crate) fn directory(&self) -> Option<&Path> {
        self.directory.as_deref()
    }

    fn disable(&self, error: impl std::fmt::Display) {
        if !self.disabled.swap(true, Ordering::Relaxed) {
            let _ = writeln!(
                std::io::stderr().lock(),
                "app.log.failed pid={} {}",
                std::process::id(),
                self.redactor.clean(&error.to_string()),
            );
        }
    }

    pub(crate) fn record(&self, event: &str, message: impl AsRef<str>) {
        if self.disabled.load(Ordering::Relaxed) {
            return;
        }
        let Some(writer) = &self.writer else {
            return;
        };
        let message = self.redactor.clean(message.as_ref());
        let mut buffer = Vec::new();
        let result = format_record(
            &mut buffer,
            &mut DeferredNow::new(),
            &log::Record::builder()
                .level(log::Level::Info)
                .target(event)
                .args(format_args!("{message}"))
                .build(),
        )
        .and_then(|()| {
            buffer.push(b'\n');
            let mut writer = writer.0.clone();
            writer.write_all(&buffer)?;
            writer.flush()
        });
        if let Err(error) = result {
            self.disable(error);
        }
    }

    pub(crate) fn window_url(&self, value: &str) {
        let mut url = tauri::Url::parse("http://localhost")
            .unwrap()
            .join(value)
            .unwrap();
        let pairs = url
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), self.redactor.clean(&value)))
            .collect::<Vec<_>>();
        url.query_pairs_mut().clear().extend_pairs(pairs);
        self.record("window.url", &url.as_str()["http://localhost/".len()..]);
    }
}

fn format_record(
    output: &mut dyn Write,
    now: &mut DeferredNow,
    record: &log::Record<'_>,
) -> std::io::Result<()> {
    write!(
        output,
        "{} pid={} {} {}",
        now.format("%Y-%m-%d %H:%M:%S%.3f%:z"),
        std::process::id(),
        record.target(),
        record.args(),
    )
}

fn data_directory(
    value: Option<OsString>,
    home: Option<&Path>,
    cwd: Option<&Path>,
) -> Option<PathBuf> {
    let path = match value.filter(|value| !value.is_empty()) {
        Some(value) => {
            let path = PathBuf::from(value);
            match path.strip_prefix("~") {
                Ok(rest) => home?.join(rest),
                Err(_) => path,
            }
        }
        None => home?.join(".fora"),
    };
    Some(if path.is_absolute() {
        path
    } else {
        cwd?.join(path)
    })
}

struct Redactor {
    secrets: Vec<String>,
    fields: Regex,
    authorization: Regex,
    credentials: Regex,
}

impl Redactor {
    fn new(environment: impl IntoIterator<Item = (OsString, OsString)>) -> Self {
        let keys = Regex::new(
            "(?i)token|password|passwd|secret|api[_-]?key|credential|authorization|cookie",
        )
        .unwrap();
        let mut secrets = environment
            .into_iter()
            .filter(|(key, value)| keys.is_match(&key.to_string_lossy()) && !value.is_empty())
            .map(|(_, value)| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        secrets.sort_by_key(|value| std::cmp::Reverse(value.len()));
        secrets.dedup();
        Self {
            secrets,
            fields: Regex::new(r#"(?i)(["']?[a-z0-9_-]*(?:token|password|passwd|secret|api[_-]?key|credential|authorization|cookie)[a-z0-9_-]*["']?\s*(?:=|:)\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)"#).unwrap(),
            authorization: Regex::new(r"(?i)(\b(?:Bearer|Basic)\s+)[a-z0-9+/_.=-]+").unwrap(),
            credentials: Regex::new(r"(://[^/\s:@]+:)[^@\s/]+@").unwrap(),
        }
    }

    fn clean(&self, input: &str) -> String {
        let mut output = input.to_string();
        for secret in &self.secrets {
            output = output.replace(secret, "[REDACTED]");
        }
        output = self
            .fields
            .replace_all(&output, "$1\"[REDACTED]\"")
            .into_owned();
        output = self
            .authorization
            .replace_all(&output, "$1[REDACTED]")
            .into_owned();
        self.credentials
            .replace_all(&output, "$1[REDACTED]@")
            .into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log_files(directory: &Path) -> Vec<PathBuf> {
        let mut files = std::fs::read_dir(directory.join("logs"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("app_r")
            })
            .collect::<Vec<_>>();
        files.sort();
        files
    }

    #[test]
    fn data_directory_matches_default_relative_and_home_overrides() {
        let cwd = std::env::current_dir().unwrap();
        let home = cwd.join("home");
        assert_eq!(
            data_directory(None, Some(&home), Some(&cwd)).unwrap(),
            home.join(".fora")
        );
        assert_eq!(
            data_directory(Some("".into()), Some(&home), Some(&cwd)).unwrap(),
            home.join(".fora")
        );
        assert_eq!(
            data_directory(Some("demo".into()), Some(&home), Some(&cwd)).unwrap(),
            cwd.join("demo")
        );
        assert_eq!(
            data_directory(Some("~/demo".into()), Some(&home), Some(&cwd)).unwrap(),
            home.join("demo")
        );
        assert_eq!(
            data_directory(Some(home.clone().into_os_string()), Some(&home), Some(&cwd)).unwrap(),
            home
        );
    }

    #[test]
    fn unavailable_home_or_working_directory_is_optional() {
        assert_eq!(data_directory(None, None, None), None);
        assert_eq!(data_directory(Some("relative".into()), None, None), None);
        assert_eq!(data_directory(Some("~/logs".into()), None, None), None);
        let absolute = std::env::current_dir().unwrap().join("data");
        assert_eq!(
            data_directory(Some(absolute.clone().into_os_string()), None, None),
            Some(absolute)
        );
    }

    #[test]
    fn records_raw_output_and_masks_secrets_in_text_and_encoded_urls() {
        let directory = tempfile::tempdir().unwrap();
        let logger = AppLog::open(
            directory.path(),
            [("SERVICE_API_KEY".into(), "hidden-service-value".into())],
        );
        logger.record("stdout", r#"{"type":"ready","port":1234}"#);
        logger.record("stderr", "warning: café 中文 hidden-service-value");
        logger.record("stdout", r#"{"token":"hidden token","password":"hidden password"} Bearer hidden-bearer https://user:hidden-userpass@localhost/?api_key=hidden-query"#);
        logger.window_url("index.html?error=token%3Dhidden-encoded&ws=ws://127.0.0.1:1234/ws");
        let contents = std::fs::read_to_string(&log_files(directory.path())[0]).unwrap();
        assert!(contents.contains(r#"{"type":"ready","port":1234}"#));
        assert!(contents.contains("warning: café 中文"));
        assert!(contents.contains("127.0.0.1%3A1234%2Fws"));
        for secret in [
            "hidden-service-value",
            "hidden token",
            "hidden password",
            "hidden-bearer",
            "hidden-userpass",
            "hidden-query",
            "hidden-encoded",
        ] {
            assert!(!contents.contains(secret), "secret was recorded: {secret}");
        }
    }

    #[test]
    fn retention_only_removes_old_app_logs_and_appends_to_today() {
        let directory = tempfile::tempdir().unwrap();
        let logs = directory.path().join("logs");
        std::fs::create_dir(&logs).unwrap();
        for day in 1..=10 {
            std::fs::write(
                logs.join(format!("app_r2020-01-{day:02}_00-00-00.log")),
                "old",
            )
            .unwrap();
        }
        std::fs::write(logs.join("fora.log"), "backend").unwrap();
        std::fs::write(logs.join("notes.log"), "unrelated").unwrap();
        AppLog::open(directory.path(), []).record("first", "before restart");
        AppLog::open(directory.path(), []).record("second", "after restart");
        let files = std::fs::read_dir(&logs)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(
            files
                .iter()
                .filter(|name| name.to_string_lossy().starts_with("app_r"))
                .count(),
            7
        );
        assert_eq!(
            std::fs::read_to_string(logs.join("fora.log")).unwrap(),
            "backend"
        );
        assert_eq!(
            std::fs::read_to_string(logs.join("notes.log")).unwrap(),
            "unrelated"
        );
        let contents = log_files(directory.path())
            .into_iter()
            .map(|path| std::fs::read_to_string(path).unwrap())
            .collect::<String>();
        assert!(contents.contains("before restart"));
        assert!(contents.contains("after restart"));
    }

    #[test]
    fn size_rotation_keeps_seven_files_and_preserves_complete_records() {
        let directory = tempfile::tempdir().unwrap();
        let logger = AppLog::open(directory.path(), []);
        let message = "x".repeat(LOG_SIZE_LIMIT as usize + 1);
        for _ in 0..10 {
            logger.record("large", &message);
        }
        logger.record("last", "tail record");
        let files = log_files(directory.path());
        assert_eq!(files.len(), 7);
        let sizes = files
            .iter()
            .map(|path| path.metadata().unwrap().len())
            .collect::<Vec<_>>();
        assert!(sizes.iter().all(|size| *size <= LOG_SIZE_LIMIT + 128));
        assert!(sizes.iter().filter(|size| **size > LOG_SIZE_LIMIT).count() >= 5);
        assert!(files.iter().any(|path| {
            std::fs::read_to_string(path)
                .unwrap()
                .contains("tail record")
        }));
        assert!(!logger.disabled.load(Ordering::Relaxed));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn full_disk_disables_logging_without_panicking_or_retrying() {
        let directory = tempfile::tempdir().unwrap();
        let logger = AppLog::open(directory.path(), []);
        logger.record("first", "before the disk filled");
        let path = &log_files(directory.path())[0];
        assert!(
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(&chrono::Local::now().format("app_r%Y-%m-%d").to_string())
        );
        std::fs::remove_file(path).unwrap();
        std::os::unix::fs::symlink("/dev/full", path).unwrap();
        logger
            .writer
            .as_ref()
            .unwrap()
            .0
            .reopen_outputfile()
            .unwrap();
        logger.record("second", "token=private-fixture");
        assert!(logger.disabled.load(Ordering::Relaxed));
        logger.record("third", "ignored after logging failed");
    }
}
