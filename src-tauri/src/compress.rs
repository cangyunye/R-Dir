//! 压缩插件（v0.8）：zip / tar / tgz（仅打包，不提供解压）
//!
//! - zip：zip crate（纯 Rust，UTF-8 文件名，跨平台一致）
//! - tar：tar crate（仅打包）
//! - tgz：tar + flate2（Gzip 压缩）
//! - 进度：按文件粒度经 "transfer-progress" 事件推送（phase="compress"），
//!   与拖拽复制共用前端进度条。
//! - 同名冲突自动改名（name (2).zip），输出文件排除在打包清单外。

use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::progress::{emit, TransferProgress};

/// 收集待打包文件清单（目录递归，含空目录条目），排除 out_path 自身。
fn collect_files(path: &Path, out_path: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if path == out_path {
        return Ok(());
    }
    let md = fs::symlink_metadata(path)
        .map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
    if md.is_dir() {
        files.push(path.to_path_buf());
        let rd = fs::read_dir(path)
            .map_err(|e| format!("读取目录 {} 失败：{e}", path.display()))?;
        for ent in rd {
            let ent = ent.map_err(|e| format!("读取目录 {} 失败：{e}", path.display()))?;
            collect_files(&ent.path(), out_path, files)?;
        }
    } else {
        files.push(path.to_path_buf());
    }
    Ok(())
}

/// 同名冲突自动改名：name.zip → name (2).zip → name (3).zip …
fn unique_dest(p: &Path) -> PathBuf {
    if !p.exists() {
        return p.to_path_buf();
    }
    let parent = p.parent().unwrap_or_else(|| Path::new("."));
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "archive".into());
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let mut n = 2;
    loop {
        let cand = parent.join(format!("{stem} ({n}){ext}"));
        if !cand.exists() {
            return cand;
        }
        n += 1;
    }
}

/// zip 内相对路径：顶层取源名，子路径相对顶层（单选 a.txt → "a.txt"；多选 → "a.txt"、"dir/x"…）
fn archive_rel_path(top: &Path, full: &Path) -> String {
    let name = top
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "archive".into());
    let rest = full.strip_prefix(top).unwrap_or(full);
    if rest.as_os_str().is_empty() {
        name
    } else {
        format!("{}/{}", name, rest.to_string_lossy().replace('\\', "/"))
    }
}

fn zip_files(
    files: &[PathBuf],
    out: &Path,
    progress_cb: &mut dyn FnMut(),
) -> Result<(), String> {
    let file = fs::File::create(out).map_err(|e| format!("创建 {} 失败：{e}", out.display()))?;
    let mut zw = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    // 顶层集合（去重）：列表内没有被其他项包含的路径作为归档根
    let mut unique_tops: Vec<&Path> = Vec::new();
    for f in files {
        let mut t = f.as_path();
        while let Some(parent) = t.parent() {
            if files.iter().any(|x| x == parent) {
                t = parent;
            } else {
                break;
            }
        }
        if !unique_tops.iter().any(|x| *x == t) {
            unique_tops.push(t);
        }
    }
    for f in files.iter() {
        let top = unique_tops
            .iter()
            .find(|t| f.starts_with(t))
            .copied()
            .unwrap_or(f);
        let rel = archive_rel_path(top, f);
        let md = fs::symlink_metadata(f)
            .map_err(|e| format!("读取 {} 失败：{e}", f.display()))?;
        if md.is_dir() {
            zw.add_directory(rel.clone(), opts)
                .map_err(|e| format!("写入 {} 失败：{e}", rel))?;
        } else {
            zw.start_file(rel.clone(), opts)
                .map_err(|e| format!("写入 {} 失败：{e}", rel))?;
            let mut src = fs::File::open(f).map_err(|e| format!("打开 {} 失败：{e}", f.display()))?;
            std::io::copy(&mut src, &mut zw)
                .map_err(|e| format!("写入 {} 失败：{e}", f.display()))?;
        }
        progress_cb();
    }
    zw.finish()
        .map_err(|e| format!("收尾压缩包失败：{e}"))?;
    Ok(())
}

fn tar_files(
    files: &[PathBuf],
    out: &Path,
    gzip: bool,
    progress_cb: &mut dyn FnMut(),
) -> Result<(), String> {
    let file = fs::File::create(out).map_err(|e| format!("创建 {} 失败：{e}", out.display()))?;
    let writer: Box<dyn std::io::Write> = if gzip {
        Box::new(flate2::GzBuilder::new().write(file, flate2::Compression::default()))
    } else {
        Box::new(file)
    };
    let mut builder = tar::Builder::new(writer);
    // 顶层集合
    let mut unique_tops: Vec<&Path> = Vec::new();
    for f in files {
        let mut t = f.as_path();
        while let Some(parent) = t.parent() {
            if files.iter().any(|x| x == parent) {
                t = parent;
            } else {
                break;
            }
        }
        if !unique_tops.iter().any(|x| *x == t) {
            unique_tops.push(t);
        }
    }
    for f in files.iter() {
        let top = unique_tops
            .iter()
            .find(|t| f.starts_with(t))
            .copied()
            .unwrap_or(f);
        let rel = archive_rel_path(top, f);
        let md = fs::symlink_metadata(f)
            .map_err(|e| format!("读取 {} 失败：{e}", f.display()))?;
        if md.is_dir() {
            builder
                .append_dir(&rel, f)
                .map_err(|e| format!("写入 {} 失败：{e}", rel))?;
        } else {
            builder
                .append_path_with_name(f, &rel)
                .map_err(|e| format!("写入 {} 失败：{e}", rel))?;
        }
        progress_cb();
    }
    builder
        .finish()
        .map_err(|e| format!("收尾归档失败：{e}"))?;
    Ok(())
}

/// 压缩选中条目到 target_dir（zip / tar / tgz）。
/// 命名：单选 → `原名.<ext>`；多选 → `<当前目录名>.<ext>`；同名自动改名。
/// 返回生成的文件完整路径。
#[tauri::command]
pub fn compress_items(
    app: AppHandle,
    paths: Vec<String>,
    target_dir: String,
    format: String,
) -> Result<String, String> {
    if paths.is_empty() {
        return Err("没有可压缩的条目".into());
    }
    if !matches!(format.as_str(), "zip" | "tar" | "tgz") {
        return Err(format!("不支持的压缩格式：{format}（支持 zip / tar / tgz）"));
    }
    let dir = Path::new(&target_dir);
    if !dir.is_dir() {
        return Err(format!("目标目录不存在：{}", dir.display()));
    }
    // 命名
    let base = if paths.len() == 1 {
        Path::new(&paths[0])
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "archive".into())
    } else {
        dir.file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty() && s != "/" && s != "\\")
            .unwrap_or_else(|| "archive".into())
    };
    let ext = if format == "tgz" { "tar.gz" } else { format.as_str() };
    let out = unique_dest(&dir.join(format!("{base}.{ext}")));
    // 收集清单（排除输出文件自身，防自包含）
    let mut files: Vec<PathBuf> = Vec::new();
    for p in &paths {
        let pb = PathBuf::from(p);
        if pb == out {
            return Err(format!("输出文件与待压缩项同名，请重命名后重试（{base}.{ext}）"));
        }
        collect_files(&pb, &out, &mut files)?;
    }
    if files.is_empty() {
        return Err("待压缩内容为空".into());
    }
    let label = out
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "archive".into());
    let mut prog = TransferProgress::start("compress", &label, files.len());
    {
        let mut cb = || {
            prog.done_files += 1;
            emit(&app, &prog);
        };
        match format.as_str() {
            "zip" => zip_files(&files, &out, &mut cb)?,
            "tar" => tar_files(&files, &out, false, &mut cb)?,
            "tgz" => tar_files(&files, &out, true, &mut cb)?,
            _ => unreachable!(),
        }
    }
    prog.done = true;
    prog.done_files = prog.total_files;
    emit(&app, &prog);
    Ok(out.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn setup(tag: &str) -> std::path::PathBuf {
        // 每测试独立目录，避免并行互删
        let dir = std::env::temp_dir().join(format!("rdir-compress-{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "hello world").unwrap();
        std::fs::write(dir.join("sub").join("b.txt"), "nested").unwrap();
        dir
    }

    #[test]
    fn unique_dest_renames() {
        let dir = setup("un");
        std::fs::write(dir.join("x.zip"), "").unwrap();
        let d = unique_dest(&dir.join("x.zip"));
        assert_eq!(d.file_name().unwrap().to_string_lossy(), "x (2).zip");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn collect_skips_out_and_recurses() {
        let dir = setup("col");
        let out = dir.join("out.zip");
        let mut files = Vec::new();
        collect_files(&dir.join("sub"), &out, &mut files).unwrap();
        assert_eq!(files.len(), 2); // 目录本身 + b.txt
        let mut files2 = Vec::new();
        collect_files(&dir, &out, &mut files2).unwrap();
        // 目录 + a.txt + sub 目录 + b.txt
        assert_eq!(files2.len(), 4);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zip_roundtrip() {
        let dir = setup("zip");
        let out = dir.join("包.zip");
        let mut all = Vec::new();
        collect_files(&dir, &out, &mut all).unwrap();
        zip_files(&all, &out, &mut || {}).unwrap();
        assert!(out.exists());
        // 读回验证条目
        let f = std::fs::File::open(&out).unwrap();
        let mut zr = zip::ZipArchive::new(f).unwrap();
        let names: Vec<String> = (0..zr.len()).map(|i| zr.by_index(i).unwrap().name().to_string()).collect();
        assert!(names.iter().any(|n| n.ends_with("a.txt")), "names={names:?}");
        assert!(names.iter().any(|n| n.ends_with("sub/b.txt")), "names={names:?}");
        // 内容验证
        let mut content = String::new();
        let mut entry = zr.by_name("rdir-compress-zip/a.txt").unwrap();
        entry.read_to_string(&mut content).unwrap();
        assert_eq!(content, "hello world");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tar_and_tgz_roundtrip() {
        let dir = setup("tar");
        for (name, gzip) in [("包.tar", false), ("包.tar.gz", true)] {
            let out = dir.join(name);
            let mut all = Vec::new();
            collect_files(&dir, &out, &mut all).unwrap();
            tar_files(&all, &out, gzip, &mut || {}).unwrap();
            assert!(out.exists(), "{name} 生成失败");
            assert!(out.metadata().unwrap().len() > 0);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn archive_rel_path_keeps_top_name() {
        let top = std::path::Path::new("C:/my/dir");
        let full = std::path::Path::new("C:/my/dir/sub/file.txt");
        assert_eq!(archive_rel_path(top, full), "dir/sub/file.txt");
    }
}
