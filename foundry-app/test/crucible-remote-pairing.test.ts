import { expect, mock, test } from 'bun:test';
import { RemotePairingSessions } from '../electron/crucible-remote-pairing';

const request = { url: 'http://mac-studio:7100', name: 'Mac Studio', id: 'server-id',
  deviceCode: 'private-exchange-code', userCode: 'ABCD-1234', expiresIn: 120, interval: 2 };
const pairing = { name: 'Mac Studio', url: request.url, token: 'private-token' };

test('remote pairing keeps exchange credentials and approved token out of renderer responses', async () => {
  const connect = mock(async () => {});
  const sessions = new RemotePairingSessions(connect, async () => request,
    async () => ({ status: 'approved', pairing }));
  const started = await sessions.begin(7, 'mac-studio');
  expect(JSON.stringify(started)).not.toContain(request.deviceCode);
  expect(started.id).not.toBe(request.id);
  const approved = await sessions.poll(7, started.id);
  expect(approved.status).toBe('approved');
  expect(connect).toHaveBeenCalledWith(pairing);
  expect(JSON.stringify(approved)).not.toContain(pairing.token);
  await expect(sessions.poll(7, started.id)).rejects.toThrow('no longer available');
});

test('another window cannot poll or consume a pairing request', async () => {
  const poll = mock(async () => ({ status: 'pending' as const }));
  const sessions = new RemotePairingSessions(async () => {}, async () => request, poll);
  const started = await sessions.begin(7, 'mac-studio');
  await expect(sessions.poll(8, started.id)).rejects.toThrow('no longer available');
  expect(poll).not.toHaveBeenCalled();
});

test('expired requests cannot register a connection', async () => {
  let now = 0;
  const connect = mock(async () => {});
  const poll = mock(async () => ({ status: 'approved' as const, pairing }));
  const sessions = new RemotePairingSessions(connect, async () => request, poll, () => now);
  const started = await sessions.begin(7, 'mac-studio');
  now = 121_000;
  expect((await sessions.poll(7, started.id)).status).toBe('expired');
  expect(connect).not.toHaveBeenCalled();
  expect(poll).not.toHaveBeenCalled();
});

test('cancellation during request creation cannot retain a hidden session', async () => {
  let finish!: (value: typeof request) => void;
  const creating = new Promise<typeof request>((resolve) => { finish = resolve; });
  const sessions = new RemotePairingSessions(async () => {}, async () => creating, async () => ({ status: 'pending' }));
  const pending = sessions.begin(7, 'mac-studio');
  sessions.cancelOwner(7);
  finish(request);
  await expect(pending).rejects.toThrow('cancelled');
});

test('cancellation during approval prevents registry mutation', async () => {
  let finish!: (value: { status: 'approved'; pairing: typeof pairing }) => void;
  const response = new Promise<{ status: 'approved'; pairing: typeof pairing }>((resolve) => { finish = resolve; });
  const connect = mock(async () => {});
  const sessions = new RemotePairingSessions(connect, async () => request, async () => response);
  const started = await sessions.begin(7, 'mac-studio');
  const pending = sessions.poll(7, started.id);
  sessions.cancelOwner(7);
  finish({ status: 'approved', pairing });
  await expect(pending).rejects.toThrow('cancelled');
  expect(connect).not.toHaveBeenCalled();
});
