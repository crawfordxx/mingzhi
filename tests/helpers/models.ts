import { loadConfig } from '../../src/config.js';
import { modelsReady } from '../../src/asr/local-asr.js';

export const hasModels = (): boolean => modelsReady(loadConfig({}).modelsDir);
import { rvmReady } from '../../src/matting/rvm.js';
export const hasRvm = (): boolean => rvmReady(loadConfig({}).modelsDir);
