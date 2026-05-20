import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getMediaBrowserRoots,
  listMediaBrowserDirectory,
  MediaBrowserError,
  resolveMediaBrowserPath,
} from '../media/browser';

describe('media browser', () => {
  let tempDir: string;
  let basePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daawah-media-browser-'));
    basePath = path.join(tempDir, 'media');
    fs.mkdirSync(path.join(basePath, 'original-ar'), { recursive: true });
    fs.mkdirSync(path.join(basePath, 'bumpers'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function browserOptions() {
    return {
      basePath,
      allowedRoots: ['original-ar', 'bumpers'],
      includeConfiguredRoots: false,
      statsFileLimit: 100,
    };
  }

  it('only exposes roots under the configured media base path', () => {
    const outsidePath = path.join(tempDir, 'outside');
    fs.mkdirSync(outsidePath);

    const roots = getMediaBrowserRoots({
      basePath,
      allowedRoots: ['original-ar', outsidePath],
      includeConfiguredRoots: false,
      statsFileLimit: 100,
    });

    expect(roots).toHaveLength(1);
    expect(roots[0]?.relativePath).toBe('original-ar');
  });

  it('rejects path traversal out of an allowed root', () => {
    const root = getMediaBrowserRoots(browserOptions())[0];
    expect(root).toBeDefined();

    expect(() => resolveMediaBrowserPath(root!.id, '../../etc', browserOptions()))
      .toThrow(MediaBrowserError);
  });

  it('lists directory stats and keeps directories visible with the mp4 filter', () => {
    const folder = path.join(basePath, 'original-ar', 'series-a');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'a.mp4'), 'video');
    fs.writeFileSync(path.join(folder, 'b.mp4'), 'video');
    fs.writeFileSync(path.join(folder, 'c.mkv'), 'video');

    const root = getMediaBrowserRoots(browserOptions()).find(item => item.relativePath === 'original-ar');
    expect(root).toBeDefined();

    const result = listMediaBrowserDirectory({
      rootId: root!.id,
      mp4Only: true,
      options: browserOptions(),
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.name).toBe('series-a');
    expect(result.entries[0]?.fileCount).toBe(3);
    expect(result.entries[0]?.mp4Count).toBe(2);
  });

  it('supports Arabic filename search with normalized taa marbuta', () => {
    const rootDir = path.join(basePath, 'original-ar');
    fs.writeFileSync(path.join(rootDir, 'الحلقة الأولى.mp4'), 'video');
    fs.writeFileSync(path.join(rootDir, 'محاضرة.mkv'), 'video');

    const root = getMediaBrowserRoots(browserOptions()).find(item => item.relativePath === 'original-ar');
    expect(root).toBeDefined();

    const result = listMediaBrowserDirectory({
      rootId: root!.id,
      search: 'الحلقه',
      mp4Only: true,
      options: browserOptions(),
    });

    expect(result.entries.map(entry => entry.name)).toEqual(['الحلقة الأولى.mp4']);
  });

  it('hides non-mp4 files when mp4Only is enabled', () => {
    const rootDir = path.join(basePath, 'original-ar');
    fs.writeFileSync(path.join(rootDir, 'ready.mp4'), 'video');
    fs.writeFileSync(path.join(rootDir, 'archive.mov'), 'video');

    const root = getMediaBrowserRoots(browserOptions()).find(item => item.relativePath === 'original-ar');
    expect(root).toBeDefined();

    const result = listMediaBrowserDirectory({
      rootId: root!.id,
      mp4Only: true,
      options: browserOptions(),
    });

    expect(result.entries.map(entry => entry.name)).toEqual(['ready.mp4']);
  });
});
