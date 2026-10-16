//! Windows：把工作台服务（node）放进 Job Object，设 KILL_ON_JOB_CLOSE。
//! node 再起的 ffmpeg、chrome-headless-shell 默认也在同一个 Job 里；
//! Job 句柄关闭（启动器退出、被强杀、或 `Service` 被丢弃）时整棵进程树一起结束。
#![cfg(windows)]

use std::os::windows::io::AsRawHandle;
use std::process::Child;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub struct Job(HANDLE);

// SAFETY：Job 句柄可在任意线程使用与关闭
unsafe impl Send for Job {}

impl Job {
    /// 创建 Job 并把子进程放进去；任何一步失败返回 None（退回到只靠 stdin 看门狗）。
    pub fn attach(child: &Child) -> Option<Job> {
        // SAFETY：参数均为合法指针或空指针；失败时句柄由 Job 的 Drop 关闭
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let job = Job(handle);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 || AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) == 0 {
                return None;
            }
            Some(job)
        }
    }

    /// 立即结束 Job 里的全部进程（强杀用）。
    pub fn terminate(&self) {
        // SAFETY：句柄在 Job 存活期间有效
        unsafe {
            TerminateJobObject(self.0, 1);
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY：只关闭一次；KILL_ON_JOB_CLOSE 会结束仍在运行的进程
        unsafe {
            CloseHandle(self.0);
        }
    }
}
