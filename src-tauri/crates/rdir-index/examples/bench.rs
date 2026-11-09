//! 性能冒烟（真实目录树）：
//!   cargo run -p rdir-index --release --example bench -- <目录> [查询词...]
//! 输出：全量构建耗时/条目数/内存粗估、各查询词命中数与耗时、增量重扫耗时。

use rdir_index::{EngineState, Exclusions, MatchMode};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("用法: bench <目录> [查询词...]");
        std::process::exit(1);
    }
    let (roots, queries) = args.split_at(1);
    let roots: Vec<String> = roots.to_vec();

    let t0 = Instant::now();
    let (st, errs) = EngineState::build_full(&roots, &Exclusions::default());
    println!("全量构建：{} 条目，{} 项跳过，{:?}", st.len(), errs, t0.elapsed());

    let arena_mb = st.arena_len() as f64 / 1024.0 / 1024.0;
    let meta_mb = (st.meta.len() * std::mem::size_of::<rdir_index::EntryMeta>()) as f64 / 1024.0 / 1024.0;
    let grams_mb: usize = st.grams.map.values().map(|v| v.len() * 4 + 24).sum();
    println!(
        "内存粗估：arena {:.1} MB + meta {:.1} MB + 倒排 {:.1} MB ≈ {:.1} MB",
        arena_mb,
        meta_mb,
        grams_mb as f64 / 1024.0 / 1024.0,
        arena_mb + meta_mb + grams_mb as f64 / 1024.0 / 1024.0
    );

    for q in queries {
        let t1 = Instant::now();
        let hits = st.query(q, MatchMode::Contains, false, None).unwrap();
        println!("查询 {:?}: {} 命中（截 500），{:?}", q, hits.len(), t1.elapsed());
    }

    let t2 = Instant::now();
    match EngineState::rescan(&st, &roots, &Exclusions::default()) {
        None => println!("增量重扫：无变化（零重建），{:?}", t2.elapsed()),
        Some(n) => println!("增量重扫：重建 {} 条，{:?}", n.len(), t2.elapsed()),
    }
}
