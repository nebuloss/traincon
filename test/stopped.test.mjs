// A train that is standing still still has to be drawn correctly.
//
// Everything that puts a train where it belongs — snapping it onto the rails
// the tiles actually show, holding the view on it, laying its vehicles along
// the track — ran inside the animation loop. The loop declines to start when
// the train is not moving, because there is nothing to advance:
//
//     if (!this.track || !kmh || this.stopKm.length < 2) { ... return; }
//
// So a stopped train kept whatever the first draw produced, and the first draw
// is the worst moment to produce it: the framing zoom has not taken effect and
// the tiles under the new position have not loaded, so no track is found and
// no line is chosen. The carriages stayed on the route line — which at a
// station is the stub joining the platform to the network — and the view
// stayed on the server's position, which the marker had since been snapped
// away from. Reported on 7856 standing at Cannes.
//
// MapView needs a browser, MapLibre and the bundler's asset handling, so this
// reads the source, as the other map tests do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = await readFile(path.join(ROOT, 'src/components/MapView.ts'), 'utf8');

test('the loop still declines to run for a train that is not moving', () => {
  // The premise of everything below. If this ever changes, the compensation
  // is unnecessary rather than wrong — but it should be a deliberate change.
  assert.match(
    src,
    /if \(!this\.track \|\| !kmh \|\| this\.stopKm\.length < 2\)/,
    'startDeadReckoning returns early for a stopped train',
  );
});

test('one pass places the train, and it is a method both paths can call', () => {
  // Extracted rather than duplicated: the loop and the stopped case must not
  // drift into placing a train two different ways.
  assert.match(src, /private settle\(t: TrainDTO\): void \{/, 'settle exists');

  const body = src.slice(src.indexOf('private settle('));
  const end = body.indexOf('\n  }\n');
  const settle = body.slice(0, end);

  assert.match(settle, /onSurveyedTrack\(/, 'it snaps onto the surveyed rails');
  assert.match(settle, /this\.marker\.setLngLat\(/, 'it moves the marker there');
  assert.match(settle, /this\.centreOnTrain\(/, 'it holds the view on the train');
  assert.match(settle, /this\.drawBody\(/, 'it lays the vehicles out');
});

test('a train with no loop is placed when it is drawn', () => {
  assert.match(
    src,
    /this\.startDeadReckoning\(t\);\s*\n(?:\s*\/\/.*\n)*\s*if \(!this\.animating\) this\.settle\(t\);/,
    'show() settles the train when the loop declined to start',
  );
});

test('and again once the tiles it needs have arrived', () => {
  // The first placement happens before the map is idle, so there is nothing
  // to snap to however many times it is asked. Idle is the moment there is.
  const idle = src.slice(src.indexOf("this.map.on('idle'"));
  assert.ok(idle.startsWith("this.map.on('idle'"), 'an idle handler exists');
  const handler = idle.slice(0, idle.indexOf('});'));
  assert.match(handler, /!this\.animating/, 'it leaves a running loop alone');
  assert.match(handler, /this\.settle\(/, 'it places the train again');
});

test('the carriages are only snapped when a line was actually chosen', () => {
  // The bug's mechanism: chosenLine is set by onSurveyedTrack, and when it is
  // null every vehicle keeps the route position it was laid out at. That is
  // correct — inventing a line would be worse — which is why the fix is to
  // make sure onSurveyedTrack runs, not to snap regardless.
  assert.match(src, /const line = this\.chosenLine;\s*\n\s*if \(line\) \{/,
    'no chosen line means no snapping');
  assert.match(src, /this\.chosenLine = /, 'and onSurveyedTrack is what sets it');
});
