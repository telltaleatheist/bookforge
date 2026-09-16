/** Public pairing progress. Credentials and the private device code stay in main. */
export interface RemotePairingProgress {
  id: string;
  name: string;
  url: string;
  userCode: string;
  expiresAt: number;
  pollAfterMs: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
}

export interface IncomingPairingRequest {
  id: string;
  userCode: string;
  clientName: string;
  address: string;
  expiresIn: number;
}
