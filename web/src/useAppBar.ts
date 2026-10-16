/** 公告条右端的状态：心跳、检查更新开关、新版本、退出 */
import { useCallback, useEffect, useState } from 'react';
import { api, type Status, type UpdateInfo } from './api';
import { updateToShow } from './lib/appbar';
import { errText } from './useWorkbench';

/** 页面开着就每分钟 ping 一次：服务在没有浏览器、没有任务满 2 小时后才会自动退出 */
const PING_MS = 60_000;
/** 首屏时服务可能还没查完更新：20 秒后再看一次；之后页面一直开着就每 6 小时看一次（服务端每天最多真查一次） */
const FIRST_RECHECK_MS = 20_000;
const RECHECK_MS = 6 * 3600_000;

function usePing(active: boolean) {
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => { api.ping().catch(() => undefined); }, PING_MS);
    return () => window.clearInterval(id);
  }, [active]);
}

/** 服务端给的新版本：首屏之后定时重取 status（开着页面好几天也能看到新版本） */
function useLatest(status: Status | undefined) {
  const [late, setLate] = useState<UpdateInfo>();
  useEffect(() => {
    if (!status) return undefined;
    const fetchLatest = () => { api.status().then((s) => { if (s.update) setLate(s.update); }, () => undefined); };
    let every = 0;
    const first = window.setTimeout(() => { fetchLatest(); every = window.setInterval(fetchLatest, RECHECK_MS); }, FIRST_RECHECK_MS);
    return () => { window.clearTimeout(first); window.clearInterval(every); };
  }, [status]);
  return status && late ? { ...status, update: late } : status;
}

export function useAppBar(status: Status | undefined, notify: (m: string) => void) {
  const [checkUpdates, setCheck] = useState<boolean>();
  const [exited, setExited] = useState(false);
  usePing(!exited);
  useEffect(() => { api.prefs().then((p) => setCheck(p.checkUpdates), () => undefined); }, []);
  const update = updateToShow(useLatest(status), checkUpdates);

  const toggleUpdates = useCallback(async (on: boolean) => {
    setCheck(on);
    try {
      setCheck((await api.setPrefs({ checkUpdates: on })).checkUpdates);
    } catch (err) {
      setCheck(!on);
      notify(`没保存上：${errText(err)}`);
    }
  }, [notify]);

  /** 成功返回 true；失败时提示并返回 false */
  const quit = useCallback(async (): Promise<boolean> => {
    try {
      await api.shutdown();
      setExited(true);
      return true;
    } catch (err) {
      notify(`退出失败：${errText(err)}`);
      return false;
    }
  }, [notify]);

  return { version: status?.version, update, checkUpdates, toggleUpdates, quit, exited };
}

export type AppBarState = ReturnType<typeof useAppBar>;
