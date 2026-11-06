//! 前端静态资源服务：rust-embed 编译期内嵌 `../dist`（vite 产物），
//! rdir-web 单文件部署无需附带资源目录。
//!
//! 编译要求：构建 web feature 前先 `pnpm build` 产出 dist/（缺目录会编译失败，
//! 属预期——web 发行包必须内嵌真实前端）。debug 构建下 rust-embed 默认从磁盘
//! 实时读取（改前端即时生效），release 构建内嵌。

use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../dist"]
struct Frontend;

/// 常见扩展名 → Content-Type（vite 产物 + 本地文件服务覆盖面；缺省 octet-stream）
pub(crate) fn mime_of(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "txt" | "log" | "md" | "rs" | "py" | "ts" | "tsx" | "jsx" | "toml" | "yml" | "yaml"
        | "sh" | "c" | "h" | "cpp" | "ini" | "conf" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        _ => "application/octet-stream",
    }
}

/// 静态资源 → Response。`/` 与无扩展名路径回退 index.html（SPA 兜底）；
/// 哈希产物（assets/）长缓存，入口 no-cache。
pub fn respond(uri_path: &str) -> Response {
    let clean = uri_path.trim_start_matches('/');
    let clean = clean.strip_suffix('/').unwrap_or(clean);
    let file_path = if clean.is_empty() || !clean.contains('.') {
        "index.html"
    } else {
        clean
    };
    match Frontend::get(file_path) {
        Some(file) => {
            let mut resp = (StatusCode::OK, file.data.to_vec()).into_response();
            let headers = resp.headers_mut();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(mime_of(file_path)),
            );
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static(if file_path.starts_with("assets/") {
                    "public, max-age=31536000, immutable"
                } else {
                    "no-cache"
                }),
            );
            resp
        }
        None => (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({
                "ok": false,
                "error": "NOT_FOUND|资源不存在"
            })),
        )
            .into_response(),
    }
}

/// Uri → 静态资源（auth 已由调用方完成）
pub fn handler(uri: Uri) -> Response {
    respond(uri.path())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_covers_vite_products() {
        assert_eq!(mime_of("assets/index-abc.js"), "text/javascript; charset=utf-8");
        assert_eq!(mime_of("index.html"), "text/html; charset=utf-8");
        assert_eq!(mime_of("logo.svg"), "image/svg+xml");
        assert_eq!(mime_of("font.woff2"), "font/woff2");
        assert_eq!(mime_of("unknown.xyz"), "application/octet-stream");
    }

    #[test]
    fn root_maps_to_index_and_falls_back_for_spa_paths() {
        // dist/ 存在（前端已构建）时 index.html 必然可取——构建期由 rust-embed 校验
        let resp = respond("/");
        assert_eq!(resp.status(), StatusCode::OK);
        let resp = respond("/some-client-route");
        assert_eq!(resp.status(), StatusCode::OK);
        // 带扩展名的缺失资源 → 404 JSON
        let resp = respond("/missing.js");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
}
