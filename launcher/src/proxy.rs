//! 代理解析：环境变量优先，macOS 再用 `scutil --proxy` 的系统代理兜底。
//! 回环地址与 NO_PROXY 命中的主机一律直连。

/// 解析结果：分别对应 https / http 目标使用的代理（`http://host:port` 形式）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProxyConfig {
    https: Option<String>,
    http: Option<String>,
    no_proxy: Vec<String>,
}

impl ProxyConfig {
    /// 不使用任何代理（测试用）。
    pub fn none() -> Self {
        Self::default()
    }

    /// 读取真实环境；仅 macOS 且环境变量未给出时才会执行 `scutil --proxy`。
    pub fn from_env() -> Self {
        Self::from_sources(|k| std::env::var(k).ok(), scutil_output)
    }

    /// 可注入环境与 scutil 输出，便于测试。
    pub fn from_sources(
        get: impl Fn(&str) -> Option<String>,
        scutil: impl FnOnce() -> Option<String>,
    ) -> Self {
        let first = |keys: &[&str]| {
            keys.iter()
                .find_map(|k| get(k).filter(|v| !v.trim().is_empty()))
        };
        let env_https = first(&["HTTPS_PROXY", "https_proxy"]);
        let env_http = first(&["HTTP_PROXY", "http_proxy"]);
        let no_proxy = first(&["NO_PROXY", "no_proxy"])
            .map(|v| {
                v.split(',')
                    .map(|s| s.trim().to_ascii_lowercase())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        // 环境变量没给全时才去问系统
        let (sys_http, sys_https) = if env_https.is_none() || env_http.is_none() {
            scutil().map(|o| parse_scutil(&o)).unwrap_or((None, None))
        } else {
            (None, None)
        };

        // 只设了 HTTP_PROXY 的用户很常见，https 目标也沿用它
        let https = env_https
            .or(env_http.clone())
            .or(sys_https)
            .or(sys_http.clone());
        let http = env_http.or(sys_http);
        Self {
            https: https.and_then(normalize),
            http: http.and_then(normalize),
            no_proxy,
        }
    }

    /// 访问该 URL 应使用的代理；None 表示直连。
    pub fn proxy_for(&self, url: &str) -> Option<&str> {
        let host = host_of(url)?;
        if is_loopback(&host) || self.matches_no_proxy(&host) {
            return None;
        }
        let proxy = if url.starts_with("https://") {
            &self.https
        } else {
            &self.http
        };
        proxy.as_deref()
    }

    fn matches_no_proxy(&self, host: &str) -> bool {
        self.no_proxy.iter().any(|entry| {
            if entry == "*" {
                return true;
            }
            let e = entry.trim_start_matches("*.").trim_start_matches('.');
            host == e || host.ends_with(&format!(".{e}"))
        })
    }
}

/// 只接受 ureq 能直接用的 http 代理；socks 等忽略。补全缺省的 scheme。
fn normalize(raw: String) -> Option<String> {
    let raw = raw.trim().trim_end_matches('/').to_string();
    if raw.starts_with("http://") {
        Some(raw)
    } else if raw.contains("://") {
        None
    } else {
        Some(format!("http://{raw}"))
    }
}

fn is_loopback(host: &str) -> bool {
    host == "localhost" || host == "::1" || host.starts_with("127.")
}

/// 从 URL 里取小写主机名（去掉 userinfo、端口与 IPv6 方括号）。
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next()?;
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next()?
    } else {
        authority.split(':').next()?
    };
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// 解析 `scutil --proxy` 输出，返回 (http 代理, https 代理)。
pub fn parse_scutil(output: &str) -> (Option<String>, Option<String>) {
    let field = |key: &str| -> Option<String> {
        output.lines().find_map(|line| {
            let (k, v) = line.split_once(':')?;
            (k.trim() == key).then(|| v.trim().to_string())
        })
    };
    let pick = |prefix: &str| -> Option<String> {
        if field(&format!("{prefix}Enable"))? != "1" {
            return None;
        }
        let host = field(&format!("{prefix}Proxy"))?;
        let port = field(&format!("{prefix}Port"))?;
        Some(format!("http://{host}:{port}"))
    };
    (pick("HTTP"), pick("HTTPS"))
}

fn scutil_output() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = std::process::Command::new("scutil")
        .arg("--proxy")
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}
