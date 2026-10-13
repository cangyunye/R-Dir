//! 画廊模式缩略图（v0.27.0）：本地文件 → 缩放 PNG → base64 data URL。
//!
//! 两条生成路径：
//! - 图片（png/jpg/gif/webp/bmp/tiff）：`image` crate 解码 + 缩放，跨平台；
//! - PDF / 视频 / Office 文档（macOS）：系统 QuickLook（`QLThumbnailGenerator`），
//!   系统能预览的都能出图（PDF 首页、视频帧、文档封面），失败回退 None。
//!
//! 结果按「路径+mtime+尺寸」哈希缓存到 app_data_dir/thumbs/，返回 base64
//! data URL（不启用 asset protocol、不改 capabilities 权限面）。生成在阻塞
//! 线程执行（tauri::async_runtime）不卡主线程；不支持的格式返回 None，前端
//! 回退大类型图标。SFTP 远程文件先回退类型图标（下载链路后续版本再接）。

use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use tauri::Manager;

/// image crate 可解码的扩展名（gif 取第一帧）
fn image_ext(ext: &str) -> bool {
    matches!(ext, "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tiff" | "tif")
}

/// 走系统 QuickLook 的扩展名（macOS）：系统能预览的都能出缩略图
/// （PDF 首页、视频帧、Office/iWork 文档封面……）。失败/未装预览器 → None 回退图标。
#[cfg(target_os = "macos")]
fn ql_ext(ext: &str) -> bool {
    matches!(
        ext,
        "pdf"
            | "mp4" | "mkv" | "mov" | "avi" | "webm" | "flv" | "m4v" | "wmv" | "ts"
            | "doc" | "docx" | "odt" | "rtf"
            | "xls" | "xlsx" | "ods"
            | "ppt" | "pptx" | "odp"
    )
}

/// 非 macOS：无 QuickLook 路径，仅图片格式出缩略图（与 ql_thumb 桩对称）
#[cfg(not(target_os = "macos"))]
fn ql_ext(_ext: &str) -> bool {
    false
}

/// 缓存文件名：64 位哈希（路径|mtime|尺寸）。哈希碰撞只导致缩略图串图
/// （同目录同尺寸概率极低），不影响数据安全。
fn cache_path(dir: &PathBuf, path: &str, mtime: i64, size: u32) -> PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    mtime.hash(&mut hasher);
    size.hash(&mut hasher);
    dir.join(format!("{:016x}.png", hasher.finish()))
}

/// 检查路径是否可出缩略图（本地 + 扩展名支持）。
pub fn thumb_eligible(path: &str) -> bool {
    if !std::path::Path::new(path).is_absolute() {
        return false; // sftp://、http://、tags:// 等虚拟路径一律不走本地解码
    }
    let ext = std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    image_ext(&ext) || ql_ext(&ext)
}

/// 取缩略图 data URL；失败/不支持返回 Ok(None)（前端回退类型图标）。
#[tauri::command]
pub async fn thumb_get(
    app: tauri::AppHandle,
    path: String,
    size: u32,
) -> Result<Option<String>, String> {
    if !thumb_eligible(&path) {
        return Ok(None);
    }
    let size = size.clamp(32, 512);
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?
        .join("thumbs");
    tauri::async_runtime::spawn_blocking(move || thumb_blocking(dir, path, size))
        .await
        .map_err(|e| format!("缩略图任务失败: {e}"))?
}

fn thumb_blocking(cache_dir: PathBuf, path: String, size: u32) -> Result<Option<String>, String> {
    use base64::Engine as _;

    let p = std::path::Path::new(&path);
    let meta = match std::fs::metadata(p) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    if !meta.is_file() {
        return Ok(None);
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("无法创建缓存目录: {e}"))?;
    let cached = cache_path(&cache_dir, &path, mtime, size);
    let png_bytes = match std::fs::read(&cached) {
        Ok(b) => b,
        Err(_) => {
            let ext = p
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            let out = if image_ext(&ext) {
                image_thumb(p, size)
            } else {
                ql_thumb(p, size)
            };
            let Some(out) = out else { return Ok(None) };
            // 原子写缓存：写临时文件后改名
            let tmp = cached.with_extension("tmp");
            if std::fs::write(&tmp, &out).is_ok() {
                let _ = std::fs::rename(&tmp, &cached);
            }
            out
        }
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(png_bytes);
    Ok(Some(format!("data:image/png;base64,{b64}")))
}

/// 图片：image crate 解码 → 等比内切缩放 → PNG。
fn image_thumb(p: &std::path::Path, size: u32) -> Option<Vec<u8>> {
    let img = image::open(p).ok()?; // 解码失败（损坏/伪扩展名）→ 静默回退
    let thumb = img.thumbnail(size, size);
    let mut out = Vec::new();
    thumb
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    Some(out)
}

/// QuickLook 路径（仅 macOS）：系统为可预览文件生成缩略图，转 PNG 字节。
#[cfg(target_os = "macos")]
fn ql_thumb(path: &std::path::Path, size: u32) -> Option<Vec<u8>> {
    ql::ql_thumb_png(&path.to_string_lossy(), size)
}

#[cfg(not(target_os = "macos"))]
fn ql_thumb(_path: &std::path::Path, _size: u32) -> Option<Vec<u8>> {
    None // 非 macOS：PDF/视频/文档暂不出缩略图，回退类型图标
}

#[cfg(target_os = "macos")]
mod ql {
    //! QLThumbnailGenerator 桥接：异步回调经 channel 转同步；
    //! `saveBestRepresentation...` 直接把缩略图落成 PNG 临时文件再读回。
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_core_foundation::CGSize;
    use objc2_foundation::{NSError, NSString, NSURL};
    use objc2_quick_look_thumbnailing::{
        QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes,
        QLThumbnailGenerator,
    };
    use objc2_uniform_type_identifiers::UTType;


    /// 生成缩略图 PNG；系统无法预览（损坏/无预览器）返回 None。
    pub fn ql_thumb_png(path: &str, size: u32) -> Option<Vec<u8>> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        // SAFETY: QLThumbnailGenerator 线程安全（回调在系统队列）；
        // 生成结果经 saveBestRepresentation 写入临时 PNG，回调只带 NSError。
        let url_ref: &NSURL = &url;
        let request: Retained<QLThumbnailGenerationRequest> = unsafe {
            objc2::msg_send![
                QLThumbnailGenerationRequest::alloc(),
                initWithFileAtURL: url_ref,
                size: CGSize::new(size as f64, size as f64),
                scale: 1.0_f64,
                representationTypes: QLThumbnailGenerationRequestRepresentationTypes::All,
            ]
        };
        let generator = unsafe { QLThumbnailGenerator::sharedGenerator() };
        let out_path: PathBuf = std::env::temp_dir()
            .join(format!("rdir-thumb-{}-{}.png", std::process::id(), size));
        let _ = std::fs::remove_file(&out_path);
        let out_url =
            NSURL::fileURLWithPath(&NSString::from_str(out_path.to_str().expect("temp path")));
        let png_type = UTType::typeWithIdentifier(&NSString::from_str("public.png"))?;
        let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
        let out_path_for_block = out_path.clone();
        let block = RcBlock::new(move |_error: *mut NSError| {
            let _ = tx.send(std::fs::read(&out_path_for_block).ok());
        });
        unsafe {
            generator.saveBestRepresentationForRequest_toFileAtURL_asContentType_completionHandler(
                &request,
                &out_url,
                &png_type,
                &block,
            );
        }
        let bytes = rx.recv_timeout(Duration::from_secs(8)).ok().flatten();
        let _ = std::fs::remove_file(&out_path);
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 手工构造一份最小合法 PDF（单页、空内容），QuickLook 应能出图。
    fn write_minimal_pdf(dir: &std::path::Path) -> PathBuf {
        let pdf = b"%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
%%EOF";
        let p = dir.join("fixture.pdf");
        std::fs::write(&p, pdf).unwrap();
        p
    }

    #[test]
    fn ql_pdf_thumbnail_renders() {
        let dir = std::env::temp_dir().join(format!("rdir-thumbs-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pdf = write_minimal_pdf(&dir);
        let out = ql_thumb(&pdf, 128);
        std::fs::remove_dir_all(&dir).ok();
        let out = out.expect("QuickLook 应为合法 PDF 生成缩略图");
        assert!(out.len() > 100, "PNG 字节过小: {}", out.len());
        assert_eq!(&out[1..4], b"PNG", "应为 PNG 格式");
    }

    #[test]
    fn ql_unreadable_file_returns_none() {
        let dir = std::env::temp_dir().join(format!("rdir-thumbs-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("broken.pdf");
        std::fs::write(&p, b"not a pdf at all").unwrap();
        let out = ql_thumb(&p, 128);
        std::fs::remove_dir_all(&dir).ok();
        assert!(out.is_none(), "损坏 PDF 应返回 None 而不是出错");
    }
}
