//! 预览原图数据（v0.28.0）：本地图片文件 → 原字节 base64 data URL。
//!
//! 与 thumbs.rs 的缩略图不同：预览栏要展示原图（保 GIF 动画、支持放大到 100%），
//! 因此不解码不缩放，按扩展名映射 mime 后直接回原字节。仅本地绝对路径；
//! 超过上限（30MB）或读取失败返回 Ok(None)，前端回退缩略图/信息卡。
//! SVG 是文本格式，浏览器可直接渲染，按原字节回 image/svg+xml。

use base64::Engine as _;

/// 原图字节上限：预览加载进 WebView 内存，超过后前端回退缩略图放大。
const MAX_PREVIEW_BYTES: u64 = 30 * 1024 * 1024;

/// 扩展名 → data URL mime。None = 不支持原字节预览。
fn preview_mime(ext: &str) -> Option<&'static str> {
    match ext {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "tiff" | "tif" => Some("image/tiff"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

/// 读取原图字节并编码 data URL；不支持/过大/非文件/读取失败 → None。
fn preview_blocking(path: String) -> Option<String> {
    let p = std::path::Path::new(&path);
    let meta = std::fs::metadata(p).ok()?;
    if !meta.is_file() || meta.len() > MAX_PREVIEW_BYTES {
        return None;
    }
    let ext = p
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let mime = preview_mime(&ext)?;
    let bytes = std::fs::read(p).ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

/// 取预览原图 data URL；失败/不支持返回 Ok(None)（前端回退缩略图或信息卡）。
#[tauri::command]
pub async fn preview_data(path: String) -> Result<Option<String>, String> {
    // sftp://、http://、tags:// 等虚拟路径不走本地读取
    if !std::path::Path::new(&path).is_absolute() {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || preview_blocking(path))
        .await
        .map_err(|e| format!("预览任务失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_file_returns_data_url() {
        let dir = std::env::temp_dir().join(format!("rdir-preview-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.png");
        // 1x1 透明 PNG
        let png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        std::fs::write(&p, png).unwrap();
        let url = preview_blocking(p.to_string_lossy().to_string()).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unsupported_ext_returns_none() {
        let dir = std::env::temp_dir().join(format!("rdir-preview-test2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.heic");
        std::fs::write(&p, b"not really heic").unwrap();
        assert!(preview_blocking(p.to_string_lossy().to_string()).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn oversized_returns_none() {
        let dir = std::env::temp_dir().join(format!("rdir-preview-test3-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("big.png");
        let f = std::fs::File::create(&p).unwrap();
        f.set_len(MAX_PREVIEW_BYTES + 1).unwrap();
        drop(f);
        assert!(preview_blocking(p.to_string_lossy().to_string()).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_file_returns_none() {
        assert!(preview_blocking("/nonexistent/rdir/preview/x.png".into()).is_none());
    }
}
