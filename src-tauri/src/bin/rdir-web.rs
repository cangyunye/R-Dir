//! rdir-web：R-Dir 无窗口 web 服务（web feature 独占二进制）。
//!
//! 与 GUI 版共用 lib 全部模块（fs_ops/volumes/fs_watch/preview/thumbs/…），
//! 通过 HTTP 透传命令 + WS 广播事件，把同一套前端跑在浏览器里。
//! 无 WebView2 / 窗口运行时依赖，可跑在无桌面的 Windows Server / NAS。
//!
//! 用法：
//! ```text
//! rdir-web [--listen HOST:PORT] [--token TOKEN] [--data-dir DIR] [--read-only]
//! ```
//!
//! 安全：
//! - 默认监听 127.0.0.1，启动时打印带令牌的 /login 链接（换 cookie 进站）
//! - `--listen 0.0.0.0` 开放局域网属使用者显式选择；外网暴露请套反向代理（无内置 TLS）
//!
//! 编译：`pnpm build && cargo build --release --features web --bin rdir-web`
//! （rust-embed 在编译期内嵌 ../dist，需先产出前端构建）

use rust_file_manager_lib::{paths, web, web::WebOptions};
use std::net::SocketAddr;
use std::path::PathBuf;

const DEFAULT_LISTEN: &str = "127.0.0.1:8420";
/// 与 tauri.conf.json identifier 一致：非便携模式下复用 GUI 版的数据目录
const APP_IDENTIFIER: &str = "com.rfm.app";

fn main() {
    let cli = match parse_args() {
        Ok(o) => o,
        Err(msg) => {
            eprintln!("{msg}");
            eprintln!();
            print_usage();
            std::process::exit(2);
        }
    };
    let listen: SocketAddr = match cli.listen.parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("--listen 不合法（{}）：{e}", cli.listen);
            std::process::exit(2);
        }
    };

    let (config_dir, data_dir) = resolve_dirs(cli.data_dir.as_deref());
    let token = cli.token.clone();

    eprintln!("[rdir-web] R-Dir 无窗口 web 服务");
    eprintln!("[rdir-web] 监听  http://{}", cli.listen);
    eprintln!("[rdir-web] 访问  http://{}/login?k={}", cli.listen, token);
    if cli.listen.starts_with("0.0.0.0") {
        eprintln!("[rdir-web] 提示  已对局域网开放；外网暴露请套反向代理（无内置 TLS）");
    }
    eprintln!("[rdir-web] 数据  {}", config_dir.display());
    if cli.read_only {
        eprintln!("[rdir-web] 只读模式已开启");
    }
    eprintln!("[rdir-web] Ctrl+C 停止服务");

    let opts = WebOptions {
        listen,
        token,
        read_only: cli.read_only,
        config_dir,
        data_dir,
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("构建 tokio 运行时失败");
    if let Err(e) = runtime.block_on(web::serve(rust_file_manager_lib::AppState::default(), opts)) {
        eprintln!("[rdir-web] {e}");
        std::process::exit(1);
    }
}

struct CliOptions {
    listen: String,
    token: String,
    data_dir: Option<String>,
    read_only: bool,
}

fn parse_args() -> Result<CliOptions, String> {
    let mut o = CliOptions {
        listen: DEFAULT_LISTEN.into(),
        token: gen_token(),
        data_dir: None,
        read_only: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--listen" => o.listen = it.next().ok_or("--listen 需要参数（如 127.0.0.1:8420）")?,
            "--token" => {
                o.token = it.next().ok_or("--token 需要参数")?;
                if o.token.len() < 8 {
                    return Err("--token 过短（至少 8 位）".into());
                }
            }
            "--data-dir" => o.data_dir = Some(it.next().ok_or("--data-dir 需要参数")?),
            "--read-only" => o.read_only = true,
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            other => return Err(format!("未知参数：{other}")),
        }
    }
    Ok(o)
}

fn print_usage() {
    eprintln!(
        "rdir-web —— R-Dir 无窗口 web 服务\n\n\
         用法: rdir-web [选项]\n\n\
         选项:\n\
           --listen HOST:PORT   监听地址（默认 {DEFAULT_LISTEN}；0.0.0.0 开放局域网）\n\
           --token TOKEN        访问令牌（默认随机 32 位 hex，启动时打印进站链接）\n\
           --data-dir DIR       数据目录（默认便携标记 > 用户配置目录）\n\
           --read-only          只读模式（后续批次写类命令的服务端拦截开关）\n\
           -h, --help           显示本帮助"
    );
}

/// 随机 32 位 hex 令牌（与 GUI 分享链接的 gen_token 形态一致）
fn gen_token() -> String {
    use rand::Rng as _;
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| format!("{:x}", rng.gen_range(0..16)))
        .collect()
}

/// 数据目录解析：--data-dir > 便携标记（exe 旁 R-Dir.portable → data/{config,data}）
/// > 用户配置目录（与 GUI 安装版同落点，%APPDATA%/com.rfm.app 等）。
fn resolve_dirs(arg: Option<&str>) -> (PathBuf, PathBuf) {
    if let Some(d) = arg {
        let root = PathBuf::from(d);
        return (root.join("config"), root.join("data"));
    }
    if let Some(root) = paths::portable_data_root() {
        return (root.join("config"), root.join("data"));
    }
    let base = dirs::config_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(APP_IDENTIFIER);
    (base.clone(), base)
}
