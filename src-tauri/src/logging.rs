//! 脱敏滚动诊断日志（T21）。
//!
//! 桌面壳的滚动技术日志：按大小轮转（desktop.log → desktop.log.1），写入前强制脱敏，
//! 不记录环境变量值、令牌、IP、恢复数据等敏感内容（CONTEXT.md「诊断日志」）。
//! 不依赖 regex crate：所有规则用线性扫描实现，保持最小依赖面。

use std::fs::{self, File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const LOG_FILE_NAME: &str = "desktop.log";
pub const LOG_BACKUP_NAME: &str = "desktop.log.1";
pub const DEFAULT_MAX_BYTES: u64 = 512 * 1024;
const MAX_ENTRY_BYTES: usize = 4096;

/// 诊断日志：目录 + 轮转上限 + 内存环形快照（供"复制诊断信息"动作使用）。
pub struct DiagnosticLog {
    directory: PathBuf,
    max_bytes: u64,
    entries: Mutex<Vec<String>>,
    capacity: usize,
}

fn is_hex_digit(byte: u8) -> bool {
    byte.is_ascii_hexdigit()
}

/// 标准 base64 字符集（含 URL 变体的 - _ 与填充 =）——PEM 主体是标准 base64，
/// 不含 + / 的旧字符集会把 64 字符的 PEM 行切成不足 43 的短段而逃逸掩码（issue #54）。
fn is_base64(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_' || byte == b'+' || byte == b'/' || byte == b'='
}

fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' || byte == b'.'
}

/// 键名是否属于敏感词表（大小写不敏感），或形如全大写环境变量名。
fn is_sensitive_key(key: &str) -> bool {
    let key_upper = key.to_ascii_uppercase();
    key_upper.contains("TOKEN")
        || key_upper.contains("SECRET")
        || key_upper.contains("PASSWORD")
        || key_upper.contains("API_KEY")
        || key_upper.contains("API-KEY")
        || key_upper.contains("COOKIE")
        || key_upper.contains("SESSION")
        || (key_upper.len() >= 2 && key_upper.chars().all(|character| character.is_ascii_uppercase() || character == '_' || character == '.') && key_upper.contains('_'))
}

/// 把输入中的敏感形态替换为占位符。规则按优先级应用：
/// 1. PEM 私钥块整体删除（含无 END 标记的截断块——替换至消息末尾）
/// 2. 64 位十六进制（bootstrap 令牌 = 2×uuid simple）
/// 3. 43+ 位 base64（会话令牌 / PEM 主体）
/// 4. IPv4 地址
/// 5. 大写环境变量赋值（保留变量名，掩码值）
/// 6. token/secret/password/api key/cookie 赋值（掩码值）
/// 7. JSON 键值形态 `"api_key": "value"`（掩码键与值——issue #54）
pub fn redact(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = String::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        // 1. PEM 私钥块
        if input[index..].starts_with("-----BEGIN") {
            if let Some(end) = input[index..].find("-----END") {
                let block_end = index + end + "-----END PRIVATE KEY-----".len().min(input[index + end..].len());
                output.push_str("[private key]");
                index = block_end;
                continue;
            }
            // 截断的 PEM（无 END 标记）：剩余主体同样是私钥内容，替换至消息末尾（issue #54）。
            output.push_str("[private key]");
            index = bytes.len();
            continue;
        }
        // 2. 64 位十六进制
        if bytes[index].is_ascii_hexdigit()
            && index + 64 <= bytes.len()
            && bytes[index..index + 64].iter().all(|byte| is_hex_digit(*byte))
            && (index == 0 || !is_hex_digit(bytes[index - 1]))
            && (index + 64 == bytes.len() || !is_hex_digit(bytes[index + 64]))
        {
            output.push_str("[token]");
            index += 64;
            continue;
        }
        // 3. 43+ 位 base64
        if is_base64(bytes[index])
            && index + 43 <= bytes.len()
            && bytes[index..index + 43].iter().all(|byte| is_base64(*byte))
            && (index == 0 || !is_base64(bytes[index - 1]))
        {
            let mut run = 43usize;
            while index + run < bytes.len() && is_base64(bytes[index + run]) {
                run += 1;
            }
            output.push_str("[secret]");
            index += run;
            continue;
        }
        // 4. IPv4
        if bytes[index].is_ascii_digit() {
            if let Some(masked) = mask_ipv4(input, index) {
                output.push_str("[ip]");
                index += masked;
                continue;
            }
        }
        // 5/6. 赋值掩码：key=value 形态（token=, API_KEY= 等）
        if bytes[index] == b'=' {
            if let Some(prefix_len) = sensitive_assignment_prefix(input, index) {
                if let Some(next) = mask_assignment_value(input, index + 1) {
                    output.truncate(output.len() - prefix_len);
                    output.push_str("[redacted]");
                    index = next;
                    continue;
                }
            }
        }
        // 7. JSON 键值形态："sensitive_key": value（issue #54）
        if bytes[index] == b':' && index > 0 && bytes[index - 1] == b'"' {
            if let Some((key_start, key)) = json_key_before(input, index) {
                if is_sensitive_key(key) {
                    if let Some(next) = mask_json_value(input, index + 1) {
                        output.truncate(output.len() - (index - key_start));
                        output.push_str("[redacted]");
                        index = next;
                        continue;
                    }
                }
            }
        }
        let character = input[index..].chars().next().unwrap_or(' ');
        output.push(character);
        index += character.len_utf8();
    }
    output
}

/// 从 value_start 起扫描赋值值（引号包裹或到空白），值长度 >= 4 才值得掩码；
/// 返回消费到的下一个索引。
fn mask_assignment_value(input: &str, value_start: usize) -> Option<usize> {
    let bytes = input.as_bytes();
    let mut cursor = value_start;
    // 引号包裹的值：跳过开引号，扫到配对的闭引号或空白为止。
    let quote = if cursor < bytes.len() && (bytes[cursor] == b'"' || bytes[cursor] == b'\'') {
        let marker = bytes[cursor];
        cursor += 1;
        Some(marker)
    } else {
        None
    };
    while cursor < bytes.len() && !bytes[cursor].is_ascii_whitespace() {
        if let Some(marker) = quote {
            if bytes[cursor] == marker {
                cursor += 1;
                break;
            }
        }
        cursor += 1;
    }
    (cursor - value_start >= 4).then_some(cursor)
}

/// JSON 值扫描：跳过空白，双引号值扫到闭引号，裸值扫到空白/逗号/右花括号。
fn mask_json_value(input: &str, value_start: usize) -> Option<usize> {
    let bytes = input.as_bytes();
    let mut cursor = value_start;
    while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    if cursor >= bytes.len() {
        return None;
    }
    if bytes[cursor] == b'"' {
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor] != b'"' {
            cursor += 1;
        }
        if cursor < bytes.len() {
            cursor += 1; // 闭引号
        }
    } else {
        while cursor < bytes.len()
            && !bytes[cursor].is_ascii_whitespace()
            && bytes[cursor] != b','
            && bytes[cursor] != b'}'
            && bytes[cursor] != b']'
        {
            cursor += 1;
        }
    }
    (cursor - value_start >= 4).then_some(cursor)
}

/// colon_index 前紧邻的双引号键（`"key":`）：返回开引号位置与键名。
fn json_key_before(input: &str, colon_index: usize) -> Option<(usize, &str)> {
    let bytes = input.as_bytes();
    if colon_index == 0 || bytes[colon_index - 1] != b'"' {
        return None;
    }
    let mut scan = colon_index - 1;
    while scan > 0 {
        scan -= 1;
        if bytes[scan] == b'"' {
            return Some((scan, &input[scan + 1..colon_index - 1]));
        }
    }
    None
}

/// 检查 bytes[index]（'='）前面的紧邻片段是否是敏感键名，返回键名长度（含分隔符前的下划线等）。
fn sensitive_assignment_prefix(input: &str, equal_index: usize) -> Option<usize> {
    let bytes = input.as_bytes();
    let mut start = equal_index;
    while start > 0 && is_word(bytes[start - 1]) {
        start -= 1;
    }
    if is_sensitive_key(&input[start..equal_index]) {
        Some(equal_index - start)
    } else {
        None
    }
}

/// 尝试从 index 起解析 IPv4（d.d.d.d），成功返回总长度。
fn mask_ipv4(input: &str, index: usize) -> Option<usize> {
    let bytes = input.as_bytes();
    let mut consumed = 0usize;
    let mut octets = 0usize;
    while consumed < bytes.len() - index {
        let start = index + consumed;
        let mut digits = 0usize;
        while start + digits < bytes.len() && bytes[start + digits].is_ascii_digit() {
            digits += 1;
        }
        if digits == 0 || digits > 3 {
            return None;
        }
        octets += 1;
        consumed += digits;
        if octets == 4 {
            break;
        }
        if start + digits < bytes.len() && bytes[start + digits] == b'.' {
            consumed += 1;
        } else {
            return None;
        }
    }
    if octets == 4 {
        Some(consumed)
    } else {
        None
    }
}

impl DiagnosticLog {
    /// 创建日志目录（不存在则创建）；失败时退化为内存环形缓冲，仍可记录。
    pub fn new(directory: PathBuf) -> Self {
        let _ = fs::create_dir_all(&directory);
        Self {
            directory,
            max_bytes: DEFAULT_MAX_BYTES,
            entries: Mutex::new(Vec::new()),
            capacity: 200,
        }
    }

    pub fn with_max_bytes(mut self, max_bytes: u64) -> Self {
        self.max_bytes = max_bytes;
        self
    }

    pub fn log_file(&self) -> PathBuf {
        self.directory.join(LOG_FILE_NAME)
    }

    fn rotate(&self) {
        let current = self.log_file();
        let backup = self.directory.join(LOG_BACKUP_NAME);
        let _ = fs::remove_file(&backup);
        let _ = fs::rename(&current, &backup);
    }

    /// 记录一条诊断：脱敏 + 截断 + 按大小轮转。IO 失败静默（诊断层不阻断主流程）。
    pub fn record(&self, level: &str, message: &str) {
        let timestamp = chrono_like_timestamp();
        let redacted = redact(message);
        let truncated: String = redacted.chars().take(MAX_ENTRY_BYTES).collect();
        let line = format!("{timestamp} {level} {truncated}\n");
        let mut entries = self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        entries.push(line.clone());
        let overflow = entries.len().saturating_sub(self.capacity);
        if overflow > 0 {
            entries.drain(..overflow);
        }
        drop(entries);

        let result = (|| -> std::io::Result<()> {
            if let Ok(metadata) = fs::metadata(self.log_file()) {
                if metadata.len() + line.len() as u64 > self.max_bytes {
                    self.rotate();
                }
            }
            let mut file = OpenOptions::new().create(true).append(true).open(self.log_file())?;
            if file.metadata()?.len() + line.len() as u64 > self.max_bytes {
                self.rotate();
                file = OpenOptions::new().create(true).append(true).open(self.log_file())?;
            }
            file.write_all(line.as_bytes())?;
            file.seek(SeekFrom::End(0))?;
            file.sync_all()
        })();
        if result.is_err() {
            // 内存快照仍在；文件失败不影响进程
        }
    }

    /// 最近条目快照（供"复制诊断信息"）。
    pub fn snapshot(&self) -> Vec<String> {
        let entries = self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        entries.clone()
    }
}

/// 无 chrono 依赖的时间戳：UTC ISO-8601 秒级。桌面壳日志不需要亚秒精度。
fn chrono_like_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = now.as_secs();
    let days = seconds / 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    let rem = seconds % 86_400;
    let hour = rem / 3600;
    let minute = (rem % 3600) / 60;
    let second = rem % 60;
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"
    )
}

/// 天数 → (年, 月, 日)：Howard Hinnant 的 civil_from_days 算法。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if month <= 2 { year + 1 } else { year };
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn corpus() -> Vec<(&'static str, &'static str)> {
        vec![
            ("ip", "sidecar listening on 127.0.0.1:3456 and 10.20.30.40"),
            ("hex-token", "bootstrap token 4f8f5a1c2b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0"),
            ("base64-session", "session id Kz8xQm9rTXlOcHZRd0Z2VGd5SmVuQzE0U2VjcmV0S2V5MTIzNDU2Nzg5"),
            ("env-assignment", "CC_FIX_GUI_TOKEN=super-secret-value-here"),
            ("key-assignment", "api_key=\"1234567890abcdefghij\""),
            ("cookie-assignment", "cookie=deadbeefdeadbeefdeadbeef"),
            // PEM 块由 concat! 编译期拼接：源码不含完整私钥块字面量（CI 密钥门禁扫描源码）。
            ("private-key", concat!("-----BEGIN ", "PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END ", "PRIVATE KEY-----")),
            // issue #54：截断 PEM（无 END 标记）、标准 base64（含 + /）、JSON 键值形态。
            ("truncated-private-key", concat!("-----BEGIN ", "PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC")),
            ("standard-base64-with-slash", "payload ABCDEFGHIJKLMNOP+qrstuvwxyz0123456789/ABCDEFGHIJ tail"),
            ("json-key-value", "\"api_key\": \"1234567890abcdefghij\""),
            ("json-nested", "{\"token\": \"a1b2c3d4e5f6a1b2c3d4e5f6\", \"mode\": \"standard\"}"),
        ]
    }

    #[test]
    fn redact_masks_all_seeded_secrets() {
        for (label, sample) in corpus() {
            let output = redact(sample);
            assert!(!output.contains("127.0.0.1"), "{label}: ip leaked");
            assert!(!output.contains("10.20.30.40"), "{label}: ip leaked");
            assert!(!output.contains("super-secret-value-here"), "{label}: env value leaked");
            assert!(!output.contains("1234567890abcdefghij"), "{label}: api key leaked");
            assert!(!output.contains("deadbeefdeadbeefdeadbeef"), "{label}: cookie leaked");
            assert!(!output.contains("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"), "{label}: private key leaked");
            assert!(!output.contains("Kz8xQm9rTXlOcHZRd0Z2VGd5SmVuQzE0U2VjcmV0S2V5MTIzNDU2Nzg5"), "{label}: session leaked");
            assert!(!output.contains("ABCDEFGHIJKLMNOP+qrstuvwxyz"), "{label}: standard base64 leaked");
            assert!(!output.contains("a1b2c3d4e5f6a1b2c3d4e5f6"), "{label}: json token leaked");
        }
    }

    #[test]
    fn redact_masks_json_and_truncated_pem_placeholders() {
        // JSON 形态：敏感键与值整体替换为 [redacted]，普通键保留（issue #54）。
        let json = redact("{\"api_key\": \"1234567890abcdefghij\", \"mode\": \"standard\"}");
        assert!(json.contains("[redacted]"));
        assert!(!json.contains("api_key"));
        assert!(json.contains("\"mode\": \"standard\""));
        // 截断 PEM：无 END 标记时替换至消息末尾（issue #54）。
        let truncated = redact(concat!("prefix -----BEGIN ", "PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC"));
        assert!(truncated.contains("prefix"));
        assert!(truncated.contains("[private key]"));
        assert!(!truncated.contains("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC"));
    }

    #[test]
    fn redact_keeps_benign_content() {
        let sample = "sidecar started; window created; mode=standard region=us";
        let output = redact(sample);
        assert!(output.contains("mode=standard"));
        assert!(output.contains("region=us"));
        assert!(output.contains("sidecar started"));
    }

    #[test]
    fn corpus_test_file_contains_no_seeded_secrets() {
        let directory = std::env::temp_dir().join(format!("cc-fix-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        let log = DiagnosticLog::new(directory.clone());
        for (_, sample) in corpus() {
            log.record("ERROR", sample);
        }
        drop(log);
        let mut content = String::new();
        File::open(directory.join(LOG_FILE_NAME))
            .expect("log file exists")
            .read_to_string(&mut content)
            .expect("readable");
        let _ = fs::remove_dir_all(&directory);
        for leaked in [
            "127.0.0.1",
            "10.20.30.40",
            "4f8f5a1c2b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0",
            "Kz8xQm9rTXlOcHZRd0Z2VGd5SmVuQzE0U2VjcmV0S2V5MTIzNDU2Nzg5",
            "super-secret-value-here",
            "1234567890abcdefghij",
            "deadbeefdeadbeefdeadbeef",
            "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
        ] {
            assert!(!content.contains(leaked), "seeded secret leaked into log: {leaked}");
        }
    }

    #[test]
    fn snapshot_keeps_recent_entries_bounded() {
        let directory = std::env::temp_dir().join(format!("cc-fix-log-snap-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        let log = DiagnosticLog::new(directory.clone());
        for index in 0..500 {
            log.record("INFO", &format!("snapshot entry {index}"));
        }
        let snapshot = log.snapshot();
        assert!(snapshot.len() <= 200, "snapshot must stay bounded");
        assert!(snapshot.last().is_some_and(|line| line.contains("snapshot entry 499")));
        assert!(!snapshot[0].contains("snapshot entry 0"));
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn rolling_rotates_at_size_limit() {
        let directory = std::env::temp_dir().join(format!("cc-fix-log-rotate-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        let log = DiagnosticLog::new(directory.clone()).with_max_bytes(2048);
        for index in 0..200 {
            log.record("INFO", &format!("rotating entry {index} with enough padding to exceed the small limit"));
        }
        drop(log);
        let current_exists = Path::new(&directory.join(LOG_FILE_NAME)).exists();
        let backup_exists = Path::new(&directory.join(LOG_BACKUP_NAME)).exists();
        assert!(current_exists);
        assert!(backup_exists, "rotation must produce desktop.log.1");
        if let Ok(metadata) = fs::metadata(directory.join(LOG_FILE_NAME)) {
            assert!(metadata.len() <= 4096, "current log must stay bounded after rotation");
        }
        let _ = fs::remove_dir_all(&directory);
    }
}
