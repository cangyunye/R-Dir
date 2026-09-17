mod find;
mod fs_ops;
mod ops;
mod search;
mod volumes;

use find::FindEntry;
use fs_ops::FileEntry;
use search::SearchMatch;
use volumes::{QuickAccessItem, VolumeInfo};

/// 列出目录内容（目录优先、名称排序）。
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    fs_ops::list_dir(&path)
}

/// 目录路径补全。
#[tauri::command]
fn complete_path(input: String, cwd: String) -> Vec<String> {
    fs_ops::complete_path(&input, &cwd)
}

/// 枚举磁盘/卷。
#[tauri::command]
fn get_volumes() -> Vec<VolumeInfo> {
    volumes::list_volumes()
}

/// 快速访问目录（主目录、桌面、文档、下载、图片、音乐、影片）。
#[tauri::command]
fn get_quick_access() -> Vec<QuickAccessItem> {
    volumes::quick_access()
}

/// 获取当前用户主目录。
#[tauri::command]
fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "无法获取主目录".to_string())
}

/// 返回父目录；已是根目录时返回自身。
#[tauri::command]
fn parent_dir(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    match p.parent() {
        Some(parent) if parent.as_os_str() != p.as_os_str() => {
            Ok(parent.to_string_lossy().to_string())
        }
        _ => Ok(path),
    }
}

/// 条目类型探测：返回 "dir" / "file" / "symlink"（标签虚拟目录双击跳转用）。
#[tauri::command]
fn stat_path(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        Ok("dir".to_string())
    } else if meta.file_type().is_symlink() {
        Ok("symlink".to_string())
    } else {
        Ok("file".to_string())
    }
}

/// 复制条目到目标目录，返回实际创建路径（供撤销记录）。
#[tauri::command]
fn copy_entries(paths: Vec<String>, dest: String) -> Result<Vec<String>, String> {
    ops::copy_entries(&paths, &dest)
}

/// 移动条目到目标目录，返回 (源, 目标) 路径对（供撤销记录）。
#[tauri::command]
fn move_entries(paths: Vec<String>, dest: String) -> Result<Vec<(String, String)>, String> {
    ops::move_entries(&paths, &dest)
}

/// 重命名条目，返回新路径。
#[tauri::command]
fn rename_entry(path: String, new_name: String) -> Result<String, String> {
    ops::rename_entry(&path, &new_name)
}

/// 删除条目（进回收站）。
#[tauri::command]
fn delete_entries(paths: Vec<String>) -> Result<(), String> {
    ops::delete_entries(&paths)
}

/// 永久删除条目（绕过回收站）。
#[tauri::command]
fn permanent_delete_entries(paths: Vec<String>) -> Result<(), String> {
    ops::permanent_delete_entries(&paths)
}

/// 新建文件夹。
#[tauri::command]
fn create_dir(parent: String, name: String) -> Result<String, String> {
    ops::create_dir(&parent, &name)
}

/// 新建空文件。
#[tauri::command]
fn create_file(parent: String, name: String) -> Result<String, String> {
    ops::create_file(&parent, &name)
}

/// 内容搜索（VSCode 风格，字面量关键词；默认仅当前层）。
#[tauri::command]
async fn search_content(
    query: String,
    dir: String,
    recursive: bool,
    case_sensitive: bool,
) -> Result<Vec<SearchMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search::search_content(&query, &dir, recursive, case_sensitive)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 快速文件检索（fd 语义：正则 + smart case + 递归）。
#[tauri::command]
async fn find_files(
    pattern: String,
    dir: String,
    show_hidden: bool,
    max_depth: Option<usize>,
) -> Result<Vec<FindEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        find::find_files(&pattern, &dir, show_hidden, max_depth)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            list_dir,
            complete_path,
            get_volumes,
            get_quick_access,
            get_home_dir,
            parent_dir,
            stat_path,
            copy_entries,
            move_entries,
            rename_entry,
            delete_entries,
            permanent_delete_entries,
            create_dir,
            create_file,
            search_content,
            find_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
