/**
 * 素材来源面板的数据与动作：读取某个版本的 credits、标记替换 / 删除、复制署名文本。
 * 标记写进版本目录（credits-marks.json）后，若这条素材用在某个镜头上，随即提交「换一张 B-roll」修改（replaceBroll）；
 * 提交不成功时标记仍在，提示用户。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type CreditItem, type CreditMark } from './api';
import type { CreditsView } from './components/CreditsPanel';
import { copyText } from './lib/clipboard';
import { errText, type Notify } from './useWorkbench';

interface Deps { spaceId: string; version: number; notify: Notify; refresh: (id: string) => Promise<void> }

const SUMMARY: Record<CreditMark, string> = { replace: '换一张 B-roll', remove: '去掉一段 B-roll' };

export function useCredits({ spaceId, version, notify, refresh }: Deps) {
  const [view, setView] = useState<CreditsView>({ kind: 'loading' });
  const [busy, setBusy] = useState<string>();

  useEffect(() => {
    let live = true;
    setView({ kind: 'loading' });
    api.credits(spaceId, version).then(
      (credits) => { if (live) setView({ kind: 'ready', credits }); },
      (err) => { if (live) setView({ kind: 'error', message: errText(err) }); },
    );
    return () => { live = false; };
  }, [spaceId, version]);

  const markLocal = useCallback((file: string, action: CreditMark) => {
    setView((v) => (v.kind !== 'ready' ? v : { kind: 'ready', credits: { ...v.credits, entries: v.credits.entries.map((e) => (e.file === file ? { ...e, mark: action } : e)) } }));
  }, []);

  const mark = useCallback(async (item: CreditItem, action: CreditMark) => {
    setBusy(item.file);
    try {
      await api.markCredit(spaceId, version, item.file, action);
      markLocal(item.file, action);
    } catch (err) {
      notify(`标记失败：${errText(err)}`);
      setBusy(undefined);
      return;
    }
    try {
      if (item.shotIndex === undefined) {
        notify('已标记，下次改片时处理（这条素材没有对应的镜头，暂不能直接出新版本）');
      } else {
        await api.apply(spaceId, [{ type: 'replaceBroll', shotIndex: item.shotIndex }], version, SUMMARY[action]);
        await refresh(spaceId);
        notify(`已提交「${SUMMARY[action]}」，新版本出片中`);
      }
    } catch (err) {
      notify(`已标记，但没能提交修改：${errText(err)}`);
    } finally {
      setBusy(undefined);
    }
  }, [spaceId, version, notify, refresh, markLocal]);

  const attribution = view.kind === 'ready' ? view.credits.attribution : '';
  const copy = useCallback(() => {
    void copyText(attribution).then((ok) => notify(ok ? '署名文本已复制，发布时贴在正文末尾' : '复制失败，请手动选中署名文本复制'));
  }, [attribution, notify]);

  return { view, busy, mark, copy };
}
