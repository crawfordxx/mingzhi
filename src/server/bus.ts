import { rmSync } from 'node:fs';
import { EventBus, type WorkEvent, type WorkEventInput } from '../workspace/events.js';

/**
 * 服务端的事件总线：
 * 1. 所有进入 events.jsonl 与 SSE 的文本先抹除 key（模型错误、网关回显等都可能带上）；
 * 2. 没有对应版本的 failed 事件（任务在运行器建版本前就失败或被取消）照常推给在线订阅者，
 *    但随后清掉版本目录里残留的事件文件，免得污染以后同号的新版本。
 */
export class ServerBus extends EventBus {
  constructor(
    private readonly dirOf: (spaceId: string, version: number) => string,
    private readonly redact: (text: string) => string,
    private readonly versionExists: (spaceId: string, version: number) => boolean,
  ) {
    super(dirOf);
  }

  override publish(input: WorkEventInput): WorkEvent {
    const event = super.publish(this.clean(input));
    if (event.step === 'failed' && !this.versionExists(event.spaceId, event.version)) {
      rmSync(this.dirOf(event.spaceId, event.version), { recursive: true, force: true });
    }
    return event;
  }

  private clean(input: WorkEventInput): WorkEventInput {
    const { detail, ...rest } = input;
    const base = { ...rest, message: this.redact(input.message) };
    if (!detail) return base;
    const text = JSON.stringify(detail);
    const cleaned = this.redact(text);
    return { ...base, detail: cleaned === text ? detail : (JSON.parse(cleaned) as WorkEventInput['detail']) };
  }
}
