use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// 复制进度回调：参数为 (当前文件已复制字节, 当前文件总字节)
pub type ProgressCb<'a> = &'a mut dyn FnMut(u64, u64);

/// 复制条目（目录递归）到目标目录，冲突时自动追加 " (2)"。
/// 返回每个条目的实际创建路径（供撤销栈记录）。
pub fn copy_entries(paths: &[String], dest: &str, mut cb: ProgressCb) -> Result<Vec<String>, String> {
    let dest = Path::new(dest);
    if !dest.is_dir() {
        return Err(format!("目标不是目录：{}", dest.display()));
    }
    let mut created = Vec::with_capacity(paths.len());
    for p in paths {
        let src = Path::new(p);
        let name = src.file_name().ok_or_else(|| format!("非法路径：{}", p))?;
        let target = unique_dest(dest.join(name));
        copy_recursive(src, &target, &mut cb).map_err(|e| format!("复制 {} 失败：{}", p, e))?;
        created.push(target.to_string_lossy().to_string());
    }
    Ok(created)
}

/// 移动条目：同卷 rename，跨卷回退为复制 + 删除。
/// 返回每对 (源路径, 目标路径)，供撤销栈反向移动。
pub fn move_entries(paths: &[String], dest: &str, mut cb: ProgressCb) -> Result<Vec<(String, String)>, String> {
    let dest = Path::new(dest);
    if !dest.is_dir() {
        return Err(format!("目标不是目录：{}", dest.display()));
    }
    let mut moved = Vec::with_capacity(paths.len());
    for p in paths {
        let src = Path::new(p);
        let name = src.file_name().ok_or_else(|| format!("非法路径：{}", p))?;
        let target = unique_dest(dest.join(name));
        if fs::rename(src, &target).is_err() {
            copy_recursive(src, &target, &mut cb).map_err(|e| format!("移动 {} 失败：{}", p, e))?;
            remove_recursive(src).map_err(|e| format!("移动 {} 清理失败：{}", p, e))?;
        }
        moved.push((p.clone(), target.to_string_lossy().to_string()));
    }
    Ok(moved)
}

/// 重命名条目，返回新路径。
pub fn rename_entry(path: &str, new_name: &str) -> Result<String, String> {
    let p = Path::new(path);
    if new_name.is_empty() {
        return Err("名称不能为空".into());
    }
    let parent = p.parent().ok_or("无父目录")?;
    let target = parent.join(new_name);
    if target.exists() {
        return Err(format!("{} 已存在", new_name));
    }
    fs::rename(p, &target).map_err(|e| format!("重命名失败：{}", e))?;
    Ok(target.to_string_lossy().to_string())
}

/// 删除条目（进回收站）。
pub fn delete_entries(paths: &[String]) -> Result<(), String> {
    let paths: Vec<&Path> = paths.iter().map(|s| Path::new(s)).collect();
    trash::delete_all(&paths).map_err(|e| format!("删除失败：{}", e))?;
    Ok(())
}

/// 永久删除条目（绕过回收站，不可恢复）。
pub fn permanent_delete_entries(paths: &[String]) -> Result<(), String> {
    for p in paths {
        let path = Path::new(p);
        remove_recursive(path).map_err(|e| format!("永久删除 {} 失败：{}", p, e))?;
    }
    Ok(())
}

/// 新建文件夹，返回新路径。
pub fn create_dir(parent: &str, name: &str) -> Result<String, String> {
    let target = Path::new(parent).join(name);
    fs::create_dir(&target).map_err(|e| format!("新建文件夹失败：{}", e))?;
    Ok(target.to_string_lossy().to_string())
}

/// 新建空文件，返回新路径。
pub fn create_file(parent: &str, name: &str) -> Result<String, String> {
    let target = Path::new(parent).join(name);
    fs::write(&target, b"").map_err(|e| format!("新建文件失败：{}", e))?;
    Ok(target.to_string_lossy().to_string())
}

fn copy_recursive(src: &Path, dst: &Path, cb: &mut dyn FnMut(u64, u64)) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let e = entry?;
            copy_recursive(&e.path(), &dst.join(e.file_name()), cb)?;
        }
    } else {
        copy_file_progress(src, dst, cb)?;
    }
    Ok(())
}

/// 流式复制文件并回报进度（64KB 块）
fn copy_file_progress(src: &Path, dst: &Path, cb: &mut dyn FnMut(u64, u64)) -> std::io::Result<()> {
    let total = src.metadata().map(|m| m.len()).unwrap_or(0);
    let mut r = fs::File::open(src)?;
    let mut w = fs::File::create(dst)?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = 0;
    loop {
        let n = r.read(&mut buf)?;
        if n == 0 {
            break;
        }
        w.write_all(&buf[..n])?;
        done += n as u64;
        cb(done, total);
    }
    w.flush()?;
    Ok(())
}

fn remove_recursive(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

/// 目标已存在时生成 "name (2).ext" 式不冲突路径。
fn unique_dest(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let (stem, ext) = match path.extension() {
        Some(e) => {
            let ext = format!(".{}", e.to_string_lossy());
            let stem = name
                .strip_suffix(&ext)
                .unwrap_or(&name)
                .to_string();
            (stem, ext)
        }
        None => (name, String::new()),
    };
    for i in 2..10000 {
        let candidate = parent.join(format!("{} ({}){}", stem, i, ext));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("无法生成不冲突的目标名")
}
