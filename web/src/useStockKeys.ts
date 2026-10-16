/** 图库 key（选填）的状态：读取、校验并保存、移除；完整 key 只在保存那一刻经过这里，不留在状态里 */
import { useCallback, useEffect, useState } from 'react';
import { api, type StockKeys, type StockProvider } from './api';
import { errText } from './useWorkbench';

const NONE: StockKeys = { pexels: { configured: false }, pixabay: { configured: false } };

export function useStockKeys() {
  const [keys, setKeys] = useState<StockKeys>(NONE);
  const [loadError, setLoadError] = useState<string>();
  useEffect(() => {
    let live = true;
    api.stockKeys().then((k) => { if (live) setKeys(k); }, (err) => { if (live) setLoadError(errText(err)); });
    return () => { live = false; };
  }, []);

  /** 校验失败会抛出带中文原因的错误，由调用的输入行显示 */
  const save = useCallback(async (provider: StockProvider, key: string) => { setKeys(await api.saveStockKey(provider, key)); }, []);
  const remove = useCallback(async (provider: StockProvider) => {
    await api.deleteStockKey(provider);
    setKeys(await api.stockKeys());
  }, []);
  return { keys, loadError, save, remove };
}
