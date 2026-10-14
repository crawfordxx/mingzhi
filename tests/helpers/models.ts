import { loadConfig } from '../../src/config.js';
import { modelsReady } from '../../src/asr/local-asr.js';

export const hasModels = (): boolean => modelsReady(loadConfig({}).modelsDir);
