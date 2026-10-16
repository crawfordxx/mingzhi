//! 逐项进度：登记、阶段、字节、速度、错误。

mod common;

use common::item;
use mingzhi_launcher::progress::{Phase, Progress};

#[test]
fn 登记保持清单顺序且重复登记不清空() {
    let p = Progress::new();
    let a = item("a", b"aaaa", "data/a", vec!["http://x/a".into()]);
    let mut b = item("b", b"bb", "data/b", vec!["http://x/b".into()]);
    b.optional = true;
    p.register(&[&a, &b]);
    p.item_add("a", 3);
    p.register(&[&a, &b]);

    let items = p.items();
    assert_eq!(
        items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
        ["a", "b"]
    );
    assert_eq!(items[0].downloaded, 3);
    assert_eq!(items[0].size, 4);
    assert_eq!(items[0].phase, Phase::Checking);
    assert!(items[1].optional);
}

#[test]
fn 进入等待时清零字节并标记为本次需要() {
    let p = Progress::new();
    let a = item("a", b"aaaa", "data/a", vec!["http://x/a".into()]);
    p.register(&[&a]);
    p.item_add("a", 2);
    p.set_phase("a", Phase::Waiting);
    let s = &p.items()[0];
    assert_eq!(s.downloaded, 0);
    assert!(s.needed);
    assert_eq!(s.phase, Phase::Waiting);
}

#[test]
fn 失败记录错误重新等待时清除() {
    let p = Progress::new();
    let a = item("a", b"aaaa", "data/a", vec!["http://x/a".into()]);
    p.register(&[&a]);
    p.fail("a", Phase::Failed, "坏了");
    assert_eq!(p.items()[0].error.as_deref(), Some("坏了"));
    assert_eq!(p.items()[0].phase, Phase::Failed);
    p.set_phase("a", Phase::Waiting);
    assert_eq!(p.items()[0].error, None);
}

#[test]
fn 单项字节计入总量且可回退() {
    let p = Progress::new();
    let a = item("a", b"aaaa", "data/a", vec!["http://x/a".into()]);
    p.register(&[&a]);
    p.item_add("a", 4);
    p.item_sub("a", 1);
    assert_eq!(p.items()[0].downloaded, 3);
    assert_eq!(p.snapshot().downloaded, 3);
    // 未登记的 id 只计总量，不报错
    p.item_add("zzz", 1);
    assert_eq!(p.snapshot().downloaded, 4);
}

#[test]
fn 单项速度() {
    let p = Progress::new();
    let a = item("a", &[0u8; 10], "data/a", vec!["http://x/a".into()]);
    p.register(&[&a]);
    p.set_phase("a", Phase::Waiting);
    p.set_phase("a", Phase::Downloading);
    p.items();
    std::thread::sleep(std::time::Duration::from_millis(600));
    p.item_add("a", 600_000);
    let speed = p.items()[0].bytes_per_sec;
    assert!(speed > 100_000.0 && speed < 1_200_000.0, "{speed}");
}

#[test]
fn 不在下载中的项速度为零() {
    let p = Progress::new();
    let a = item("a", &[0u8; 10], "data/a", vec!["http://x/a".into()]);
    p.register(&[&a]);
    p.item_add("a", 5);
    assert_eq!(p.items()[0].bytes_per_sec, 0.0);
}
