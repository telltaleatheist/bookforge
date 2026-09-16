/** Only the short matching code crosses into the renderer. */
export interface CruciblePairingPrompt {
  requestId: string;
  name: string;
  url: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}
export type CruciblePairingDecision =
  | { status: 'pending' | 'denied' | 'expired' }
  | { status: 'approved'; name: string };
