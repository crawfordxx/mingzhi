// onnxruntime-node 1.20.1 的包内缺少 dist/index.d.ts，这里只声明 rvm.ts 用到的最小接口
declare module 'onnxruntime-node' {
  namespace ort {
    class Tensor {
      constructor(type: 'float32', data: Float32Array, dims: readonly number[]);
      readonly data: Float32Array | ArrayLike<number>;
      readonly dims: readonly number[];
    }
    interface InferenceSession {
      run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
    }
    const InferenceSession: {
      create(path: string, options?: { executionProviders?: string[] }): Promise<InferenceSession>;
    };
  }
  export default ort;
}
