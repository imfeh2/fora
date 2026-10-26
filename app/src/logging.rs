use std::{
    ffi::OsString,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use flexi_logger::{
    Age, Cleanup, Criterion, DeferredNow, FileSpec, Naming,
    writers::{FileLogWriter, LogWriter},
};
use regex::Regex;

pub(crate) struct AppLog {
    directory: PathBuf,
    writer: FileLogWriter,
    redactor: Redactor,
}

impl AppLog {
    pub(crate) fn start() -> Arc<Self> {
        let home = dirs::home_dir().expect("the user home directory is available");
        let directory = data_directory(
            std::env::var_os("FORA_DATA_DIR"),
            &home,
            &std::env::current_dir().expect("the current directory is available"),
        );
        let logger = Self::open(&directory, std::env::vars_os());
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
                .suppress_basename()
                .suppress_timestamp(),
        )
        .append()
        .format(format_record)
        .rotate(
            Criterion::Age(Age::Day),
            Naming::TimestampsCustomFormat {
                current_infix: None,
                format: "app-%Y-%m-%d",
            },
            Cleanup::KeepLogFiles(7),
        )
        .cleanup_in_background_thread(false)
        .try_build()
        .expect("the app log file can be opened");
        Arc::new(Self {
            directory: directory.to_path_buf(),
            writer,
            redactor: Redactor::new(environment),
        })
    }

    pub(crate) fn directory(&self) -> &Path {
        &self.directory
    }

    pub(crate) fn record(&self, event: &str, message: impl AsRef<str>) {
        let message = self.redactor.clean(message.as_ref());
        self.writer
            .write(
                &mut DeferredNow::new(),
                &log::Record::builder()
                    .level(log::Level::Info)
                    .target(event)
                    .args(format_args!("{message}"))
                    .build(),
            )
            .expect("the app log record can be written");
        self.writer.flush().expect("the app log can be flushed");
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

fn data_directory(value: Option<OsString>, home: &Path, cwd: &Path) -> PathBuf {
    let path = match value.filter(|value| !value.is_empty()) {
        Some(value) => {
            let path = PathBuf::from(value);
            match path.strip_prefix("~") {
                Ok(rest) => home.join(rest),
                Err(_) => path,
            }
        }
        None => home.join(".fora"),
    };
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
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

    #[test]
    fn data_directory_matches_default_relative_and_home_overrides() {
        let cwd = std::env::current_dir().unwrap();
        let home = cwd.join("home");
        assert_eq!(data_directory(None, &home, &cwd), home.join(".fora"));
        assert_eq!(
            data_directory(Some("".into()), &home, &cwd),
            home.join(".fora")
        );
        assert_eq!(
            data_directory(Some("demo".into()), &home, &cwd),
            cwd.join("demo")
        );
        assert_eq!(
            data_directory(Some("~/demo".into()), &home, &cwd),
            home.join("demo")
        );
        assert_eq!(
            data_directory(Some(home.clone().into_os_string()), &home, &cwd),
            home
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
        let contents = std::fs::read_to_string(
            directory
                .path()
                .join("logs")
                .join(chrono::Local::now().format("app-%Y-%m-%d.log").to_string()),
        )
        .unwrap();
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
            std::fs::write(logs.join(format!("app-2020-01-{day:02}.log")), "old").unwrap();
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
                .filter(|name| name.to_string_lossy().starts_with("app-"))
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
        let contents = std::fs::read_to_string(
            logs.join(chrono::Local::now().format("app-%Y-%m-%d.log").to_string()),
        )
        .unwrap();
        assert!(contents.contains("before restart"));
        assert!(contents.contains("after restart"));
    }
}
