export interface EngineUpgradeProgress {
  server: string;
  state: 'running' | 'done' | 'failed';
  message: string;
}
