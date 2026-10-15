import { loadConfig } from '../../src/config.js';
import { modelsReady } from '../../src/asr/local-asr.js';
import { rvmReady } from '../../src/matting/rvm.js';

export const hasModels = (): boolean => modelsReady(loadConfig({}).modelsDir);
export const hasRvm = (): boolean => rvmReady(loadConfig({}).modelsDir);
