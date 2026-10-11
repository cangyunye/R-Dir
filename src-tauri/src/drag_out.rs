//! 原生拖出（Windows）：携带 CF_HDROP 文件引用发起 OLE 拖拽，浏览器上传投放区、
//! 资源管理器等外部应用即可像接收资源管理器拖出的文件一样接收。
//!
//! 背景：HTML5 dragstart 的 dataTransfer 只能放文本格式，WebView2 转成 OLE 拖拽后
//! 不带 CF_HDROP，外部一律按纯文本拒收（浏览器上传区检查 Files）。必须由原生侧
//! 发起拖拽。macOS 走 WKWebView 的 HTML5 file:// uri-list 路径，不经这里。
//!
//! 线程约束：Tauri v2 同步命令在主线程执行（tao/wry 已把主线程初始化为 COM STA），
//! DoDragDrop 自带模态消息循环，期间 UI 正常刷新；命令返回即拖拽结束。

#[cfg(windows)]
mod imp {
    use windows::core::{implement, BOOL, HRESULT, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, HWND, S_OK};
    use windows::Win32::System::Com::IDataObject;
    use windows::Win32::System::Ole::{
        DoDragDrop, DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_LINK, DROPEFFECT_MOVE, DROPEFFECT_NONE,
        IDropSource, IDropSource_Impl, OleInitialize,
    };
    use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
    use windows::Win32::UI::Shell::{
        ILFindLastID, ILFree, SHBindToParent, SHParseDisplayName, IShellFolder,
    };
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;

    /// 松开左键 → 投放；Esc → 取消。视觉反馈交给系统默认光标。
    #[implement(IDropSource)]
    struct DropSource;

    impl IDropSource_Impl for DropSource_Impl {
        fn QueryContinueDrag(&self, escape_pressed: BOOL, key_state: MODIFIERKEYS_FLAGS) -> HRESULT {
            if escape_pressed.as_bool() {
                return DRAGDROP_S_CANCEL;
            }
            if (key_state & MK_LBUTTON) != MK_LBUTTON {
                return DRAGDROP_S_DROP;
            }
            S_OK
        }

        fn GiveFeedback(&self, _effect: DROPEFFECT) -> HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    /// 把路径解析为 PIDL，再向父文件夹要"文件数据对象"——与资源管理器拖出同源，
    /// 天然携带 CF_HDROP / FILEDESCRIPTOR（浏览器上传投放区即按 CF_HDROP 识别文件；
    /// 实测 SHCreateDataObject(None, 绝对 PIDL) 只有 IDList 格式，不带 CF_HDROP）。
    /// 拖出项必来自同一目录（单窗格选中集），以首项定位父文件夹；
    /// ILFindLastID 返回的相对 PIDL 指向各绝对 PIDL 内部，随其生命周期有效。
    fn make_data_object(paths: &[String]) -> Result<(IDataObject, Vec<*mut ITEMIDLIST>), String> {
        let mut owned: Vec<*mut ITEMIDLIST> = Vec::with_capacity(paths.len());
        for p in paths {
            let wide = HSTRING::from(p);
            let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
            if let Err(e) = unsafe { SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut pidl, 0, None) } {
                for done in owned.drain(..) {
                    unsafe { ILFree(Some(done as *const ITEMIDLIST)) };
                }
                return Err(format!("SHParseDisplayName({p}) 失败：{e}"));
            }
            owned.push(pidl);
        }
        let folder: IShellFolder = match unsafe { SHBindToParent(owned[0] as *const ITEMIDLIST, None) } {
            Ok(f) => f,
            Err(e) => {
                for p in owned.drain(..) {
                    unsafe { ILFree(Some(p as *const ITEMIDLIST)) };
                }
                return Err(format!("SHBindToParent 失败：{e}"));
            }
        };
        let rels: Vec<*const ITEMIDLIST> = owned
            .iter()
            .map(|p| unsafe { ILFindLastID(*p as *const ITEMIDLIST) } as *const ITEMIDLIST)
            .collect();
        match unsafe { folder.GetUIObjectOf(HWND::default(), &rels, None) } {
            Ok(obj) => Ok((obj, owned)),
            Err(e) => {
                for p in owned.drain(..) {
                    unsafe { ILFree(Some(p as *const ITEMIDLIST)) };
                }
                Err(format!("GetUIObjectOf(IDataObject) 失败：{e}"))
            }
        }
    }

    pub fn start(paths: &[String]) -> Result<u32, String> {
        // OLE 必须在发起线程初始化（DoDragDrop 要求）；已初始化时返回 S_FALSE 同样按可用处理。
        // 有意不配对 OleUninitialize——OLE 随线程常驻，与 GUI 线程惯例一致。
        if let Err(e) = unsafe { OleInitialize(None) } {
            return Err(format!("OleInitialize 失败（线程非 STA？）：{e}"));
        }
        let (data_object, pidls) = make_data_object(paths)?;
        let drop_source: IDropSource = DropSource.into();
        let mut effect = DROPEFFECT_NONE;
        unsafe {
            // DRAGDROP_S_DROP / DRAGDROP_S_CANCEL 也是成功级 HRESULT，ok() 视为正常结束；
            // 最终以 effect 为准
            if let Err(e) = DoDragDrop(
                &data_object,
                &drop_source,
                DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK,
                &mut effect,
            )
            .ok()
            {
                for p in pidls {
                    ILFree(Some(p as *const ITEMIDLIST));
                }
                return Err(format!("DoDragDrop 失败：{e}"));
            }
            for p in pidls {
                ILFree(Some(p as *const ITEMIDLIST));
            }
        }
        Ok(effect.0)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::Win32::System::Com::{
            CoInitializeEx, COINIT_APARTMENTTHREADED, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL,
        };
        use windows::Win32::System::Ole::CF_HDROP;

        /// 浏览器上传投放区靠 CF_HDROP 识别"文件拖拽"——数据对象必须暴露该格式。
        /// DoDragDrop 需要真实鼠标输入，无法在测试里驱动，这里直接验证数据对象本身。
        /// 多文件用例同时验证"同一父文件夹 + 各项相对 PIDL"的组合。
        #[test]
        fn data_object_exposes_hdrop() {
            unsafe {
                let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                assert!(hr.is_ok(), "CoInitializeEx 失败：{hr:?}");
            }
            let dir = std::env::temp_dir();
            let paths: Vec<String> = ["rdir-drag-out-hdrop-test-1.txt", "rdir-drag-out-hdrop-test-2.txt"]
                .iter()
                .map(|n| {
                    let p = dir.join(n);
                    std::fs::write(&p, b"drag-out test").unwrap();
                    p.to_string_lossy().into_owned()
                })
                .collect();
            let (obj, pidls) = make_data_object(&paths).expect("构造数据对象失败");
            let fmt = FORMATETC {
                cfFormat: CF_HDROP.0,
                ptd: std::ptr::null_mut(),
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
            };
            let hr = unsafe { obj.QueryGetData(&fmt) };
            for pidl in pidls {
                unsafe { ILFree(Some(pidl)) };
            }
            paths.iter().for_each(|p| {
                let _ = std::fs::remove_file(p);
            });
            assert_eq!(hr, S_OK, "QueryGetData(CF_HDROP) 失败：{hr:?}——浏览器将收不到 Files");
        }
    }
}

/// 发起原生拖出并阻塞到松手；返回最终投放效果（0 = 无目标/取消，1 = copy，2 = move，4 = 快捷方式）。
/// 空列表直接返回 0（前端启动时的能力探测，不进入拖拽循环）。
#[cfg(windows)]
pub fn start(paths: Vec<String>) -> Result<u32, String> {
    if paths.is_empty() {
        return Ok(0);
    }
    imp::start(&paths)
}

/// 非 Windows 平台：macOS 走 HTML5 file:// uri-list 拖出，本命令仅被能力探测调用。
#[cfg(not(windows))]
pub fn start(_paths: Vec<String>) -> Result<u32, String> {
    Err("原生拖出仅支持 Windows（macOS 走 HTML5 拖出）".into())
}
