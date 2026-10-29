const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../sources/soundcloud/index.js'), 'utf8');
function runtime() {
  let extension;
  const requests = [];
  const resolved = [];
  const c = vm.createContext({
    registerExtension(value) { extension = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    utils: { randomUserAgent: () => 'Test' },
    http: { get(url) { requests.push(url); throw new Error('Unexpected HTTP request'); } },
  });
  vm.runInContext(source, c);
  c.scResolve = url => { resolved.push(url); return null; };
  return { c, extension, requests, resolved };
}

test('unrelated or non-HTTPS URLs never reach HTTP or the resolve API', () => {
  for (const url of [
    'https://unrelated.test/on.soundcloud.com/token',
    'https://on.soundcloud.com.unrelated.test/token',
    'https://unrelated.test/?next=https://soundcloud.com/artist/song',
    'https://soundcloud.com@unrelated.test/artist/song',
    'https://user:pass@soundcloud.com/artist/song',
    'https://soundcloud.com:8443/artist/song',
    'https://soundcloud.com\\@unrelated.test/artist/song',
    'https://soundcloud.com./artist/song',
    'http://soundcloud.com/artist/song',
    '//soundcloud.com/artist/song',
    'file:///soundcloud.com/artist/song',
    'https://soundcloud.com/artist/\nsong',
  ]) {
    const { c, extension, requests, resolved } = runtime();
    assert.equal(c.parseSoundCloudURL(url), null, url);
    assert.equal(extension.handleUrl(url).success, false, url);
    assert.deepEqual(requests, []);
    assert.deepEqual(resolved, []);
  }
});

test('short links fail closed before the native HTTP client can follow redirects', () => {
  for (const url of ['https://on.soundcloud.com/token', 'https://on.soundcloud.com',
    'https://on.soundcloud.com?token=test', 'https://on.soundcloud.com#token']) {
    const { extension, requests, resolved } = runtime();
    const result = extension.handleUrl(url);
    assert.equal(result.success, false);
    assert.match(result.error, /full.*soundcloud\.com/i);
    assert.deepEqual(requests, []);
    assert.deepEqual(resolved, []);
  }
});

test('canonical and mobile HTTPS imports keep resolving through the SoundCloud API', () => {
  for (const [url, type, expected] of [
    ['https://soundcloud.com/artist/song', 'track', 'https://soundcloud.com/artist/song'],
    ['https://m.soundcloud.com/artist/song?share=1', 'track', 'https://soundcloud.com/artist/song'],
    ['https://soundcloud.com/artist/sets/collection', 'playlist', 'https://soundcloud.com/artist/sets/collection'],
    ['https://soundcloud.com/artist', 'user', 'https://soundcloud.com/artist'],
    ['HTTPS://SOUNDCLOUD.COM/artist/song', 'track', 'https://soundcloud.com/artist/song'],
  ]) {
    const { c, extension, requests, resolved } = runtime();
    const parsed = c.parseSoundCloudURL(url);
    assert.equal(parsed.type, type);
    assert.equal(parsed.permalink_url, expected);
    extension.handleUrl(url);
    assert.deepEqual(resolved, [expected]);
    assert.deepEqual(requests, []);
  }
});
