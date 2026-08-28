#![cfg_attr(not(windows), allow(dead_code))]

#[cfg(windows)]
mod windows_helper {
    use std::ffi::{OsStr, c_void};
    use std::fs::File;
    use std::io::{self, Read};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
        FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
        FileAttributeTagInfo, FileDispositionInfo, GetFileInformationByHandleEx, OPEN_EXISTING,
        SetFileInformationByHandle,
    };

    const OBJ_CASE_INSENSITIVE: u32 = 0x40;
    const OBJ_DONT_REPARSE: u32 = 0x1000;
    const FILE_OPEN: u32 = 1;
    const FILE_NON_DIRECTORY_FILE: u32 = 0x40;
    const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x20;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const SYNCHRONIZE: u32 = 0x0010_0000;

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *mut u16,
    }

    #[repr(C)]
    struct ObjectAttributes {
        length: u32,
        root_directory: HANDLE,
        object_name: *mut UnicodeString,
        attributes: u32,
        security_descriptor: *mut c_void,
        security_quality_of_service: *mut c_void,
    }

    #[repr(C)]
    union IoStatusUnion {
        status: i32,
        pointer: *mut c_void,
    }

    #[repr(C)]
    struct IoStatusBlock {
        value: IoStatusUnion,
        information: usize,
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtCreateFile(
            file_handle: *mut HANDLE,
            desired_access: u32,
            object_attributes: *mut ObjectAttributes,
            io_status_block: *mut IoStatusBlock,
            allocation_size: *mut i64,
            file_attributes: u32,
            share_access: u32,
            create_disposition: u32,
            create_options: u32,
            ea_buffer: *mut c_void,
            ea_length: u32,
        ) -> i32;
    }

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }

    fn open_root(path: &Path) -> io::Result<HANDLE> {
        let value = wide(path.as_os_str());
        let handle = unsafe {
            CreateFileW(
                value.as_ptr(),
                FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        reject_reparse(handle)
            .map_err(|error| io::Error::new(error.kind(), format!("root attributes: {error}")))?;
        Ok(handle)
    }

    fn reject_reparse(handle: HANDLE) -> io::Result<()> {
        let mut info = FILE_ATTRIBUTE_TAG_INFO {
            FileAttributes: 0,
            ReparseTag: 0,
        };
        let ok = unsafe {
            GetFileInformationByHandleEx(
                handle,
                FileAttributeTagInfo,
                &mut info as *mut _ as *mut c_void,
                std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "reparse point rejected",
            ));
        }
        Ok(())
    }

    fn open_relative(root: HANDLE, file_name: &str) -> io::Result<HANDLE> {
        if file_name.is_empty()
            || file_name.contains(['\\', '/', ':'])
            || file_name == "."
            || file_name == ".."
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid fixed file name",
            ));
        }
        let mut name = wide(OsStr::new(file_name));
        let byte_length = ((name.len() - 1) * 2)
            .try_into()
            .map_err(|_| io::ErrorKind::InvalidInput)?;
        let mut unicode = UnicodeString {
            length: byte_length,
            maximum_length: byte_length,
            buffer: name.as_mut_ptr(),
        };
        let mut attributes = ObjectAttributes {
            length: std::mem::size_of::<ObjectAttributes>() as u32,
            root_directory: root,
            object_name: &mut unicode,
            attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
            security_descriptor: null_mut(),
            security_quality_of_service: null_mut(),
        };
        let mut status = IoStatusBlock {
            value: IoStatusUnion { status: 0 },
            information: 0,
        };
        let mut handle: HANDLE = null_mut();
        let result = unsafe {
            NtCreateFile(
                &mut handle,
                GENERIC_READ | DELETE | SYNCHRONIZE,
                &mut attributes,
                &mut status,
                null_mut(),
                0,
                FILE_SHARE_READ,
                FILE_OPEN,
                FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
                null_mut(),
                0,
            )
        };
        if result < 0 {
            return Err(io::Error::from_raw_os_error(result));
        }
        reject_reparse(handle)
            .map_err(|error| io::Error::new(error.kind(), format!("file attributes: {error}")))?;
        Ok(handle)
    }

    pub fn compare_delete(
        root: &Path,
        file_name: &str,
        expected: &[u8],
    ) -> io::Result<&'static str> {
        if file_name.is_empty()
            || file_name.contains(['\\', '/', ':'])
            || file_name == "."
            || file_name == ".."
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid fixed file name",
            ));
        }
        let root_handle = open_root(root)
            .map_err(|error| io::Error::new(error.kind(), format!("open root: {error}")))?;
        let file_handle = match open_relative(root_handle, file_name) {
            Ok(handle) => handle,
            Err(error) => {
                unsafe {
                    CloseHandle(root_handle);
                }
                // NTSTATUS values do not map losslessly through io::Error. A
                // missing file is also accepted after a direct metadata check.
                if !root.join(file_name).exists() {
                    return Ok("missing");
                }
                return Err(io::Error::new(
                    error.kind(),
                    format!("open relative: {error}"),
                ));
            }
        };
        unsafe {
            CloseHandle(root_handle);
        }
        let mut file = unsafe { File::from_raw_handle(file_handle as RawHandle) };
        let mut actual = Vec::new();
        file.read_to_end(&mut actual)
            .map_err(|error| io::Error::new(error.kind(), format!("read file: {error}")))?;
        if actual != expected {
            return Ok("mismatch");
        }
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        let ok = unsafe {
            SetFileInformationByHandle(
                file_handle,
                FileDispositionInfo,
                &disposition as *const _ as *const c_void,
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        drop(file);
        Ok("deleted")
    }

    #[cfg(test)]
    mod tests {
        use crate::{MAX_STDIN_BYTES, read_expected_limited};
        use super::compare_delete;
        use std::fs;
        use std::time::{SystemTime, UNIX_EPOCH};

        fn root() -> std::path::PathBuf {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path =
                std::env::temp_dir().join(format!("cc-fix-helper-{}-{unique}", std::process::id()));
            fs::create_dir(&path).unwrap();
            path
        }

        #[test]
        fn compares_exact_bytes_and_deletes_through_the_same_handle() {
            let root = root();
            let path = root.join("persist-backup.json");
            fs::write(&path, b"checked envelope\n").unwrap();
            assert_eq!(
                compare_delete(&root, "persist-backup.json", b"wrong").unwrap(),
                "mismatch"
            );
            assert!(path.exists());
            assert_eq!(
                compare_delete(&root, "persist-backup.json", b"checked envelope\n").unwrap(),
                "deleted"
            );
            assert!(!path.exists());
            assert_eq!(
                compare_delete(&root, "persist-backup.json", b"checked envelope\n").unwrap(),
                "missing"
            );
            fs::remove_dir(root).unwrap();
        }

        #[test]
        fn rejects_non_literal_child_names() {
            let root = root();
            assert!(compare_delete(&root, "..\\outside", b"x").is_err());
            fs::remove_dir(root).unwrap();
        }

        #[test]
        fn accepts_bounded_stdin_and_rejects_oversized_input() {
            let ok = read_expected_limited(&mut b"small envelope".as_slice()).unwrap();
            assert_eq!(ok, b"small envelope");
            let oversized = vec![0u8; MAX_STDIN_BYTES + 1];
            assert!(read_expected_limited(&mut oversized.as_slice()).is_err());
        }
    }
}

fn main() {
    #[cfg(not(windows))]
    {
        eprintln!("cc-fix-native-helper supports Windows only");
        std::process::exit(2);
    }
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.len() != 4
            || args[1] != "compare-delete"
            || !matches!(
                args[3].as_str(),
                "persist-backup.json" | "persist-backup.json.prev"
            )
        {
            eprintln!("usage: cc-fix-native-helper compare-delete <root> <fixed-backup-name>");
            std::process::exit(2);
        }
        let expected = match read_expected_limited(&mut std::io::stdin().lock()) {
            Ok(bytes) => bytes,
            Err(message) => {
                eprintln!("stdin: {message}");
                std::process::exit(3);
            }
        };
        match windows_helper::compare_delete(std::path::Path::new(&args[2]), &args[3], &expected) {
            Ok(result) => println!("{result}"),
            Err(error) => {
                eprintln!("compare-delete: {error}");
                std::process::exit(4);
            }
        }
    }
}

/// 有界 stdin 读取（#62）：compare-delete 的期望字节上限 16MB，超过即拒绝，
/// 防止畸形/异常输入被读入内存放大（防护纵深；调用方本就只写 ~KB 级备份）。
const MAX_STDIN_BYTES: usize = 16 * 1024 * 1024;

fn read_expected_limited<R: std::io::Read>(reader: &mut R) -> Result<Vec<u8>, &'static str> {
    use std::io::Read as _;
    let mut expected = Vec::new();
    reader
        .take((MAX_STDIN_BYTES + 1) as u64)
        .read_to_end(&mut expected)
        .map_err(|_| "read failed")?;
    if expected.len() > MAX_STDIN_BYTES {
        return Err("exceeds the 16MB limit");
    }
    Ok(expected)
}
