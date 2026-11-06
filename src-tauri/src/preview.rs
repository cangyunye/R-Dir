//! 预览原图数据（v0.28.0）：本地图片文件 → 原字节 base64 data URL。
//!
//! 与 thumbs.rs 的缩略图不同：预览栏要展示原图（保 GIF 动画、支持放大到 100%），
//! 因此不解码不缩放，按扩展名映射 mime 后直接回原字节。仅本地绝对路径；
//! 超过上限（30MB）或读取失败返回 Ok(None)，前端回退缩略图/信息卡。
//! SVG 是文本格式，浏览器可直接渲染，按原字节回 image/svg+xml。
//!
//! v0.42 内容嗅探：扩展名不支持时按 magic 嗅探图片格式兜底（手写子集：
//! PNG/JPEG/GIF/WebP/AVIF 精确前缀，模糊/共享容器不发言）；并新增组合探测命令
//! probe_local_file——text-probe 门控的嗅探优先路由（图片 16B 即判，不进 8MB 文本读取）。

use base64::Engine as _;
use serde::Serialize;
use std::io::Read;

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

/// 可嗅探路由的图片格式（v0.42 手写 magic 子集）：只收精确前缀，WebView 可直接解码。
/// BMP（仅 2 字节、纯 ASCII 可撞头）、TIFF（WebView 不解码）、HEIC（解码链路不确定）不入表。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    Gif,
    Webp,
    Avif,
}

impl ImageFormat {
    pub fn mime(self) -> &'static str {
        match self {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::Gif => "image/gif",
            ImageFormat::Webp => "image/webp",
            ImageFormat::Avif => "image/avif",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpeg",
            ImageFormat::Gif => "gif",
            ImageFormat::Webp => "webp",
            ImageFormat::Avif => "avif",
        }
    }
}

/// magic 嗅探：头部字节精确匹配。ZIP 家族（PK…，与 docx/jar/epub 共享）、EBML、
/// ftyp 非 AVIF 品牌等共享/模糊容器一律 None（调用方回「疑似二进制」，不猜）。
pub fn sniff_image_format(head: &[u8]) -> Option<ImageFormat> {
    if head.len() >= 8 && head[..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        return Some(ImageFormat::Png);
    }
    if head.len() >= 3 && head[..3] == [0xFF, 0xD8, 0xFF] {
        return Some(ImageFormat::Jpeg);
    }
    if head.len() >= 6 && (&head[..6] == b"GIF87a" || &head[..6] == b"GIF89a") {
        return Some(ImageFormat::Gif);
    }
    if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return Some(ImageFormat::Webp);
    }
    if head.len() >= 12
        && &head[4..8] == b"ftyp"
        && (&head[8..12] == b"avif" || &head[8..12] == b"avis")
    {
        return Some(ImageFormat::Avif);
    }
    None
}

/// 读文件头 n 字节（不足读满即返回实际字节）。
fn read_head(p: &std::path::Path, n: usize) -> std::io::Result<Vec<u8>> {
    let mut f = std::fs::File::open(p)?;
    let mut head = Vec::with_capacity(n);
    f.take(n as u64).read_to_end(&mut head)?;
    Ok(head)
}

/// 读头嗅探（供 thumbs 等复用）：16B 头 → 图片格式。
pub fn sniff_image_at(p: &std::path::Path) -> Option<ImageFormat> {
    read_head(p, 16).ok().and_then(|h| sniff_image_format(&h))
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
    let mime = match preview_mime(&ext) {
        Some(m) => m,
        // v0.42 扩展名丢失：magic 嗅探兜底（仅图片格式；解码失败由前端回退）
        None => match sniff_image_at(p) {
            Some(fmt) => fmt.mime(),
            None => return None,
        },
    };
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

/// 未知类型组合探测结果（v0.42 text-probe 路由）。
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProbeOutcome {
    /// 文本内容（与 read_text_file 同构）
    Text {
        #[serde(flatten)]
        content: crate::text_diff::TextFileContent,
    },
    /// magic 命中图片格式，按原图预览路由
    Image { format: &'static str },
    /// 非文本且无已知 magic
    Binary,
    /// 非图片且超过文本上限（>8MB）
    Oversized,
}

/// 组合探测（阻塞版）：常规文件守卫 → 图片嗅探（16B）→ 文本读取。
/// 嗅探优先的意义：二进制文件最坏 IO 从「整读 8MB 再拒」降到 16B。
pub fn probe_blocking(path: String) -> Result<ProbeOutcome, String> {
    let p = std::path::Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| format!("读取失败：{e}"))?;
    if !meta.is_file() {
        // 目录/FIFO/socket/设备一律拒绝（同 read_local_text_full 守卫：无扩展名命名管道不得阻塞）
        return Err("NOT_FILE|路径不是常规文件（目录/管道/设备），无法按文本读取".into());
    }
    let head = read_head(p, 16).unwrap_or_default();
    if let Some(fmt) = sniff_image_format(&head) {
        return Ok(ProbeOutcome::Image {
            format: fmt.as_str(),
        });
    }
    if meta.len() > crate::text_diff::MAX_TEXT_BYTES {
        return Ok(ProbeOutcome::Oversized);
    }
    match crate::text_diff::read_local_text_full(p, None) {
        Ok(t) => Ok(ProbeOutcome::Text {
            content: crate::text_diff::TextFileContent {
                path: path.clone(),
                local_path: path,
                is_temp: false,
                lossy: t.lossy,
                text: t.text,
                encoding: t.encoding.to_string(),
            },
        }),
        Err(e) if e.starts_with(crate::text_diff::NOT_TEXT_ERR_PREFIX) => Ok(ProbeOutcome::Binary),
        Err(e) => Err(e),
    }
}

/// 未知类型内容探测（v0.42）：仅本地绝对路径；图片/文本/二进制/超大四态。
#[tauri::command]
pub async fn probe_local_file(path: String) -> Result<ProbeOutcome, String> {
    // 远程路径门控不会放行（previewKindOf 限本地），防御性回 Binary
    if !std::path::Path::new(&path).is_absolute() {
        return Ok(ProbeOutcome::Binary);
    }
    tauri::async_runtime::spawn_blocking(move || probe_blocking(path))
        .await
        .map_err(|e| format!("探测任务失败: {e}"))?
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

    #[test]
    fn sniff_image_magics() {
        assert_eq!(
            sniff_image_format(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
            Some(ImageFormat::Png)
        );
        assert_eq!(sniff_image_format(&[0xFF, 0xD8, 0xFF, 0xE0]), Some(ImageFormat::Jpeg));
        assert_eq!(sniff_image_format(b"GIF89a......"), Some(ImageFormat::Gif));
        assert_eq!(sniff_image_format(b"GIF87a......"), Some(ImageFormat::Gif));
        assert_eq!(
            sniff_image_format(b"RIFF\x24\x00\x00\x00WEBPVP8 "),
            Some(ImageFormat::Webp)
        );
        assert_eq!(
            sniff_image_format(b"\x00\x00\x00\x20ftypavif\x00\x00\x00\x00"),
            Some(ImageFormat::Avif)
        );
        assert_eq!(
            sniff_image_format(b"\x00\x00\x00\x20ftypavis\x00\x00\x00\x00"),
            Some(ImageFormat::Avif)
        );
        // 负例：短头 / 纯 ASCII 撞头 / 共享容器 / 非 AVIF 品牌，一律不发言
        assert_eq!(sniff_image_format(&[0x89, 0x50]), None);
        assert_eq!(sniff_image_format(b"BM"), None);
        assert_eq!(sniff_image_format(b"BMWindows"), None);
        assert_eq!(sniff_image_format(b"PK\x03\x04 zip-like"), None);
        assert_eq!(sniff_image_format(b"RIFF\x24\x00\x00\x00WAVEfmt "), None);
        assert_eq!(sniff_image_format(b"\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00"), None);
        assert_eq!(sniff_image_format(b"GIF89"), None);
        assert_eq!(sniff_image_format(b""), None);
    }

    #[test]
    fn probe_routes_by_content() {
        let dir = std::env::temp_dir().join(format!("rdir-probe-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // png 字节无扩展名 → Image
        let p = dir.join("photo_noext");
        std::fs::write(&p, [0x89u8, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]).unwrap();
        match probe_blocking(p.to_string_lossy().to_string()).unwrap() {
            ProbeOutcome::Image { format } => assert_eq!(format, "png"),
            _ => panic!("png 字节应路由为图片"),
        }
        // 文本无扩展名 → Text（结构与 read_text_file 同构）
        let p = dir.join("notes_noext");
        std::fs::write(&p, b"hello\n").unwrap();
        match probe_blocking(p.to_string_lossy().to_string()).unwrap() {
            ProbeOutcome::Text { content } => {
                assert_eq!(content.text, "hello\n");
                assert_eq!(content.encoding, "UTF-8");
            }
            _ => panic!("文本应路由为 Text"),
        }
        // zip 头无扩展名 → Binary（真实 zip 头部含 NUL 字段）
        let p = dir.join("blob_noext");
        std::fs::write(&p, b"PK\x03\x04\x14\x00\x00\x00\x08\x00binary").unwrap();
        match probe_blocking(p.to_string_lossy().to_string()).unwrap() {
            ProbeOutcome::Binary => {}
            _ => panic!("zip 头应判为 Binary"),
        }
        // 超限非图片 → Oversized（set_len 产出全零，无 magic）
        let p = dir.join("huge_noext");
        let f = std::fs::File::create(&p).unwrap();
        f.set_len(crate::text_diff::MAX_TEXT_BYTES + 1).unwrap();
        drop(f);
        match probe_blocking(p.to_string_lossy().to_string()).unwrap() {
            ProbeOutcome::Oversized => {}
            _ => panic!("超限应判为 Oversized"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn probe_rejects_non_regular_files() {
        let dir =
            std::env::temp_dir().join(format!("rdir-probe-nonregular-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 目录 → NOT_FILE
        let err = match probe_blocking(dir.to_string_lossy().to_string()) {
            Err(e) => e,
            Ok(_) => panic!("目录应被拒绝"),
        };
        assert!(err.starts_with("NOT_FILE|"), "{err}");
        // FIFO → NOT_FILE（嗅探命令同样不得阻塞在命名管道上）
        #[cfg(unix)]
        {
            let fifo = dir.join("namedpipe");
            assert!(std::process::Command::new("mkfifo").arg(&fifo).status().unwrap().success());
            let err = match probe_blocking(fifo.to_string_lossy().to_string()) {
                Err(e) => e,
                Ok(_) => panic!("FIFO 应被拒绝"),
            };
            assert!(err.starts_with("NOT_FILE|"), "{err}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn preview_data_sniffs_extensionless_images() {
        let dir = std::env::temp_dir().join(format!("rdir-preview-sniff-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("photo_noext");
        std::fs::write(&p, [0x89u8, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).unwrap();
        let url = preview_blocking(p.to_string_lossy().to_string()).unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        // 纯文本不嗅探不回（防把文本字节当图片回给 WebView）
        let p = dir.join("notes_noext");
        std::fs::write(&p, b"plain text").unwrap();
        assert!(preview_blocking(p.to_string_lossy().to_string()).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
