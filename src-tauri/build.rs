fn main() {
    // tauri_build 只声明 tauri.conf.json / capabilities 的重跑条件，
    // 不追踪图标 —— 不加这行，改图标后重编译仍会嵌入旧资源
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
