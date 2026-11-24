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
    use windows::Win32::Foundation::{
        DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, HWND, S_OK,
    };
    use windows::Win32::System::Com::IDataObject;
    use windows::Win32::System::Ole::{
        DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, DROPEFFECT, DROPEFFECT_COPY,
        DROPEFFECT_LINK, DROPEFFECT_MOVE, DROPEFFECT_NONE,
    };
    use windows::Win32::System::SystemServices::{MK_LBUTTON, MK_RBUTTON, MODIFIERKEYS_FLAGS};
    use windows::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows::Win32::UI::Shell::{
        ILFindLastID, ILFree, IShellFolder, SHBindToParent, SHParseDisplayName,
    };

    /// 松开左键 → 投放；Esc → 取消。视觉反馈交给系统默认光标。
    /// cancel_on_right_button：拖动中按下右键也取消——OLE 拖拽期间页面收不到
    /// 键鼠事件，「右键取消拖拽」只能在原生侧实现；仅搜索结果拖拽开启此标志
    /// （窗格文件拖拽不传，右键行为不变，见 SearchPanel feat/search-drag）。
    #[implement(IDropSource)]
    struct DropSource {
        cancel_on_right_button: bool,
    }

    impl IDropSource_Impl for DropSource_Impl {
        fn QueryContinueDrag(
            &self,
            escape_pressed: BOOL,
            key_state: MODIFIERKEYS_FLAGS,
        ) -> HRESULT {
            if escape_pressed.as_bool() {
                return DRAGDROP_S_CANCEL;
            }
            if self.cancel_on_right_button && (key_state & MK_RBUTTON) == MK_RBUTTON {
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
            if let Err(e) =
                unsafe { SHParseDisplayName(PCWSTR(wide.as_ptr()), None, &mut pidl, 0, None) }
            {
                for done in owned.drain(..) {
                    unsafe { ILFree(Some(done as *const ITEMIDLIST)) };
                }
                return Err(format!("SHParseDisplayName({p}) 失败：{e}"));
            }
            owned.push(pidl);
        }
        let folder: IShellFolder =
            match unsafe { SHBindToParent(owned[0] as *const ITEMIDLIST, None) } {
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

    pub fn start(paths: &[String], cancel_on_right_button: bool) -> Result<u32, String> {
        // OLE 必须在发起线程初始化（DoDragDrop 要求）；已初始化时返回 S_FALSE 同样按可用处理。
        // 有意不配对 OleUninitialize——OLE 随线程常驻，与 GUI 线程惯例一致。
        if let Err(e) = unsafe { OleInitialize(None) } {
            return Err(format!("OleInitialize 失败（线程非 STA？）：{e}"));
        }
        let (data_object, pidls) = make_data_object(paths)?;
        let drop_source: IDropSource = DropSource {
            cancel_on_right_button,
        }
        .into();
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
            let paths: Vec<String> = [
                "rdir-drag-out-hdrop-test-1.txt",
                "rdir-drag-out-hdrop-test-2.txt",
            ]
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
            assert_eq!(
                hr, S_OK,
                "QueryGetData(CF_HDROP) 失败：{hr:?}——浏览器将收不到 Files"
            );
        }
    }
}

/// 发起原生拖出并阻塞到松手；返回最终投放效果（0 = 无目标/取消，1 = copy，2 = move，4 = 快捷方式）。
/// 空列表直接返回 0（前端启动时的能力探测，不进入拖拽循环）。
/// cancel_on_right_button：拖动中按下右键取消（仅搜索结果拖拽传 true，见 DropSource 注释）。
#[cfg(windows)]
pub fn start(paths: Vec<String>, cancel_on_right_button: bool) -> Result<u32, String> {
    if paths.is_empty() {
        return Ok(0);
    }
    imp::start(&paths, cancel_on_right_button)
}

/// 非 Windows/macOS 平台：原生拖出不可用（前端能力探测失败 → 回落 HTML5 拖出）。
#[cfg(not(any(windows, target_os = "macos")))]
pub fn start(_paths: Vec<String>, _cancel_on_right_button: bool) -> Result<u32, String> {
    Err("原生拖出仅支持 Windows / macOS".into())
}

#[cfg(target_os = "macos")]
pub use mac_imp::{arm_channel, start_main};

// ==================== macOS：NSDraggingSession 原生拖出（v0.52） ====================
//
// 为什么必须原生拖出：WKWebView 的 HTML5 file:// uri-list 拖出是纯文本载荷——
// WebKit 不会把它转成 NSFilenamesPboardType / public.file-url，Finder 只能收到
// 「文本剪辑」，Dock 废纸篓直接拒收（v0.52「拖到废纸篓无效」根因；URI 百分号
// 编码修复后依旧无效即证实了这条路走不通）。原生 NSDraggingSession 携带
// NSURL（file URL，AppKit 自动展开为 file-url + filenames 两类 pasteboard 类型），
// Dock 废纸篓按 Move 收投、Finder 按 Copy 收投，与从资源管理器类应用拖出一致。
//
// 投放回本窗口：WKWebView 对「外部发起」的 NSDragging 会合成 HTML5
// dragover/drop 事件（与从 Finder 拖入同一通路，dragDropEnabled=false 时走
// WebKit 默认 destination），应用内投放语义由前端 nativeDragOut 会话标记分流。
//
// 线程模型：beginDraggingSession 必须在主线程（lib.rs 经 run_on_main_thread
// 调入 start_main）；命令线程在 worker 上阻塞等 endedAtPoint（对齐 Windows
// DoDragDrop 的阻塞语义——前端 dragOutFiles 的 promise 收尾时机依赖它）。

#[cfg(target_os = "macos")]
mod mac_imp {
    use std::sync::mpsc;
    use std::sync::Mutex;

    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, ClassType, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource,
        NSEvent, NSEventModifierFlags, NSEventType, NSView,
    };
    use objc2_foundation::{NSArray, NSPoint, NSString, NSURL};

    /// 会话收尾信号：endedAtPoint 把最终 operation 送回阻塞的命令线程。
    /// 全应用同一时刻至多一个拖拽会话（单鼠标，与 Windows 阻塞模型一致）。
    static DRAG_TX: Mutex<Option<mpsc::Sender<u32>>> = Mutex::new(None);

    define_class!(
        // SAFETY:
        // - NSObject 无子类化要求。
        // - DragSource 不实现 Drop。
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "RDirDragSource"]
        struct DragSource;

        // SAFETY: `NSObjectProtocol` 无安全要求。
        unsafe impl NSObjectProtocol for DragSource {}

        // SAFETY: 签名与 AppKit 协议声明一致。
        unsafe impl NSDraggingSource for DragSource {
            // Copy + Move + Generic：Dock 废纸篓按 Move 收投，Finder 默认 Copy。
            // （required 协议方法，会话开始前逐目标询问。）
            #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
            fn dragging_session_source_operation_mask(
                &self,
                _session: &NSDraggingSession,
                _context: NSDraggingContext,
            ) -> NSDragOperation {
                NSDragOperation::Copy | NSDragOperation::Move | NSDragOperation::Generic
            }

            // SAFETY: 可选方法，松手/取消（operation=None）都会回调。
            #[unsafe(method(draggingSession:endedAtPoint:operation:))]
            fn dragging_session_ended_at_point_operation(
                &self,
                _session: &NSDraggingSession,
                _screen_point: NSPoint,
                operation: NSDragOperation,
            ) {
                if let Some(tx) = DRAG_TX.lock().ok().and_then(|mut s| s.take()) {
                    let _ = tx.send(operation.0 as u32);
                }
            }
        }
    );

    impl DragSource {
        /// 构造（类无 ivars，走 NSObject init）。
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = mtm.alloc::<Self>();
            // SAFETY: NSObject 的 init；无 ivars 的空类 init 不会失败
            let obj: Option<Retained<Self>> = unsafe { msg_send![this, init] };
            obj.expect("DragSource init 失败")
        }
    }

    /// 武装收尾通道（命令线程在发起前调用），返回 receiver 由命令线程持有等待。
    pub fn arm_channel() -> mpsc::Receiver<u32> {
        let (tx, rx) = mpsc::channel();
        if let Ok(mut s) = DRAG_TX.lock() {
            *s = Some(tx);
        }
        rx
    }

    /// 主线程发起拖拽会话。失败时给等待方回 0（无投放），命令线程不悬挂。
    pub fn start_main(paths: Vec<String>, ns_view: *mut std::ffi::c_void) {
        let build = || -> Result<(), String> {
            let mtm = MainThreadMarker::new().ok_or("拖出必须在主线程发起")?;
            // SAFETY: 指针来自 tauri ns_view()，窗口存续期内有效；仅主线程解引用
            let view = unsafe { Retained::<NSView>::retain(ns_view as *mut NSView) }
                .ok_or("ns_view 指针无效")?;

            let mut items: Vec<Retained<NSDraggingItem>> = Vec::with_capacity(paths.len());
            for p in &paths {
                let is_dir = std::path::Path::new(p).is_dir();
                let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(p), is_dir);
                // SAFETY: init 方法消费 alloc（AppKit 类默认 MainThreadOnly，
                // alloc 走 MainThreadMarker）；NSURL 实现了 NSPasteboardWriting
                let item = unsafe {
                    NSDraggingItem::initWithPasteboardWriter(
                        mtm.alloc(),
                        &ProtocolObject::from_ref(&*url),
                    )
                };
                items.push(item);
            }
            let items_arr = NSArray::from_retained_slice(&items);

            let source = DragSource::new(mtm);
            let source_obj = ProtocolObject::from_ref(&*source);

            // 合成鼠标拖动事件作为会话起点（AppKit 要求携带 NSEvent）；
            // 位置取当前鼠标全局坐标，windowNumber 取目标视图所在窗口。
            let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                NSEventType::LeftMouseDragged,
                NSEvent::mouseLocation(),
                NSEventModifierFlags::empty(),
                0.0,
                view.window().map(|w| w.windowNumber()).unwrap_or(0),
                None,
                0,
                0,
                0.0,
            )
            .ok_or("合成拖拽事件失败")?;

            view.beginDraggingSessionWithItems_event_source(&items_arr, &event, source_obj);
            Ok(())
        };
        if let Err(e) = build() {
            if let Some(tx) = DRAG_TX.lock().ok().and_then(|mut s| s.take()) {
                let _ = tx.send(0);
            }
            eprintln!("[rdir] 原生拖出发起失败：{e}");
        }
    }
}

/// 修饰键实时状态（v0.34）。Windows 上启用 Tauri 原生拖放后（tauri.windows.conf.json
/// `dragDropEnabled: true`）拖放事件不再携带按键状态——应用内拖出「按住 Alt = 移动」
/// 改为投放时查询。GetAsyncKeyState 可在任意线程调用。
#[derive(serde::Serialize, Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Modifiers {
    pub alt: bool,
    pub ctrl: bool,
    pub shift: bool,
}

#[cfg(windows)]
pub fn modifiers() -> Modifiers {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_MENU, VK_SHIFT,
    };
    let down = |vk: u16| unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 };
    Modifiers {
        alt: down(VK_MENU.0),
        ctrl: down(VK_CONTROL.0),
        shift: down(VK_SHIFT.0),
    }
}

/// 非 Windows：HTML5 拖放事件自带 altKey，这里恒返回未按下。
#[cfg(not(windows))]
pub fn modifiers() -> Modifiers {
    Modifiers::default()
}
