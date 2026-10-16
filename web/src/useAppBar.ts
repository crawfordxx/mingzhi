/** 公告条右端的状态：心跳、检查更新开关、新版本、退出 */
import { useCallback, useEffect, useState } from 'react';
import { api, type Status, type UpdateInfo } from './api';
import { updateToShow } from './lib/appbar';
import { errText } from './useWorkbench';

/** 页面开着就每分钟 ping 一次：服务在没有浏览器、没有任务满 2 小时后才会自动退出 */
const PING_MS = 60_000;
/** 首屏时服务可能还没查完更新：过一会儿再看一次（只一次） */
const RECHECK_MS = 20_000;

function usePing(active: boolean) {
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => { api.ping().catch(() => undefined); }, PING_MS);
    return () => window.clearInterval(id);
  }, [active]);
}

/** 服务端给的新版本：首屏的 status 没有时，过 20 秒再取一次 status */
function useLatest(status: Status | undefined) {
  const [late, setLate] = useState<UpdateInfo>();
  useEffect(() => {
    if (!status || status.update) return undefined;
    const id = window.setTimeout(() => { api.status().then((s) => setLate(s.update), () => undefined); }, RECHECK_MS);
    return () => window.clearTimeout(id);
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
