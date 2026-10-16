//! 低配检测：CPU 核数 < 8 或内存 < 16GB 时，进度页提示「出片会慢一些」（本期只提示）。

const GIB: u64 = 1024 * 1024 * 1024;
const MIN_CORES: usize = 8;
/// 16GB 的机器在 Windows 上可用物理内存常报 15.x GB（被保留一部分），按 15 GiB 判定避免误报
const MIN_MEMORY: u64 = 15 * GIB;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SystemSpec {
    pub cores: usize,
    /// 物理内存字节数；读不到时为 0
    pub memory: u64,
}

impl SystemSpec {
    pub fn detect() -> Self {
        Self {
            cores: std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(0),
            memory: total_memory().unwrap_or(0),
        }
    }
}

/// 低配时返回提示文案。
pub fn low_spec_note(spec: &SystemSpec) -> Option<String> {
    let few_cores = spec.cores > 0 && spec.cores < MIN_CORES;
    let low_mem = spec.memory > 0 && spec.memory < MIN_MEMORY;
    if !few_cores && !low_mem {
        return None;
    }
    let gb = (spec.memory as f64 / GIB as f64).round() as u64;
    let mem = if spec.memory > 0 {
        format!(" / {gb} GB 内存")
    } else {
        String::new()
    };
    Some(format!(
        "这台电脑配置偏低（{} 核{mem}），能正常用，出片会慢一些",
        spec.cores
    ))
}

#[cfg(target_os = "macos")]
fn total_memory() -> Option<u64> {
    let out = std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[cfg(windows)]
fn total_memory() -> Option<u64> {
    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
    }
    let mut status = MemoryStatusEx {
        length: std::mem::size_of::<MemoryStatusEx>() as u32,
        memory_load: 0,
        total_phys: 0,
        avail_phys: 0,
        total_page_file: 0,
        avail_page_file: 0,
        total_virtual: 0,
        avail_virtual: 0,
        avail_extended_virtual: 0,
    };
    // SAFETY：结构体布局与 MEMORYSTATUSEX 一致，length 已按要求填好
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    (ok != 0).then_some(status.total_phys)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn total_memory() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    let kb: u64 = text
        .lines()
        .find(|l| l.starts_with("MemTotal:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()?;
    Some(kb * 1024)
}
