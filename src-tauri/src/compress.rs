//! 压缩插件（v0.8）：zip / tar / tgz（仅打包，不提供解压）
//!
//! 调用系统命令压缩（大批量文件比纯 Rust crate 快很多）：
//! - zip：macOS `ditto -c -k`；Windows `powershell Compress-Archive`；Linux `zip -r`
//! - tar / tgz：`tar -cf` / `tar -czf`（Windows 10+ 自带 bsdtar）
//! - 同名冲突自动改名（name (2).zip）
//! - 进度：仅起止两次事件（系统命令不回传按文件粒度的进度）

use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::progress::{emit, TransferProgress};

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

/// 压缩选中条目到 target_dir（zip / tar / tgz）。
/// 命名：单选 → `原名.<ext>`；多选 → `<当前目录名>.<ext>`；同名自动改名。
/// 返回生成的文件完整路径。
#[tauri::command]
pub async fn compress_items(
    app: AppHandle,
    paths: Vec<String>,
    target_dir: String,
    format: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        compress_items_blocking(app, paths, target_dir, format)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn compress_items_blocking(
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
    let label = out
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "archive".into());

    let mut prog = TransferProgress::start("compress", &label, paths.len());
    prog.done_files = 0;
    emit(&app, &prog);

    // 用系统命令压缩（比纯 Rust crate 快很多）
    let result = compress_with_system(&paths, &out, &format, dir);

    prog.done = true;
    prog.done_files = prog.total_files;
    emit(&app, &prog);
    result.map_err(|e| format!("压缩失败:{e}"))?;
    Ok(out.to_string_lossy().into_owned())
}

/// 把条目路径转为相对 cwd（目标目录）的路径：归档内条目不带绝对层级
/// （此前 tar/zip 用绝对路径打包，解压出 `Users/.../a.txt` 这样的完整层级）。
/// 不在目标目录内的条目保持原样。
fn relativize(p: &str, cwd: &Path) -> String {
    match Path::new(p).strip_prefix(cwd) {
        Ok(rel) if !rel.as_os_str().is_empty() => rel.to_string_lossy().into_owned(),
        _ => p.to_string(),
    }
}

/// 调系统命令压缩：以目标目录为工作目录、条目用相对路径（v0.22.0 归档相对化）
#[cfg(target_os = "windows")]
fn compress_with_system(paths: &[String], out: &Path, format: &str, cwd: &Path) -> Result<(), String> {
    use std::process::Command;
    let out_str = out.to_string_lossy().to_string();
    let items: Vec<String> = paths.iter().map(|p| relativize(p, cwd)).collect();
    match format {
        "zip" => {
            // PowerShell Compress-Archive（系统原生，多线程）
            let path_list = items
                .iter()
                .map(|p| format!("'{}'", p.replace('\'', "''")))
                .collect::<Vec<_>>()
                .join(",");
            let cmd = format!(
                "Compress-Archive -Path {} -DestinationPath '{}' -Force",
                path_list,
                out_str.replace('\'', "''")
            );
            let status = Command::new("powershell")
                .args(&["-NoProfile", "-Command", &cmd])
                .current_dir(cwd)
                .status()
                .map_err(|e| format!("启动 powershell 失败:{e}"))?;
            if !status.success() {
                return Err("powershell Compress-Archive 失败".into());
            }
            Ok(())
        }
        "tar" | "tgz" => {
            // Windows 10+ 自带 bsdtar
            let flag = if format == "tgz" { "-czf" } else { "-cf" };
            let mut cmd = Command::new("tar");
            cmd.arg(flag).arg(&out_str).current_dir(cwd);
            for p in &items {
                cmd.arg(p);
            }
            let status = cmd.status().map_err(|e| format!("启动 tar 失败：{e}"))?;
            if !status.success() {
                return Err("tar 命令失败".into());
            }
            Ok(())
        }
        _ => unreachable!(),
    }
}

#[cfg(not(target_os = "windows"))]
fn compress_with_system(paths: &[String], out: &Path, format: &str, cwd: &Path) -> Result<(), String> {
    use std::process::Command;
    let out_str = out.to_string_lossy().to_string();
    let items: Vec<String> = paths.iter().map(|p| relativize(p, cwd)).collect();
    match format {
        "zip" => {
            // macOS: ditto（系统原生，比 zip 快，保留资源 fork）
            #[cfg(target_os = "macos")]
            {
                let mut cmd = Command::new("ditto");
                cmd.arg("-c").arg("-k").arg("--sequesterRsrc").arg("--keepParent")
                    .current_dir(cwd);
                for p in &items {
                    cmd.arg(p);
                }
                cmd.arg(&out_str);
                let status = cmd.status().map_err(|e| format!("启动 ditto 失败：{e}"))?;
                if !status.success() {
                    return Err("ditto 压缩失败".into());
                }
                Ok(())
            }
            #[cfg(not(target_os = "macos"))]
            {
                // Linux: zip 命令
                let mut cmd = Command::new("zip");
                cmd.arg("-r").arg(&out_str).current_dir(cwd);
                for p in &items {
                    cmd.arg(p);
                }
                let status = cmd.status().map_err(|e| format!("启动 zip 失败：{e}"))?;
                if !status.success() {
                    return Err("zip 命令失败".into());
                }
                Ok(())
            }
        }
        "tar" | "tgz" => {
            let flag = if format == "tgz" { "-czf" } else { "-cf" };
            let mut cmd = Command::new("tar");
            cmd.arg(flag).arg(&out_str).current_dir(cwd);
            for p in &items {
                cmd.arg(p);
            }
            let status = cmd.status().map_err(|e| format!("启动 tar 失败：{e}"))?;
            if !status.success() {
                return Err("tar 命令失败".into());
            }
            Ok(())
        }
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn relativize_strips_target_dir_keeps_outside() {
        let dir = setup("rel");
        assert_eq!(relativize(&dir.join("a.txt").to_string_lossy(), &dir), "a.txt");
        assert_eq!(relativize(&dir.join("sub").to_string_lossy(), &dir), "sub");
        let outside = std::env::temp_dir().join("elsewhere.txt");
        assert_eq!(relativize(&outside.to_string_lossy(), &dir), outside.to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 走真实生产路径：系统命令压缩（macOS ditto/tar，Windows powershell/tar，Linux zip/tar）
    #[test]
    fn system_compress_produces_nonempty_archive() {
        let dir = setup("sys");
        let src = dir.join("a.txt").to_string_lossy().to_string();
        for (name, format) in [("out.zip", "zip"), ("out.tar", "tar"), ("out.tar.gz", "tgz")] {
            let out = dir.join(name);
            compress_with_system(std::slice::from_ref(&src), &out, format, &dir)
                .unwrap_or_else(|e| panic!("{name} 压缩失败：{e}"));
            assert!(out.exists(), "{name} 未生成");
            assert!(out.metadata().unwrap().len() > 0, "{name} 为空");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// tar/tgz 条目必须是相对目标目录的路径（此前绝对路径打包解压出完整层级）
    #[test]
    fn tar_archives_relative_to_target_dir() {
        use std::process::Command;
        let dir = setup("reltar");
        let items = vec![
            dir.join("a.txt").to_string_lossy().into_owned(),
            dir.join("sub").to_string_lossy().into_owned(),
        ];
        let out = dir.join("rel.tar");
        compress_with_system(&items, &out, "tar", &dir).unwrap();
        let list = Command::new("tar").arg("-tf").arg(&out).output().unwrap();
        let stdout = String::from_utf8_lossy(&list.stdout).into_owned();
        assert!(
            !stdout.contains("rdir-compress-reltar") && !stdout.starts_with('/'),
            "tar 条目不应包含绝对层级：{stdout}"
        );
        assert!(stdout.lines().any(|l| l == "a.txt"), "缺少相对条目 a.txt：{stdout}");
        assert!(stdout.lines().any(|l| l.starts_with("sub")), "缺少相对条目 sub：{stdout}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
