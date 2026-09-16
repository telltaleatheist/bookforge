export interface CrucibleEngineUpgradeProgress {
  server: string;
  state: 'running' | 'done' | 'failed';
  message: string;
}
export interface CrucibleConnectionApproval {
  id: string;
  clientName: string;
  userCode: string;
  expiresIn: number;
  address: string;
}
