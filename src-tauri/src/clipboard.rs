//! 系统剪贴板「文件列表」格式读写，用于与资源管理器 / Finder 跨应用复制粘贴。
//!
//! - macOS：NSPasteboard `public.file-url`（objc2）
//! - Windows：CF_HDROP（clipboard-win）+ `Preferred DropEffect` 剪切标志
//! - 其他平台：暂不支持，读返回空、写为 no-op
//!   ponytail: Linux 需 xclip/wl-copy 等外部工具且 Wayland/X11 差异大，需要时再补。

/// 系统剪贴板中的文件列表及语义标志
pub struct ClipboardFiles {
    pub paths: Vec<String>,
    /// true = 剪切（移动语义）：粘贴方完成移动后应删除源；资源管理器同理
    pub cut: bool,
}

/// 把一批文件路径写入系统剪贴板（供其他应用粘贴）；cut=true 表示剪切。
pub fn write_file_list(paths: &[String], cut: bool) -> Result<(), String> {
    imp::write_file_list(paths, cut)
}

/// 从系统剪贴板读取文件列表；无文件时返回空 paths。
pub fn read_file_list() -> Result<ClipboardFiles, String> {
    imp::read_file_list()
}

/// 清空系统剪贴板（消费外部剪切后调用，与资源管理器行为一致）
pub fn clear() {
    imp::clear();
}

#[cfg(target_os = "macos")]
mod imp {
    use super::ClipboardFiles;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::ClassType;
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};

    pub fn write_file_list(paths: &[String], _cut: bool) -> Result<(), String> {
        // macOS Finder 不支持文件剪切，cut 标记无处安放，忽略
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

    pub fn read_file_list() -> Result<ClipboardFiles, String> {
        // SAFETY: NSPasteboard 可在任意线程访问；返回数组元素按 NSURL 读取。
        unsafe {
            let pb = NSPasteboard::generalPasteboard();
            let classes = NSArray::from_slice(&[NSURL::class()]);
            let Some(objs) = pb.readObjectsForClasses_options(&classes, None) else {
                return Ok(ClipboardFiles {
                    paths: Vec::new(),
                    cut: false,
                });
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
            Ok(ClipboardFiles { paths: out, cut: false })
        }
    }

    pub fn clear() {
        NSPasteboard::generalPasteboard().clearContents();
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::ClipboardFiles;
    use clipboard_win::{formats, raw, Clipboard, Format, Getter, Setter};

    /// DROPEFFECT_MOVE / DROPEFFECT_COPY（shellapi.h）
    const DROPEFFECT_MOVE: u32 = 2;
    const DROPEFFECT_COPY: u32 = 1;
    /// 剪切标志所在注册格式：Explorer 写 Preferred，部分旧程序只认 DropEffect
    const DROP_EFFECT_FORMATS: [&str; 2] = ["Preferred DropEffect", "DropEffect"];

    pub fn write_file_list(paths: &[String], cut: bool) -> Result<(), String> {
        // Clipboard 需在操作期间保持打开
        let _clip = Clipboard::new_attempts(10).map_err(|e| e.to_string())?;
        // FileList setter 不清空剪贴板，先手动清，避免上一次的 DropEffect 等旧格式残留
        let _ = raw::empty();
        formats::FileList
            .write_clipboard(paths)
            .map_err(|e| format!("写入系统剪贴板失败：{e}"))?;
        // 剪切语义：写 DropEffect（DWORD，小端）。缺了它资源管理器会把剪切当复制。
        let bytes = (if cut { DROPEFFECT_MOVE } else { DROPEFFECT_COPY }).to_le_bytes();
        for name in DROP_EFFECT_FORMATS {
            if let Some(fmt) = clipboard_win::register_format(name) {
                let _ = raw::set_without_clear(fmt.get(), &bytes);
            }
        }
        Ok(())
    }

    pub fn read_file_list() -> Result<ClipboardFiles, String> {
        if !formats::FileList.is_format_avail() {
            return Ok(ClipboardFiles {
                paths: Vec::new(),
                cut: false,
            });
        }
        let _clip = Clipboard::new_attempts(10).map_err(|e| e.to_string())?;
        let mut out: Vec<String> = Vec::new();
        formats::FileList
            .read_clipboard(&mut out)
            .map_err(|e| format!("读取系统剪贴板失败：{e}"))?;
        Ok(ClipboardFiles {
            paths: out,
            cut: read_cut_flag(),
        })
    }

    /// 读 DropEffect 注册格式，含 MOVE 位则视为剪切；读不到按复制处理。
    fn read_cut_flag() -> bool {
        for name in DROP_EFFECT_FORMATS {
            let Some(fmt) = clipboard_win::register_format(name) else {
                continue;
            };
            if !clipboard_win::is_format_avail(fmt.get()) {
                continue;
            }
            let mut buf: Vec<u8> = Vec::new();
            if formats::RawData(fmt.get()).read_clipboard(&mut buf).is_ok() && buf.len() >= 4 {
                let effect = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
                if effect & DROPEFFECT_MOVE != 0 {
                    return true;
                }
            }
        }
        false
    }

    pub fn clear() {
        if let Ok(clip) = Clipboard::new_attempts(10) {
            let _ = raw::empty();
            drop(clip);
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    use super::ClipboardFiles;

    pub fn write_file_list(_paths: &[String], _cut: bool) -> Result<(), String> {
        Ok(())
    }
    pub fn read_file_list() -> Result<ClipboardFiles, String> {
        Ok(ClipboardFiles {
            paths: Vec::new(),
            cut: false,
        })
    }
    pub fn clear() {}
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
        write_file_list(std::slice::from_ref(&p), false).unwrap();
        let got = read_file_list().unwrap();
        assert!(got.paths.contains(&p), "读回应包含 {p}，实际 {:?}", got.paths);
        assert!(!got.cut);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
