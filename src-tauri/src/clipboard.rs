//! 系统剪贴板「文件列表」格式读写，用于与资源管理器 / Finder 跨应用复制粘贴。
//!
//! - macOS：NSPasteboard `public.file-url`（objc2）
//! - Windows：CF_HDROP（clipboard-win）
//! - 其他平台：暂不支持，读返回空、写为 no-op
//!   ponytail: Linux 需 xclip/wl-copy 等外部工具且 Wayland/X11 差异大，需要时再补。

/// 把一批文件路径写入系统剪贴板（供其他应用粘贴）。
pub fn write_file_list(paths: &[String]) -> Result<(), String> {
    imp::write_file_list(paths)
}

/// 从系统剪贴板读取文件路径列表；无文件时返回空 Vec。
pub fn read_file_list() -> Result<Vec<String>, String> {
    imp::read_file_list()
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::ClassType;
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};

    pub fn write_file_list(paths: &[String]) -> Result<(), String> {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        let objs: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = paths
            .iter()
            .map(|p| {
                let url = NSURL::fileURLWithPath(&NSString::from_str(p));
                ProtocolObject::from_retained(url)
            })
            .collect();
        let arr = NSArray::from_retained_slice(&objs);
        if !pb.writeObjects(&arr) {
            return Err("写入系统剪贴板失败".into());
        }
        Ok(())
    }

    pub fn read_file_list() -> Result<Vec<String>, String> {
        // SAFETY: NSPasteboard 可在任意线程访问；返回数组元素按 NSURL 读取。
        unsafe {
            let pb = NSPasteboard::generalPasteboard();
            let classes = NSArray::from_slice(&[NSURL::class()]);
            let Some(objs) = pb.readObjectsForClasses_options(&classes, None) else {
                return Ok(Vec::new());
            };
            let mut out = Vec::new();
            for i in 0..objs.count() {
                let obj = objs.objectAtIndex(i);
                if let Some(url) = obj.downcast_ref::<NSURL>() {
                    if let Some(p) = url.path() {
                        out.push(p.to_string());
                    }
                }
            }
            Ok(out)
        }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use clipboard_win::{formats, Clipboard, Format, Getter, Setter};

    pub fn write_file_list(paths: &[String]) -> Result<(), String> {
        // Clipboard 需在操作期间保持打开
        let _clip = Clipboard::new_attempts(10).map_err(|e| e.to_string())?;
        formats::FileList
            .write_clipboard(paths)
            .map_err(|e| format!("写入系统剪贴板失败：{e}"))
    }

    pub fn read_file_list() -> Result<Vec<String>, String> {
        if !formats::FileList.is_format_avail() {
            return Ok(Vec::new());
        }
        let _clip = Clipboard::new_attempts(10).map_err(|e| e.to_string())?;
        let mut out: Vec<String> = Vec::new();
        formats::FileList
            .read_clipboard(&mut out)
            .map_err(|e| format!("读取系统剪贴板失败：{e}"))?;
        Ok(out)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    pub fn write_file_list(_paths: &[String]) -> Result<(), String> {
        Ok(())
    }
    pub fn read_file_list() -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    #[ignore = "会覆盖系统剪贴板，需 cargo test -- --ignored 显式运行"]
    fn clipboard_roundtrip_macos() {
        let dir = std::env::temp_dir().join(format!("rdir-clip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("clip.txt");
        std::fs::write(&f, "x").unwrap();
        let p = f.to_string_lossy().to_string();
        write_file_list(std::slice::from_ref(&p)).unwrap();
        let got = read_file_list().unwrap();
        assert!(got.contains(&p), "读回应包含 {p}，实际 {got:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
