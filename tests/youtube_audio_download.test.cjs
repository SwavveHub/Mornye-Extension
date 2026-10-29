const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../sources/ytmusic-spotiflac/index.js'), 'utf8');

// The app URL exposes a read-only query; only URLSearchParams is mutable.
class RuntimeURL {
  constructor(input, base) {
    const parsed = new URL(input, base);
    for (const key of ['href', 'protocol', 'host', 'hostname', 'pathname', 'search', 'hash']) {
      this[key] = parsed[key];
    }
    this.searchParams = Object.fromEntries(['get', 'getAll', 'has', 'toString'].map(
      key => [key, parsed.searchParams[key].bind(parsed.searchParams)],
    ));
    this.toString = () => parsed.href;
  }
}

function runtime() {
  let extension;
  const calls = { downloads: [], players: [], warnings: [] };
  const c = vm.createContext({
    URL: RuntimeURL, URLSearchParams,
    registerExtension(value) { extension = value; },
    log: { info() {}, debug() {}, error() {}, warn(...args) { calls.warnings.push(args); } },
    utils: { isDownloadCancelled: () => false, sleep() {} },
    storage: { get() {}, set() {} },
    file: {
      download(url, output) {
        calls.downloads.push({ url, output });
        return { success: true, path: output };
      },
    },
    fetch() { throw new Error('Unexpected network request'); },
  });
  vm.runInContext(source, c);
  return { c, calls, extension };
}

const audio = (itag, codec, extra = {}) => ({
  itag,
  mimeType: codec === 'opus' ? 'audio/webm; codecs="opus"' : 'audio/mp4; codecs="mp4a.40.2"',
  url: `https://media.example.test/audio?itag=${itag}`,
  bitrate: 128000,
  ...extra,
});

test('token query updates work with the app URL contract', () => {
  const { c } = runtime();
  const result = new URL(c.updateUrlQuery(
    'https://media.example.test/audio?existing=a%2Bb&pot=old#part',
    { pot: 'fresh_token', empty: '', absent: null },
  ));
  assert.equal(result.searchParams.get('pot'), 'fresh_token');
  assert.equal(result.searchParams.get('existing'), 'a+b');
  assert.equal(result.hash, '#part');
  assert.equal(result.searchParams.has('empty'), false);
});

test('challenge-dependent formats are skipped without downloading player code', () => {
  const { c } = runtime();
  const requests = [];
  c.fetch = url => {
    requests.push(url);
    throw new Error('Player code must never be requested');
  };
  const cipher = new URLSearchParams({
    url: 'https://media.example.test/audio?keep=a%2Bb&n=old_n',
    s: 'encrypted', sp: 'sig',
  });
  for (const player of ['https://www.youtube.com/s/player/test/base.js', 'http://unrelated.test/base.js']) {
    assert.equal(c.buildYouTubeFormatURL({ signatureCipher: cipher.toString() }, player), '');
    assert.equal(c.buildYouTubeFormatURL({ url: 'https://media.example.test/audio?n=challenge' }, player), '');
  }
  assert.deepEqual(requests, []);
});

test('unsigned cipher URLs are never used', () => {
  const { c } = runtime();
  const cipher = new URLSearchParams({ url: 'https://media.example.test/audio', s: 'encrypted' });
  assert.equal(c.buildYouTubeFormatURL({ signatureCipher: cipher.toString() }, 'player'), '');
});

test('a broken signature on the first format does not discard other Opus audio', () => {
  const { c } = runtime();
  const broken = audio(251, 'opus', { url: '', signatureCipher: 's=encrypted&url=https%3A%2F%2Fmedia.example.test%2Fbroken' });
  c.fetch = () => ({ ok: true, json: () => ({
    playabilityStatus: { status: 'OK' },
    streamingData: { adaptiveFormats: [broken, audio(250, 'opus'), audio(140, 'aac')] },
  }) });
  const result = c._tryInnerTubeClient('test-video', c.INNERTUBE_CLIENTS[0], {});
  assert.equal(result.itag, 250);
  assert.equal(result.extension, '.opus');
});

test('the download falls back when all direct formats require player challenges', () => {
  const { c, calls, extension } = runtime();
  const watchURL = vm.runInContext('CONFIG.youtubeWatchURL', c);
  c.INNERTUBE_CLIENTS = [c.INNERTUBE_CLIENTS[0]];
  const requests = [];
  c.fetch = (url, options) => {
    requests.push(url);
    if (url === watchURL + 'abcdefghijk') {
      return { ok: true, text: () => '{"jsUrl":"https://unrelated.test/base.js"}' };
    }
    assert.equal(options.method, 'POST');
    assert.equal(new URL(url).origin, 'https://www.youtube.com');
    return { ok: true, json: () => ({
      playabilityStatus: { status: 'OK' },
      streamingData: { adaptiveFormats: [
        audio(251, 'opus', { url: '', signatureCipher: 's=encrypted&url=https%3A%2F%2Fmedia.example.test%2Faudio' }),
        audio(250, 'opus', { url: 'https://media.example.test/audio?n=challenge' }),
      ] },
    }) };
  };
  const fallbacks = [];
  c.requestCobaltAudioDownload = url => {
    fallbacks.push(url);
    return { url: 'https://media.example.test/fallback', extension: '.opus' };
  };
  const result = extension.download('abcdefghijk', 'opus', '/music/song.flac');
  assert.equal(result.success, true);
  assert.equal(result.audio_codec, 'opus');
  assert.deepEqual(fallbacks, ['https://music.youtube.com/watch?v=abcdefghijk']);
  assert.deepEqual(calls.downloads, [{ url: 'https://media.example.test/fallback', output: '/music/song.opus' }]);
  assert.equal(requests.length, 2, 'only the watch page and player API are fetched');
});

test('Opus from a later client wins over earlier AAC without downloading AAC', () => {
  const { c, calls } = runtime();
  c.INNERTUBE_CLIENTS = [{ name: 'first' }, { name: 'second' }];
  c._tryInnerTubeClient = (_, client) => {
    calls.players.push(client.name);
    const opus = client.name === 'second';
    return { clientName: client.name, itag: opus ? 251 : 140,
      extension: opus ? '.opus' : '.m4a', url: `https://media.example.test/${client.name}` };
  };
  const result = c.tryInnerTubeDownloadsLazily('id', {}, '/music/song.flac', '', '');
  assert.equal(result.audio_codec, 'opus');
  assert.deepEqual(calls.players, ['first', 'second']);
  assert.deepEqual(calls.downloads.map(d => d.output), ['/music/song.opus']);
});

test('failed Opus downloads can fall back to truthful AAC after trying all clients', () => {
  const { c, calls } = runtime();
  c.INNERTUBE_CLIENTS = [{ name: 'first' }, { name: 'second' }];
  c._tryInnerTubeClient = (_, client) => client.name === 'first'
    ? { clientName: 'first', itag: 251, extension: '.opus', url: 'https://media.example.test/opus' }
    : { clientName: 'second', itag: 140, extension: '.m4a', url: 'https://media.example.test/aac' };
  c.file.download = (url, output) => {
    calls.downloads.push({ url, output });
    return output.endsWith('.opus') ? { success: false, error: 'HTTP 403' } : { success: true, path: output };
  };
  const result = c.tryInnerTubeDownloadsLazily('id', {}, '/music/song.flac', '', '');
  assert.equal(result.audio_codec, 'aac');
  assert.equal(result.actual_extension, '.m4a');
  assert.deepEqual(calls.downloads.map(d => d.output), ['/music/song.opus', '/music/song.m4a']);
});

test('a single client retains AAC as fallback if its preferred Opus transfer fails', () => {
  const { c } = runtime();
  c.INNERTUBE_CLIENTS = [c.INNERTUBE_CLIENTS[0]];
  c.fetch = () => ({ ok: true, json: () => ({
    playabilityStatus: { status: 'OK' },
    streamingData: { adaptiveFormats: [audio(251, 'opus'), audio(140, 'aac')] },
  }) });
  c.file.download = (url, output) => output.endsWith('.opus')
    ? { success: false, error: 'HTTP 403' }
    : { success: true, path: output };
  const result = c.tryInnerTubeDownloadsLazily('id', {}, '/music/song.flac', '', '');
  assert.equal(result.audio_codec, 'aac');
});

test('new direct clients replace the broken Android VR first choice', () => {
  const { c } = runtime();
  assert.equal(c.INNERTUBE_CLIENTS[0].name, 'tv_samsung');
  assert.ok(c.INNERTUBE_CLIENTS.some(client => client.name === 'web_embedded'));
  assert.ok(!c.INNERTUBE_CLIENTS.some(client => client.name === 'android_vr'));
});

test('video-only streams are never offered as Opus audio', () => {
  const { c } = runtime();
  const formats = [{ itag: 248, mimeType: 'video/webm; codecs="vp9"', url: 'https://media.example.test/video' }];
  assert.equal(c.chooseYouTubeFormat(formats, {}, false), null);
});

test('first working Opus skips the remaining client requests', () => {
  const { c, calls } = runtime();
  c.INNERTUBE_CLIENTS = [{ name: 'first' }, { name: 'unused' }];
  c._tryInnerTubeClient = (_, client) => {
    calls.players.push(client.name);
    return { clientName: client.name, itag: 251, extension: '.opus', url: 'https://media.example.test/opus' };
  };
  assert.equal(c.tryInnerTubeDownloadsLazily('id', {}, '/music/song.flac', '', '').audio_codec, 'opus');
  assert.deepEqual(calls.players, ['first']);
});

test('a client timeout does not skip a later working Opus source', () => {
  const { c } = runtime();
  c.INNERTUBE_CLIENTS = [{ name: 'timeout' }, { name: 'working' }];
  c._tryInnerTubeClient = (_, client) => {
    if (client.name === 'timeout') throw new Error('request timed out');
    return { clientName: client.name, itag: 251, extension: '.opus', url: 'https://media.example.test/opus' };
  };
  assert.equal(c.tryInnerTubeDownloadsLazily('id', {}, '/music/song.flac', '', '').audio_codec, 'opus');
});

test('PO token refresh is inserted into the real media URL and can recover 403', () => {
  const { c, calls } = runtime();
  c.INNERTUBE_CLIENTS = [{ ...c.INNERTUBE_CLIENTS[0], requiresGvsPoToken: true }];
  c.getGvsPoToken = (_, __, ___, bypass) => bypass ? 'new_token' : 'old_token';
  c.fetch = () => ({ ok: true, json: () => ({
    playabilityStatus: { status: 'OK' },
    streamingData: { adaptiveFormats: [audio(251, 'opus')] },
  }) });
  c.file.download = (url, output) => {
    calls.downloads.push(url);
    return new URL(url).searchParams.get('pot') === 'new_token'
      ? { success: true, path: output } : { success: false, error: 'HTTP 403' };
  };
  assert.equal(c.tryInnerTubeDownloadsLazily('id', {}, '/music/song.flac', '', '').audio_codec, 'opus');
  assert.deepEqual(calls.downloads.map(url => new URL(url).searchParams.get('pot')), ['old_token', 'new_token']);
});

test('JS clients read the timestamp as page data without fetching or executing player code', () => {
  const { c } = runtime();
  const watchURL = vm.runInContext('CONFIG.youtubeWatchURL', c);
  let pages = 0;
  let requests = 0;
  const privilegedCalls = [];
  c.storage.set = () => privilegedCalls.push('storage');
  c.file.delete = () => privilegedCalls.push('file');
  c.fetch = (url, options) => {
    if (url === watchURL + 'id') {
      pages++;
      return { ok: true, text: () => '{"signatureTimestamp":20849,"jsUrl":"http://unrelated.test/base.js"}' };
    }
    assert.equal(options.method, 'POST', 'never GET a player script, including on an allowed origin');
    assert.equal(new URL(url).origin, 'https://www.youtube.com');
    requests++;
    assert.equal(JSON.parse(options.body).playbackContext.contentPlaybackContext.signatureTimestamp, 20849);
    return { ok: true, json: () => ({
      playabilityStatus: { status: 'OK' },
      streamingData: { adaptiveFormats: [audio(251, 'opus')] },
    }) };
  };
  const page = c.getYouTubePageInfo('id');
  for (const client of c.INNERTUBE_CLIENTS.filter(client => client.requiresJsPlayer)) {
    assert.equal(c._tryInnerTubeClient('id', client, page).extension, '.opus');
  }
  assert.equal(pages, 1);
  assert.equal(requests, 2);
  assert.deepEqual(privilegedCalls, []);
});
