// A test server on a free local port that fetch() will talk to: the OS's random pick can be one of the ports the Fetch
// standard blocks (1719, 6000, ...), and fetch then refuses with "bad port" — a test that fails now and then. Picks again.
import type { Server } from 'node:http';

// the Fetch standard's bad ports above 1023 (the OS doesn't hand out lower ones for port 0)
const BAD_PORTS = [
  '1719',
  '1720',
  '1723',
  '2049',
  '3659',
  '4045',
  '4190',
  '5060',
  '5061',
  '6000',
  '6566',
  '6665',
  '6666',
  '6667',
  '6668',
  '6669',
  '6679',
  '6697',
  '10080',
];
const BAD = new Set(BAD_PORTS.map(Number));
const MAX_ATTEMPTS = 20;

export async function listenLocal(server: Server): Promise<number> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as { port: number }).port;
    if (!BAD.has(port)) {
      return port;
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
  throw new Error('no usable local port for a test server');
}
