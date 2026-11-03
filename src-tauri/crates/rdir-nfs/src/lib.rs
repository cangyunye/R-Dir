//! R-Dir NFS 插件 crate：一个 crate 两种形态——
//! ① `client`（库）：NFSv3 客户端本体，主程序 `feature = "nfs"` 直接内嵌编译（InProcess 后端）；
//! ② `rdir-nfs`（二进制，`required-features = ["client"]`）：同一客户端包上 stdio JSON 行协议
//!    作为伴生进程插件发行（.rdplugin），主程序发行版不带 NFS 时经插件动态获得能力。
//! 协议类型在 [`protocol`]（两侧都编译），客户端在 [`client`]（feature 门控）。

pub mod protocol;

#[cfg(feature = "client")]
pub mod client;
#[cfg(feature = "client")]
pub mod server;
