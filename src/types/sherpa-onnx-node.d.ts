// sherpa-onnx-node 没有自带类型，这里只声明本项目用到的部分
declare module 'sherpa-onnx-node' {
  interface Wave { samples: Float32Array; sampleRate: number }
  interface VadSegment { start: number; samples: Float32Array }
  interface OfflineResult { text: string; tokens: string[]; timestamps: number[] }
  interface OfflineStream { acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void }
  class Vad {
    constructor(config: unknown, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    front(): VadSegment;
    pop(): void;
    flush(): void;
  }
  class OfflineRecognizer {
    constructor(config: unknown);
    createStream(): OfflineStream;
    decode(stream: OfflineStream): void;
    getResult(stream: OfflineStream): OfflineResult;
  }
  const sherpa: { readWave(path: string): Wave; Vad: typeof Vad; OfflineRecognizer: typeof OfflineRecognizer };
  export default sherpa;
}
