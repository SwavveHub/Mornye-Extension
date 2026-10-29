const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../sources/ytmusic-spotiflac/index.js'), 'utf8');
const track = { id: 'abcdefghijk', item_type: 'track', title: 'Signal', artist: 'Example Artist', duration: 180 };

function runtime(results) {
  let extension;
  const c = vm.createContext({
    registerExtension(value) { extension = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
  });
  vm.runInContext(source, c);
  c.performSearchSync = () => results;
  return extension;
}

test('availability skips unrelated recordings and selects the matching track', () => {
  const app = runtime([{ ...track, id: 'wrongartist', artist: 'Someone Else' }, track]);
  assert.equal(app.checkAvailability('', 'Signal', 'Example Artist', { duration_ms: 180000 }).track_id, track.id);
});

for (const [label, candidate] of [
  ['album', { ...track, item_type: 'album' }],
  ['conflicting type', { ...track, item_type: 'album', type: 'track' }],
  ['other title', { ...track, title: 'Other Song' }],
  ['other version', { ...track, title: 'Signal (Live)' }],
  ['other artist', { ...track, artist: 'Other Artist' }],
  ['other duration', { ...track, duration: 210 }],
  ['unknown duration', { ...track, duration: 0 }],
  ['invalid video ID', { ...track, id: 'album-id' }],
]) {
  test(`availability rejects ${label} even with a video-shaped spotify_id`, () => {
    const result = runtime([candidate]).checkAvailability('', 'Signal', 'Example Artist', {
      duration_ms: 180000, spotify_id: track.id,
    });
    assert.equal(result.available, false);
  });
}

test('matching tolerates case, punctuation, featured credits and five seconds of rounding', () => {
  const app = runtime([{ ...track, title: 'SIGNAL!', artist: 'Example Artist, Guest', duration: 185 }]);
  assert.equal(app.checkAvailability('', 'Signal', 'example artist feat. Guest', { duration_ms: 180000 }).available, true);
});

test('duration checks accept milliseconds and are optional when the request has no duration', () => {
  const app = runtime([{ ...track, duration: undefined, duration_ms: 180000 }]);
  assert.equal(app.checkAvailability('', 'Signal', 'Example Artist', { duration_ms: 180000 }).available, true);
  assert.equal(app.checkAvailability('', 'Signal', 'Example Artist').available, true);
});

test('Unicode recording names match without collapsing unrelated names to empty strings', () => {
  const candidate = { ...track, title: '夜に駆ける', artist: 'ヨアソビ' };
  const app = runtime([candidate]);
  assert.equal(app.checkAvailability('', candidate.title, candidate.artist).available, true);
  assert.equal(app.checkAvailability('', '別の曲', candidate.artist).available, false);
  assert.equal(app.checkAvailability('', candidate.title, '別の歌手').available, false);
});

test('availability requires both a title and an artist', () => {
  const app = runtime([track]);
  for (const [title, artist] of [['', 'Example Artist'], ['Signal', ''], ['', '']]) {
    assert.equal(app.checkAvailability('', title, artist, { spotify_id: track.id }).available, false);
  }
});
