/** 设置里「图库（选填）」：Pexels、Pixabay 两个输入框，填了才用实拍视频空镜 */
import { useStockKeys } from '../../useStockKeys';
import { errText } from '../../useWorkbench';
import { StockKeyRow, STOCK_HELP } from './StockKeyRow';

export function StockKeys({ notify }: { notify: (m: string) => void }) {
  const { keys, loadError, save, remove } = useStockKeys();
  const configured = [keys.pexels, keys.pixabay].filter((k) => k.configured).length;
  return (
    <div className="stock">
      <p className="stock-help">{STOCK_HELP}。<span className="stock-sub">不填时用 Wikimedia、网页截图和 AI 生成补足。</span></p>
      {loadError && <p className="stock-msg error" role="alert">读取图库设置失败：{loadError}</p>}
      <StockKeyRow provider="pexels" info={keys.pexels} onSave={(k) => save('pexels', k)} onRemove={() => void remove('pexels').catch((e) => notify(`移除失败：${errText(e)}`))} />
      <StockKeyRow provider="pixabay" info={keys.pixabay} onSave={(k) => save('pixabay', k)} onRemove={() => void remove('pixabay').catch((e) => notify(`移除失败：${errText(e)}`))} />
      <span className="sr" aria-live="polite">{configured === 0 ? '图库未设置' : `已设置 ${configured} 个图库`}</span>
    </div>
  );
}
