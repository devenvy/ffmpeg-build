// A fake GitHub REST API (releases and their assets) for repo o/r, and a tar writer, for the fetch and release tests.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';

import { listenLocal } from './listen.ts';
import { formatManifest, type Manifest, type ManifestTarget } from '../src/manifest.ts';

// ustar header fields: where each starts, and how many octal digits the numeric ones hold (before their NUL)
const TAR_BLOCK = 512;
const TAR_NAME_LENGTH = 100;
const TAR_MODE = 100;
const TAR_UID = 108;
const TAR_GID = 116;
const TAR_SIZE = 124;
const TAR_MTIME = 136;
const TAR_CHECKSUM = 148;
const TAR_TYPEFLAG = 156;
const TAR_LINKNAME = 157;
const TAR_MAGIC = 257;
const TAR_VERSION = 263;
const TAR_MODE_DIGITS = 7;
const TAR_SIZE_DIGITS = 11;
const TAR_CHECKSUM_DIGITS = 6;
const OCTAL = 8;
/** An archive ends with two zero blocks. */
const TAR_END = TAR_BLOCK + TAR_BLOCK;
const DEFAULT_FILE_MODE = 0o644;

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
/** GitHub's page size when a request doesn't say. */
const GITHUB_DEFAULT_PER_PAGE = 30;
const SHA256_HEX_LENGTH = 64;

/** A minimal ustar writer, so tests can make the archives they need (including hostile ones). */
export function tarGz(
  input: {
    name: string;
    data?: string;
    type?: 'file' | 'dir' | 'symlink' | 'hardlink' | 'longname' | 'pax';
    link?: string;
    mode?: number;
  }[],
): Buffer {
  const blocks: Buffer[] = [];
  // a name over 100 bytes goes first as a GNU long-name record, as GNU tar writes it
  const entries = input.flatMap((e) =>
    e.name.length > TAR_NAME_LENGTH
      ? [
          { name: '././@LongLink', data: `${e.name}\0`, type: 'longname' as const },
          { ...e, name: e.name.slice(0, TAR_NAME_LENGTH) },
        ]
      : [e],
  );
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const h = Buffer.alloc(TAR_BLOCK);
    h.write(e.name, 0, TAR_NAME_LENGTH);
    h.write(
      `${(e.mode ?? DEFAULT_FILE_MODE).toString(OCTAL).padStart(TAR_MODE_DIGITS, '0')}\0`,
      TAR_MODE,
    );
    h.write('0000000\0', TAR_UID);
    h.write('0000000\0', TAR_GID);
    const sized = !e.type || e.type === 'file' || e.type === 'longname' || e.type === 'pax';
    h.write(
      `${(sized ? data.length : 0).toString(OCTAL).padStart(TAR_SIZE_DIGITS, '0')}\0`,
      TAR_SIZE,
    );
    h.write('00000000000\0', TAR_MTIME);
    h.write('        ', TAR_CHECKSUM);
    h.write(
      { dir: '5', symlink: '2', hardlink: '1', longname: 'L', pax: 'x', file: '0' }[
        e.type ?? 'file'
      ],
      TAR_TYPEFLAG,
    );
    if (e.link) {
      h.write(e.link, TAR_LINKNAME, TAR_NAME_LENGTH);
    }
    h.write('ustar\0', TAR_MAGIC);
    h.write('00', TAR_VERSION);
    let sum = 0;
    for (const b of h) {
      sum += b;
    }
    h.write(`${sum.toString(OCTAL).padStart(TAR_CHECKSUM_DIGITS, '0')}\0 `, TAR_CHECKSUM);
    blocks.push(h);
    if (sized) {
      blocks.push(data, Buffer.alloc((TAR_BLOCK - (data.length % TAR_BLOCK)) % TAR_BLOCK));
    }
  }
  blocks.push(Buffer.alloc(TAR_END));
  return gzipSync(Buffer.concat(blocks));
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

interface FakeRelease {
  tag: string;
  draft?: boolean;
  prerelease?: boolean;
  files: Record<string, Buffer>;
}
export interface FakeTarget extends Partial<Omit<ManifestTarget, 'assets'>> {
  name: string;
  platform: string;
  runtime?: Buffer;
  dev?: Buffer;
}

export interface FakeGitHub {
  releases: FakeRelease[];
  seenAuth: (string | undefined)[];
  /** Each request's path and whether it carried a token. */
  requests: { path: string; auth: boolean }[];
  base: string;
  env: Record<string, string>;
  /** What GET /repos/o/r says about visibility. */
  private: boolean;
  /** Faults to inject, each used once by the first request whose path it matches: a status, or 'hang' (no answer). */
  faults: { path: RegExp; status: number | 'hang' }[];
  /** Publishes a release whose manifest lists the targets (their archives are made up unless given). */
  publish: (
    tag: string,
    targets: FakeTarget[],
    extra?: Partial<FakeRelease> & { engine?: string },
  ) => Manifest;
  close: () => Promise<void>;
}

const defaultRuntime = (): Buffer => tarGz([{ name: 'bin/ffmpeg', data: 'ffmpeg', mode: 0o755 }]);

/** Starts the fake and points FFMPEG_BUILD_GITHUB_API at it (close() undoes that). */
export async function fakeGitHub(): Promise<FakeGitHub> {
  const server: Server = createServer();
  const fake: FakeGitHub = {
    releases: [],
    seenAuth: [],
    requests: [],
    // both filled in once the server has its port
    base: '',
    env: {},
    private: false,
    faults: [],
    publish(tag, targets, extra = {}) {
      const t = /^(?:(.+)-)?(\d+\.\d+(?:\.\d+)?)\.(\d+)$/.exec(tag)!;
      const ffmpeg = t[2]!;
      const files: Record<string, Buffer> = {};
      const { engine, ...rest } = extra;
      const manifest: Manifest = {
        release: tag,
        ffmpeg,
        build: t[3]!,
        engine: engine ?? '0.2.0',
        ...(t[1] ? { group: t[1] } : {}),
        targets: targets.map(({ runtime, dev, ...x }) => {
          const runtimeData = runtime ?? defaultRuntime();
          const devData = dev ?? tarGz([{ name: 'include/libavutil/avutil.h', data: 'h' }]);
          const names = {
            runtime: `ffmpeg-${ffmpeg}-${x.name}.tar.gz`,
            dev: `ffmpeg-${ffmpeg}-${x.name}-dev.tar.gz`,
          };
          files[names.runtime] = runtimeData;
          files[names.dev] = devData;
          return {
            license: 'lgplv3',
            redistributable: 'true',
            toolchain: 'abc',
            components: { dav1d: '1.5.4' },
            patches: [],
            'not-included': [],
            definition: 'def',
            ...x,
            pins: x.pins ?? {},
            assets: {
              runtime: { name: names.runtime, sha256: sha(runtimeData) },
              dev: { name: names.dev, sha256: sha(devData) },
            },
          };
        }),
        sources: { name: `ffmpeg-${ffmpeg}-sources.tar.gz`, sha256: '0'.repeat(SHA256_HEX_LENGTH) },
      };
      files['manifest.yml'] = Buffer.from(formatManifest(manifest));
      fake.releases.push({ tag, files, ...rest });
      return manifest;
    },
    async close() {
      delete process.env['FFMPEG_BUILD_GITHUB_API'];
      server.closeAllConnections();
      await new Promise<void>((r) => {
        server.close(() => {
          r();
        });
      });
    },
  };
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    fake.seenAuth.push(req.headers.authorization);
    const url = new URL(req.url!, 'http://x');
    fake.requests.push({ path: url.pathname, auth: req.headers.authorization !== undefined });
    const fault = fake.faults.findIndex((f) => f.path.test(url.pathname));
    if (fault !== -1) {
      const [f] = fake.faults.splice(fault, 1);
      if (f!.status === 'hang') {
        return;
      }
      res.writeHead(f!.status, { 'content-type': 'application/json' });
      res.end('{"message":"injected"}');
      return;
    }
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const asJson = (r: FakeRelease): object => ({
      tag_name: r.tag,
      draft: r.draft ?? false,
      prerelease: r.prerelease ?? false,
      assets: Object.keys(r.files).map((name) => ({
        name,
        url: `${fake.base}/assets/${encodeURIComponent(r.tag)}/${encodeURIComponent(name)}`,
      })),
    });
    if (url.pathname === '/repos/o/r') {
      send(HTTP_OK, { full_name: 'o/r', private: fake.private });
      return;
    }
    let m = /^\/repos\/o\/r\/releases\/tags\/(.+)$/.exec(url.pathname);
    if (m) {
      const tag = decodeURIComponent(m[1]!);
      const r = fake.releases.find((x) => x.tag === tag);
      if (r) {
        send(HTTP_OK, asJson(r));
      } else {
        send(HTTP_NOT_FOUND, { message: 'Not Found' });
      }
      return;
    }
    if (url.pathname === '/repos/o/r/releases') {
      const page = Number(url.searchParams.get('page') ?? 1);
      const per = Number(url.searchParams.get('per_page') ?? GITHUB_DEFAULT_PER_PAGE);
      send(HTTP_OK, fake.releases.slice((page - 1) * per, page * per).map(asJson));
      return;
    }
    m = /^\/assets\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (m) {
      const tag = decodeURIComponent(m[1]!);
      const file = fake.releases.find((x) => x.tag === tag)?.files[decodeURIComponent(m[2]!)];
      if (!file) {
        send(HTTP_NOT_FOUND, {});
        return;
      }
      res.writeHead(HTTP_OK, { 'content-type': 'application/octet-stream' });
      res.end(file);
      return;
    }
    send(HTTP_NOT_FOUND, {});
  });
  await listenLocal(server);
  fake.base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
  fake.env = { FFMPEG_BUILD_GITHUB_API: fake.base };
  process.env['FFMPEG_BUILD_GITHUB_API'] = fake.base;
  return fake;
}
