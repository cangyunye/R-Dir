//! rdir-nfs 伴生进程入口：stdin/stdout 跑 JSON 行协议（protocol::serve），
//! 诊断日志走 stderr。stdin EOF（host 退出/崩溃）即自然退出，无守护需求。

#[tokio::main(flavor = "current_thread")]
async fn main() {
    eprintln!(
        "rdir-nfs v{} (protocol v{})",
        env!("CARGO_PKG_VERSION"),
        rdir_nfs::protocol::PROTOCOL_VERSION
    );
    if let Err(e) = rdir_nfs::server::serve(tokio::io::stdin(), tokio::io::stdout()).await {
        eprintln!("rdir-nfs 服务异常退出：{e}");
        std::process::exit(1);
    }
}
